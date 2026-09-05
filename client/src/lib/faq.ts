import { supabase } from './supabaseClient';
import { todayJstStr } from './breakCalc';

// FAQ（よくある質問）の読み書きと検索。
//
// 【この機能の芯】
// ・AIに文章を作らせない。管理者が確認した「回答の原文」だけを表示する。
// ・同じ質問でも、校・コース（社外向け）や役職（社内向け）で答えが変わる。
//   共通の回答を1つ持ち、違うところだけ「対象を指定した回答」で上書きする。
//   → 11コースで同じ文章を11回コピーしない＝片方だけ直して食い違う事故を防ぐ
// ・回答は「いつから・いつまで」を持つ。料金改定などを予約でき、当日の作業が要らない。
//
// 🚨 表示してよい回答の最終判断はDB側（RLS）が行う。この画面側の絞り込みは
//    「今日どれを見せるか」を決めるためのもので、権限の代わりではない。

export type FaqAudience = 'internal' | 'public';

// 校・コースの一覧。管理画面（FaqTab）とお客様向けウィジェットの両方がここを使う。
// 🚨 2か所に別々に書くと、コース追加のとき片方だけ直して食い違うため必ずここに集約する
export const FAQ_SCHOOL_OPTIONS = ['四条本校', '西陣校', '上桂校', '洛西口校', '南草津校'];
export const FAQ_COURSE_OPTIONS = [
  'こども器械体操', 'マットレ', 'ジュニア姿勢・体幹トレーニング',
  'ウェルネス体操', 'ウェルネス体操プライベート', 'こども器械体操プライベート',
  '上級', '養成',
];

/**
 * コースを実施している校（2026-08-29 ユーザー確認）。
 * ここに書いたコースは、その校を選んだ人にだけ選択肢として出す。
 *
 * 🚨 ここに書かないコースは全校で出す。実施校が確定しているものだけ書くこと。
 *    推測で足すと、実際に通っている方が自分のコースを選べなくなる
 *    （回答が1つも無い質問は一覧から消えるため、質問ごと見えなくなる）。
 *
 * 🚨 これは「その質問が対象にしている校・コース」で絞るのとは別物なので混同しない。
 *    質問ごとに絞ると、共通回答に落ちるべき人（例：欠席・振替のこども器械体操）が
 *    自分を選べなくなる。こちらは「その校に無いコース」という校の実態で絞っている。
 *
 * 例：洛西口校ではウェルネス体操プライベートを実施していないのに選択肢に出ており、
 *     選ぶとキャンセル料の案内まで表示されていた（2026-08-29 に修正）。
 */
export const FAQ_COURSE_SCHOOLS: Record<string, string[]> = {
  'マットレ': ['四条本校'],
  'ジュニア姿勢・体幹トレーニング': ['四条本校', '洛西口校'],
  'ウェルネス体操': ['四条本校', '洛西口校'],
  'ウェルネス体操プライベート': ['四条本校'],
  '上級': ['上桂校'],
  '養成': ['上桂校'],
  // こども器械体操／こども器械体操プライベートは全5校のため書かない
};

/**
 * その校で選べるコースだけを返す。
 * 校が未選択のとき（校を聞かない質問・「この中にない・わからない」を選んだとき）は
 * 全部返す＝逃げ道を塞がない。
 */
export function faqCourseOptionsForSchool(school: string | null | undefined): string[] {
  if (!school) return FAQ_COURSE_OPTIONS;
  return FAQ_COURSE_OPTIONS.filter(course => {
    const schools = FAQ_COURSE_SCHOOLS[course];
    return !schools || schools.includes(school);
  });
}

export interface FaqAnswerTarget {
  id: string;
  answer_id: string;
  school: string | null;
  course: string | null;
  role_title: string | null;
}

