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
  const { data: answers } = await supabase.from('faq_answers').select(ANSWER_COLS).in('topic_id', ids);
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

  return topics.map(t => ({
    ...(t as Omit<FaqTopic, 'answers'>),
    answers: answersByTopic.get(t.id) ?? [],
  }));
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
): FaqMatch[] => {
  const q = normalize(query);
  if (!q) return [];

  const matches: FaqMatch[] = [];
  topics.forEach(topic => {
    if (!topic.is_published) return;
    const answer = resolveAnswer(topic, viewer, dateStr);
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
): FaqTopic[] =>
  topics
    .filter(t => t.is_featured && isTopicVisible(t, viewer, dateStr))
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