export interface FaqAnswer {
  id: string;
  topic_id: string;
  body: string;
  source_label: string | null;
  source_url: string | null;
  /** この日から出す。null＝いつから出すか未定の下書き（＝まだ出さない） */
  valid_from: string | null;
  /** この日まで出す。null＝無期限 */
  valid_until: string | null;
  needs_refresh: boolean;
  refresh_note: string | null;
  updated_at: string;
  updated_by_name: string | null;
  targets: FaqAnswerTarget[];
}

/** 「違う場合はこちら」のボタン1つ分。label が null なら参照先の質問文を出す */
export interface FaqRelation {
  topic_id: string;
  label: string | null;
}

export interface FaqTopic {
  id: string;
  audience: FaqAudience;
  category: string;
  question: string;
  keywords: string[];
  is_published: boolean;
  is_featured: boolean;
  needs_review: boolean;
  review_note: string | null;
  sort_order: number;
  updated_at: string;
  updated_by_name: string | null;
  answers: FaqAnswer[];
  /** 関連質問（取り違えたときの復帰ボタン）。参照先が削除されるとDB側で自動的に消える */
  related: FaqRelation[];
}

/** 回答を選ぶときの条件。社外向けは校・コース、社内向けは役職を使う */
export interface FaqViewer {
  school?: string | null;
  course?: string | null;
  roleTitle?: string | null;
}

const TOPIC_COLS =
  'id, audience, category, question, keywords, is_published, is_featured, needs_review, review_note, sort_order, updated_at, updated_by_name';
const ANSWER_COLS =
  'id, topic_id, body, source_label, source_url, valid_from, valid_until, needs_refresh, refresh_note, updated_at, updated_by_name';

// ============================================================
// 取得
// ============================================================

/**
 * 質問と回答をまとめて取得する。
 * 未公開・予約中のものが返ってくるかはRLSが決めるので、ここでは絞らない
 * （編集者には全部返り、一般の利用者には公開中・有効期間内のものだけが返る）。
 */
export const fetchFaqTopics = async (audience: FaqAudience): Promise<FaqTopic[]> => {
  const { data: topics, error } = await supabase
    .from('faq_topics')
    .select(TOPIC_COLS)
    .eq('audience', audience)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error || !topics || topics.length === 0) return [];

  const ids = topics.map(t => t.id);
  const [{ data: answers }, { data: relations }] = await Promise.all([
    supabase.from('faq_answers').select(ANSWER_COLS).in('topic_id', ids),
    supabase.from('faq_topic_relations').select('topic_id, related_topic_id, label, sort_order').in('topic_id', ids).order('sort_order'),
  ]);
  const answerIds = (answers ?? []).map(a => a.id);

  // 対象（校・コース・役職）は別テーブル。回答が0件なら問い合わせない
  let targets: FaqAnswerTarget[] = [];
  if (answerIds.length > 0) {
    const { data } = await supabase
      .from('faq_answer_targets')
      .select('id, answer_id, school, course, role_title')
      .in('answer_id', answerIds);
    targets = (data ?? []) as FaqAnswerTarget[];
  }

  const targetsByAnswer = new Map<string, FaqAnswerTarget[]>();
  targets.forEach(t => {
    const list = targetsByAnswer.get(t.answer_id) ?? [];
    list.push(t);
    targetsByAnswer.set(t.answer_id, list);
  });

  const answersByTopic = new Map<string, FaqAnswer[]>();
  (answers ?? []).forEach(a => {
    const list = answersByTopic.get(a.topic_id) ?? [];
    list.push({ ...(a as Omit<FaqAnswer, 'targets'>), targets: targetsByAnswer.get(a.id) ?? [] });
    answersByTopic.set(a.topic_id, list);
  });

  const relatedByTopic = new Map<string, FaqRelation[]>();
  (relations ?? []).forEach(r => {
    const list = relatedByTopic.get(r.topic_id) ?? [];
    list.push({ topic_id: r.related_topic_id, label: r.label });
    relatedByTopic.set(r.topic_id, list);
  });

  return topics.map(t => ({
    ...(t as Omit<FaqTopic, 'answers' | 'related'>),
    answers: answersByTopic.get(t.id) ?? [],
    related: relatedByTopic.get(t.id) ?? [],
  }));
};

// ============================================================
// お客様向け（未ログイン）の取得
// ============================================================
// 🚨 未ログインではテーブルを1行も読めない（RLSが全て to authenticated のため）。
//    公開中・今日有効な社外向けQ&Aだけを返す RPC faq_public_data() が唯一の入口で、
//    下書き・予約中・社内向け・社内メモ（review_note / refresh_note）は
//    こちらに届く前にDB側で落ちている。
// 🚨 ここでは「取得の仕方」だけを変え、絞り込みと照合（resolveAnswer / matchFaqTopics）は
//    社内向けとまったく同じ関数を使う。片方だけ直して食い違う事故を避けるため。

/** RPCが返す形。テーブルの列そのままではなく、お客様に見せてよい分だけ */
interface PublicFaqAnswerRow {
  id: string;
  body: string;
  source_label: string | null;
  source_url: string | null;
  valid_from: string;
  targets: { school: string | null; course: string | null; role_title: string | null }[];
}
interface PublicFaqTopicRow {
  id: string;
  category: string;
  question: string;
  keywords: string[];
  is_featured: boolean;
  sort_order: number;
  answers: PublicFaqAnswerRow[];
  related: { topic_id: string; label: string | null }[];
}

/**
 * お客様向けQ&Aを取得する（未ログインから呼べる）。
 * 既存の照合・絞り込み関数をそのまま使えるよう FaqTopic の形に整える。
 */
export const fetchPublicFaqTopics = async (): Promise<FaqTopic[]> => {
  const { data, error } = await supabase.rpc('faq_public_data');
  if (error || !data) return [];

  return (data as PublicFaqTopicRow[]).map(t => ({
    id: t.id,
    category: t.category,
    question: t.question,
    keywords: t.keywords ?? [],
    is_featured: t.is_featured,
    sort_order: t.sort_order,
    answers: (t.answers ?? []).map(a => ({
      id: a.id,
      topic_id: t.id,
      body: a.body,
      source_label: a.source_label,
      source_url: a.source_url,
      valid_from: a.valid_from,
      // RPCは「今日有効なもの」だけを返すので、期限は既に判定済み。
      // ここで null を入れても isAnswerActiveOn の判定結果は変わらない
      valid_until: null,
      // 以下は管理画面でしか使わない項目。お客様側には返していないので既定値を入れる
      needs_refresh: false,
      refresh_note: null,
      updated_at: '',
      updated_by_name: null,
      targets: (a.targets ?? []).map(tg => ({
        // 対象行のidはお客様側で使わないためRPCが返していない。
        // 使うのは school / course / role_title だけ（matchesViewer 参照）
        id: '',
        answer_id: a.id,
        school: tg.school,
        course: tg.course,
        role_title: tg.role_title,
      })),
    })),
    // RPCは公開中のものしか返さない。isTopicVisible / matchFaqTopics が
    // is_published を見るため true を入れておく
    audience: 'public' as FaqAudience,
    is_published: true,
    needs_review: false,
    review_note: null,
    updated_at: '',
    updated_by_name: null,
    // 🚨 参照先が「今日出せる状態か」はここでは判定しない。
    //    表示側が「読み込んだ一覧に無いIDのボタンは出さない」ことで自然に消える
    related: (t.related ?? []).map(r => ({ topic_id: r.topic_id, label: r.label })),
  }));
};

/** お客様の質問を記録する（未ログインから呼べる）。失敗しても画面は止めない */
export const logPublicFaqQuery = async (params: {
  rawQuery: string;
  hadMatch: boolean;
  school?: string | null;
  course?: string | null;
  pickedTopicId?: string | null;
}) => {
  await supabase
    .rpc('faq_public_log', {
      p_raw_query: params.rawQuery,
      p_had_match: params.hadMatch,
      p_school: params.school ?? null,
      p_course: params.course ?? null,
      p_picked_topic_id: params.pickedTopicId ?? null,
    })
    // 記録は補助であって本体ではない。ただし黙って捨てず必ずログには残す
    .then(null, (e: unknown) => console.error('FAQ質問ログの記録に失敗:', e));
};

// ============================================================
// 社外FAQの利用記録（faq_public_event）
// ============================================================
// 「どの回答を書き直すべきか」を判断するための記録。検索した言葉は
// faq_query_log 側が持っているので、ここには入れない（個人情報の保存場所を増やさない）。

/** 記録する出来事 */
export type FaqEventKind =
  | 'page_view'      // ページを開いた（1セッション1回）
  | 'topic_view'     // 回答が表示された（1セッション×1質問1回）
  | 'contact'        // 問い合わせの案内に進んだ（reason で理由を分ける）
  | 'contact_click'  // 電話・フォームを実際に押した
  | 'solved';        // 「はい（解決した）」を押した

/** 問い合わせに進んだ理由。🚨 それぞれ「やるべきこと」が違うので必ず分けて記録する */
export type FaqContactReason =
  | 'unsolved'        // 回答を読んだが解決しない  → その回答を書き直す
  | 'search_nomatch'  // 検索候補は出たが的外れ    → 検索の手がかり語を足す
  | 'search_nohit'    // 検索候補が0件             → 新しい質問と回答を作る
  | 'unknown'         // 校・コースに該当が無い    → 既存の回答に対象を足す
  | 'noanswer'        // 有効な回答が無い          → 下書きを公開する
  | 'load_error';     // 読み込みに失敗した        → 不具合として気づくため

// 🚨 ここから下は「記録が取れなくても、お客様の画面は絶対に止めない」が最優先。
//    ウィジェットは別オリジンの iframe で動くため、ブラウザの設定によっては
//    sessionStorage を読むだけで例外が飛ぶ。エラーバウンダリはあるが、
//    そもそも落とさないように全て try/catch で包む。

const FAQ_SID_KEY = 'fivem_faq_sid';
const FAQ_SENT_KEY = 'fivem_faq_sent';

/** 端末の一時ID。🚨 crypto.randomUUID は古い端末（iOS 15.4未満）に無いので必ず逃げ道を持つ */
const newId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* 使えなければ下の簡易版へ */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

let memorySid: string | null = null;

/** セッションID（タブを閉じると消える）。個人は特定しない */
const faqSessionId = (): string => {
  try {
    const s = window.sessionStorage.getItem(FAQ_SID_KEY);
    if (s) return s;
    const v = newId();
    window.sessionStorage.setItem(FAQ_SID_KEY, v);
    return v;
  } catch {
    // ストレージが使えない端末。記録の精度より、回答が読めることを優先する
    return (memorySid ??= newId());
  }
};

/** 「1セッションに1回だけ」の判定。🚨 情報源はここ1つ（画面側で別に持たない） */
const sentKeys: Set<string> = (() => {
  try {
    const raw = window.sessionStorage.getItem(FAQ_SENT_KEY);
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set<string>();
  }
})();

const rememberSent = (key: string): void => {
  sentKeys.add(key);
  try {
    window.sessionStorage.setItem(FAQ_SENT_KEY, JSON.stringify([...sentKeys]));
  } catch { /* 画面の中だけで覚える（タブを再読み込みすると忘れる） */ }
};

/** その出来事を、このセッションでもう送ったか */
export const faqEventSent = (once: string): boolean => sentKeys.has(once);

export interface FaqEventInput {
  kind: FaqEventKind;
  reason?: FaqContactReason | null;
  channel?: 'tel' | 'form' | null;
  topicId?: string | null;
  answerId?: string | null;
  school?: string | null;
  course?: string | null;
  /** 指定すると「1セッションに1回だけ」送る（例: 'page' / `topic:<id>`） */
  once?: string;
}

export const logFaqEvent = async (p: FaqEventInput): Promise<void> => {
  // 🚨 印は送る前に立てる。あとで立てると、連打したぶんだけ二重に入る
  if (p.once) {
    if (sentKeys.has(p.once)) return;
    rememberSent(p.once);
  }
  try {
    const { error } = await supabase.rpc('faq_public_event_log', {
      p_kind: p.kind,
      p_reason: p.reason ?? null,
      p_channel: p.channel ?? null,
      p_topic_id: p.topicId ?? null,
      p_answer_id: p.answerId ?? null,
      p_school: p.school ?? null,
      p_course: p.course ?? null,
      p_session_id: faqSessionId(),
    });
    // 🚨 supabase の rpc は 4xx/5xx でも例外を投げない。error を必ず見ること。
    //    既存の `.then(null, ...)` は通信エラーしか拾えず、
    //    制約違反・関数が無い（PGRST202）などが黙って消える
    if (error) console.error('FAQ利用記録に失敗:', error.code, error.message);
  } catch (e) {
    console.error('FAQ利用記録に失敗（通信）:', e);
  }
};

// ============================================================
// 「今どの回答を出すか」の判定
// ============================================================

/** その回答が、指定日に有効か（valid_from が未設定＝下書きは常に無効） */
export const isAnswerActiveOn = (answer: FaqAnswer, dateStr: string): boolean => {
  if (!answer.valid_from) return false;
  if (answer.valid_from > dateStr) return false;
  if (answer.valid_until && answer.valid_until < dateStr) return false;
  return true;
};

/** その回答が、この閲覧者（校・コース・役職）向けか。対象の指定が無い回答＝全員向け */
const matchesViewer = (answer: FaqAnswer, viewer: FaqViewer): boolean => {
  if (answer.targets.length === 0) return true;
  return answer.targets.some(t => {
    if (t.role_title && t.role_title !== viewer.roleTitle) return false;
    if (t.school && t.school !== viewer.school) return false;
    if (t.course && t.course !== viewer.course) return false;
    return true;
  });
};

/**
 * 表示する回答を1つ選ぶ。
 * 対象を指定した回答（上書き）を、共通の回答より優先する。
 * 見つからなければ null（＝この人にはこの質問の答えが無い＝一覧に出さない）。
 */
export const resolveAnswer = (
  topic: FaqTopic,
  viewer: FaqViewer,
  dateStr: string = todayJstStr(),
): FaqAnswer | null => {
  const active = topic.answers.filter(a => isAnswerActiveOn(a, dateStr) && matchesViewer(a, viewer));
  if (active.length === 0) return null;
  // 対象指定あり（上書き）を優先。同条件なら適用開始日が新しい方
  const sorted = [...active].sort((a, b) => {
    const aSpecific = a.targets.length > 0 ? 1 : 0;
    const bSpecific = b.targets.length > 0 ? 1 : 0;
    if (aSpecific !== bSpecific) return bSpecific - aSpecific;
    return (b.valid_from ?? '').localeCompare(a.valid_from ?? '');
  });
  return sorted[0];
};

/** その質問が、この閲覧者に今日見えるか（有効な回答が1つも無ければ出さない） */
export const isTopicVisible = (topic: FaqTopic, viewer: FaqViewer, dateStr: string = todayJstStr()): boolean =>
  topic.is_published && resolveAnswer(topic, viewer, dateStr) !== null;

// ============================================================
// 検索（キーワード照合）
// ============================================================
// 🚨 AIは使わない。入力文に含まれるキーワードの数で点数を付けて上位を返すだけ。
//    将来AIに差し替えるとしても、差し替えるのはこの関数1つで済むようにしてある。

export interface FaqMatch {
  topic: FaqTopic;
  answer: FaqAnswer;
  score: number;
}

/** 全角・大小・空白のゆれを吸収して比較しやすくする */
const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]+/g, '');

/**
 * 入力文に近い質問を探す。
 * 点数＝キーワード一致（重み2）＋質問文そのものの部分一致（重み3）。
 * 同点なら並び順（sort_order）が先のものを優先する。
 */
export const matchFaqTopics = (
  query: string,
  topics: FaqTopic[],
  viewer: FaqViewer,
  limit = 3,
  dateStr: string = todayJstStr(),
  opts?: {
    /**
     * 対象（校・コース・役職）が合わない質問も候補に出す。
     * お客様向けウィジェットは「質問を選んだ後に校・コースを聞く」流れのため、
     * 検索の時点では校・コースが分からない。falseのまま（既定）だと
     * 校別の回答しか無い質問（駐車場など）が検索に一切出なくなる
     */
    ignoreTargets?: boolean;
  },
): FaqMatch[] => {
  const q = normalize(query);
  if (!q) return [];

  const matches: FaqMatch[] = [];
  topics.forEach(topic => {
    if (!topic.is_published) return;
    const answer =
      resolveAnswer(topic, viewer, dateStr) ??
      (opts?.ignoreTargets ? topic.answers.find(a => isAnswerActiveOn(a, dateStr)) ?? null : null);
    if (!answer) return; // この人向けの有効な回答が無い質問は候補にしない

    let score = 0;
    topic.keywords.forEach(k => {
      const nk = normalize(k);
      if (nk && q.includes(nk)) score += 2;
    });
    const nq = normalize(topic.question);
    // 質問文が長いと丸ごと一致はしないので、2文字ずつに切って重なりを見る
    for (let i = 0; i < nq.length - 1; i++) {
      if (q.includes(nq.slice(i, i + 2))) score += 0.2;
    }
    if (score > 0) matches.push({ topic, answer, score });
  });

  return matches
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.topic.sort_order - b.topic.sort_order))
    .slice(0, limit);
};

/** 検索窓の下に出す「よくあるご質問」 */
export const featuredTopics = (
  topics: FaqTopic[],
  viewer: FaqViewer,
  limit = 6,
  dateStr: string = todayJstStr(),
  opts?: { /** matchFaqTopics と同じ。ウィジェット用（対象を後から聞く流れ） */ ignoreTargets?: boolean },
): FaqTopic[] =>
  topics
    .filter(t =>
      t.is_featured &&
      (isTopicVisible(t, viewer, dateStr) ||
        (opts?.ignoreTargets === true && t.is_published && t.answers.some(a => isAnswerActiveOn(a, dateStr)))),
    )
    .sort((a, b) => a.sort_order - b.sort_order)
    .slice(0, limit);

// ============================================================
// 質問ログ（答えられなかった質問を集めて次のQ&Aを足すための記録）
// ============================================================
export const logFaqQuery = async (params: {
  audience: FaqAudience;
  rawQuery: string;
  hadMatch: boolean;
  viewer?: FaqViewer;
  pickedTopicId?: string | null;
}) => {
  // 記録に失敗しても利用者の操作は止めない（ログは補助であって本体ではない）
  await supabase.from('faq_query_log').insert({
    audience: params.audience,
    raw_query: params.rawQuery.slice(0, 500),
    school: params.viewer?.school ?? null,
    course: params.viewer?.course ?? null,
    role_title: params.viewer?.roleTitle ?? null,
    had_match: params.hadMatch,
    picked_topic_id: params.pickedTopicId ?? null,
  }).then(null, () => {});
};

// ============================================================
// 編集（管理画面から使う）
// ============================================================

export interface FaqTopicInput {
  audience: FaqAudience;
  category: string;
  question: string;
  keywords: string[];
  is_published: boolean;
  is_featured: boolean;
  needs_review: boolean;
  review_note: string | null;
  sort_order: number;
}

export interface FaqAnswerInput {
  body: string;
  source_label: string | null;
  source_url: string | null;
  valid_from: string | null;
  valid_until: string | null;
  needs_refresh: boolean;
  refresh_note: string | null;
  /** 対象。空配列＝全員向けの共通回答 */
  targets: { school?: string | null; course?: string | null; role_title?: string | null }[];
}

export const createFaqTopic = (input: FaqTopicInput, editorId: string | null, editorName: string) =>
  supabase
    .from('faq_topics')
    .insert({ ...input, updated_by: editorId, updated_by_name: editorName })
    .select('id')
    .single();

export const updateFaqTopic = (id: string, input: FaqTopicInput, editorId: string | null, editorName: string) =>
  supabase.from('faq_topics').update({ ...input, updated_by: editorId, updated_by_name: editorName }).eq('id', id);

export const deleteFaqTopic = (id: string) => supabase.from('faq_topics').delete().eq('id', id);

/**
 * 関連質問（違う場合はこちら）の保存。
 * 対象（targets）と同じく差分管理をせず、常に画面の内容で入れ替える。
 */
export const saveFaqTopicRelations = async (
  topicId: string,
  relations: { related_topic_id: string; label: string | null }[],
): Promise<{ error: string | null }> => {
  const { error: delError } = await supabase.from('faq_topic_relations').delete().eq('topic_id', topicId);
  if (delError) return { error: delError.message };
  if (relations.length === 0) return { error: null };
  const { error } = await supabase.from('faq_topic_relations').insert(
    relations.map((r, i) => ({
      topic_id: topicId,
      related_topic_id: r.related_topic_id,
      label: r.label,
      sort_order: i,
    })),
  );
  return { error: error?.message ?? null };
};

/** 回答の保存。対象は毎回入れ替える（差分管理をせず、常に画面の内容で上書きする） */
export const saveFaqAnswer = async (
  topicId: string,
  answerId: string | null,
  input: FaqAnswerInput,
  editorId: string | null,
  editorName: string,
): Promise<{ error: string | null }> => {
  const row = {
    topic_id: topicId,
    body: input.body,
    source_label: input.source_label,
    source_url: input.source_url,
    valid_from: input.valid_from,
    valid_until: input.valid_until,
    needs_refresh: input.needs_refresh,
    refresh_note: input.refresh_note,
    updated_by: editorId,
    updated_by_name: editorName,
  };

  let id = answerId;
  if (id) {
    const { error } = await supabase.from('faq_answers').update(row).eq('id', id).select('id');
    if (error) return { error: error.message };
    await supabase.from('faq_answer_targets').delete().eq('answer_id', id);
  } else {
    const { data, error } = await supabase.from('faq_answers').insert(row).select('id').single();
    if (error || !data) return { error: error?.message ?? '保存できませんでした' };
    id = data.id;
  }

  if (input.targets.length > 0) {
    const { error } = await supabase
      .from('faq_answer_targets')
      .insert(input.targets.map(t => ({
        answer_id: id,
        school: t.school ?? null,
        course: t.course ?? null,
        role_title: t.role_title ?? null,
      })));
    if (error) return { error: error.message };
  }
  return { error: null };
};

export const deleteFaqAnswer = (id: string) => supabase.from('faq_answers').delete().eq('id', id);

// ============================================================
// 回答の状態（管理画面での見せ方に使う）
// ============================================================
export type AnswerState = 'draft' | 'scheduled' | 'active' | 'expired';

export const answerState = (answer: FaqAnswer, dateStr: string = todayJstStr()): AnswerState => {
  if (!answer.valid_from) return 'draft';
  if (answer.valid_from > dateStr) return 'scheduled';
  if (answer.valid_until && answer.valid_until < dateStr) return 'expired';
  return 'active';
};

export const ANSWER_STATE_LABEL: Record<AnswerState, string> = {
  draft: '下書き（日付未定）',
  scheduled: '公開予定',
  active: 'いま出ている回答',
  expired: '過去の回答',
};
