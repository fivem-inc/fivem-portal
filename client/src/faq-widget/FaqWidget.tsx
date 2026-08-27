import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  fetchPublicFaqTopics,
  logPublicFaqQuery,
  matchFaqTopics,
  featuredTopics,
  resolveAnswer,
  isAnswerActiveOn,
  FAQ_SCHOOL_OPTIONS,
  FAQ_COURSE_OPTIONS,
  type FaqTopic,
  type FaqAnswer,
  type FaqViewer,
} from '../lib/faq';
import { todayJstStr } from '../lib/breakCalc';

// お客様向けFAQウィジェット（ホームページに iframe で埋め込む）。
//
// 【設計の芯（社外版v4で確定した流れ）】
// ・検索窓ファースト。入力 → 近い質問を最大3件 → 選ぶ → 校・コースが要る質問だけ確認 → 回答
// ・AIは文章を作らない。表示するのは管理画面で登録した回答の原文だけ。
//   照合も lib/faq.ts の matchFaqTopics（キーワード照合）をそのまま使う
// ・回答の冒頭に「この回答は【◯◯】の方向けです」を必ず出し、
//   取り違えたときは「違う場合はこちら」ボタンで正しい質問へ1タップで移れる
// ・行き止まりを作らない。どの画面からも電話・問い合わせフォームに逃げられる
//
// 🚨 配色はライト固定（ホームページは白背景・ダークモード無し）。
//    社内アプリと同じ青 #1976d2 を使う（ユーザー決定 2026-08-15）

const BLUE = '#1976d2';
const BLUE_DARK = '#1565c0';
const BLUE_BG = '#e3f2fd';
const TEXT = '#333';
const SUB = '#666';
const BORDER = '#d9dee3';

// 「この中にない・わからない」の逃げ道（v4 F-1）。
// 電話のご案内は四条本校 総合受付に統一（2026-08-15 ユーザー確定）
const CONTACT_PHONE = '075-255-4401';
const CONTACT_FORM_URL = 'https://www.five-m.com/inquiry/';

// 🚨 回答本文に書いたURLは、そのまま出すと「押せない長い文字列」になる（実際そうなっていた）。
//    スマホでは長押ししてコピーするしかなく、事実上たどり着けない。
//    書く人は今までどおり本文にURLを書くだけでよく、表示するときにボタンへ変える。
//    ボタンの文字はURLから推測する（合わなければ「ページを開く」）。
const URL_RE = /(https?:\/\/[^\s　]+)/g;
const linkLabel = (url: string): string => {
  if (/shiori/i.test(url)) return '入会のしおり（校・コース別）を見る';
  if (/lessontime|lesson_program/i.test(url)) return 'レッスンタイム表を見る';
  if (/freetrial/i.test(url)) return '体験レッスンのお申し込みへ';
  if (/inquiry|contact/i.test(url)) return 'お問い合わせフォームへ';
  if (/price/i.test(url)) return '料金表を見る';
  if (/\.pdf(\?|$)/i.test(url)) return 'PDFを開く';
  return 'ページを開く';
};

/** 回答本文。文中のURLを押せるボタンにして出す */
const AnswerBody: React.FC<{ body: string }> = ({ body }) => {
  const parts = body.split(URL_RE);
  return (
    <div style={{ fontSize: 15, lineHeight: 1.8, margin: '0 0 10px' }}>
      {parts.map((part, i) => {
        // split の区切りは1つ飛ばしでURLが入る。末尾の記号（。や）など）は本文側へ戻す
        if (i % 2 === 1) {
          const m = part.match(/^(.*?)([。、）」]*)$/s);
          const url = m ? m[1] : part;
          const tail = m ? m[2] : '';
          return (
            <span key={i}>
              <a href={url} target="_blank" rel="noopener noreferrer"
                style={{ display: 'inline-block', margin: '6px 0', padding: '9px 14px', borderRadius: 8, border: `1px solid ${BLUE}`, color: BLUE_DARK, background: '#fff', fontSize: 14, textDecoration: 'none', fontWeight: 'bold' }}>
                {linkLabel(url)} →
              </a>
              {tail}
            </span>
          );
        }
        return <span key={i} style={{ whiteSpace: 'pre-wrap' }}>{part}</span>;
      })}
    </div>
  );
};

// コース選択肢に添える行動の説明（v4「行動の説明つき」）。無いコースは名前だけ出す
const COURSE_NOTE: Record<string, string> = {
  'こども器械体操': '親子・リトル・キッズ・プレミアム',
  'マットレ': 'マット運動専門のコース',
  'ウェルネス体操': '毎週決まったクラスに通っている方',
  'ウェルネス体操プライベート': '先生と日時を相談して予約している方',
  'こども器械体操プライベート': 'マンツーマンでレッスンを受けている方',
};

type View =
  | { kind: 'home' }
  | { kind: 'select'; topic: FaqTopic; ask: 'school' | 'course' }
  | { kind: 'answer'; topic: FaqTopic; answer: FaqAnswer }
  | { kind: 'contact'; reason: 'nomatch' | 'unknown' | 'noanswer' };

const card: React.CSSProperties = {
  background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12,
  padding: '16px 18px', color: TEXT, boxSizing: 'border-box',
};

const listBtn: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', boxSizing: 'border-box',
  border: `1px solid ${BORDER}`, borderRadius: 8, background: '#fff',
  padding: '11px 14px', fontSize: 14, color: TEXT, cursor: 'pointer', lineHeight: 1.6,
};

/** 「← 質問の一覧に戻る」ボタン。回答・校コース選択・問い合わせ案内の3画面で共通に使う。
 *  🚨 文言と見た目を必ず揃えること。以前は動き（backToHome）が同じなのに、
 *     回答画面だけ「別の質問をする」という別の言葉かつ枠付き、他の画面はリンク風で、
 *     「一覧に戻れない」と誤解して離脱する原因になっていた（2026-08-19 実機指摘）。 */
const backBtn: React.CSSProperties = {
  padding: '9px 14px', fontSize: 13, borderRadius: 8,
  border: `1px solid ${BORDER}`, background: '#fff', color: TEXT, cursor: 'pointer',
};

const FaqWidget: React.FC = () => {
  const [topics, setTopics] = useState<FaqTopic[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: 'home' });
  // 一度選んだ校・コースは覚えておく（質問のたびに聞き直さない）。
  // 回答画面の「校・コースを選び直す」でリセットできる
  const [viewer, setViewer] = useState<FaqViewer>({});
  const today = todayJstStr();
  const rootRef = useRef<HTMLDivElement>(null);

  // 🚨 スマホの戻るボタン対応。画面を1つ進めるたびに履歴を積み、戻る操作で1つ前の画面へ返す。
  //    これが無いと、端末の戻るボタンでウィジェットごとページを離脱してしまう
  //    （WordPress に iframe で埋め込んだ後も同じ。2026-08-18 実機指摘）。
  //    履歴の state には深さだけを入れる（topic/answer はそのまま入れられないので、
  //    画面の実体は stackRef で持つ）。
  const stackRef = useRef<View[]>([{ kind: 'home' }]);

  /** 画面を1つ進める（履歴に積む）。画面遷移は必ずこれを通すこと */
  const go = useCallback((v: View) => {
    stackRef.current = [...stackRef.current, v];
    window.history.pushState({ faqDepth: stackRef.current.length - 1 }, '');
    setView(v);
  }, []);

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const state = e.state as { faqDepth?: number } | null;
      const depth = typeof state?.faqDepth === 'number' ? state.faqDepth : 0;
      stackRef.current = stackRef.current.slice(0, depth + 1);
      // 検索結果（searched）はあえて消さない。候補から1件開いて戻ったとき、
      // 候補一覧が残っていた方が別の候補を試せるため。
      // 完全に最初へ戻すのは「← 質問の一覧に戻る」ボタンの役割
      setView(stackRef.current[stackRef.current.length - 1] ?? { kind: 'home' });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    fetchPublicFaqTopics().then(
      rows => { setTopics(rows); setLoading(false); },
      () => { setLoadError(true); setLoading(false); },
    );
  }, []);

  // 親ページ（WordPress）へ高さを知らせて iframe を伸縮させる。
  // 高さの数字だけを送る（個人情報・回答内容は送らない）
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !window.parent || window.parent === window) return;
    const send = () => window.parent.postMessage({ type: 'fivem-faq-height', height: el.offsetHeight }, '*');
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 検索候補。校・コースは質問を選んだ後に聞く流れなので、対象は無視して照合する
  const candidates = useMemo(
    () => (searched ? matchFaqTopics(searched, topics, viewer, 3, today, { ignoreTargets: true }) : []),
    [searched, topics, viewer, today],
  );

  const featured = useMemo(
    () => featuredTopics(topics, viewer, 6, today, { ignoreTargets: true }),
    [topics, viewer, today],
  );

  const doSearch = () => {
    const q = query.trim();
    if (!q) return;
    setSearched(q);
    setView({ kind: 'home' });
    // 答えられなかった質問を集めるための記録（失敗しても画面は止めない）
    const hadMatch = matchFaqTopics(q, topics, viewer, 3, today, { ignoreTargets: true }).length > 0;
    logPublicFaqQuery({ rawQuery: q, hadMatch, school: viewer.school, course: viewer.course });
  };

  /** その質問の有効な回答に、校・コースの指定があるか（あれば選択画面を挟む） */
  const neededAsk = useCallback((topic: FaqTopic, v: FaqViewer): 'school' | 'course' | null => {
    const active = topic.answers.filter(a => isAnswerActiveOn(a, today));
    const targets = active.flatMap(a => a.targets);
    if (targets.some(t => t.school) && !v.school) return 'school';
    if (targets.some(t => t.course) && !v.course) return 'course';
    return null;
  }, [today]);

  /** 質問を開く（必要なら校・コースの確認を挟み、決まっていれば回答へ直行） */
  const openTopic = useCallback((topic: FaqTopic, v: FaqViewer, fromSearch?: string) => {
    if (fromSearch) {
      logPublicFaqQuery({ rawQuery: fromSearch, hadMatch: true, school: v.school, course: v.course, pickedTopicId: topic.id });
    }
    const ask = neededAsk(topic, v);
    if (ask) { go({ kind: 'select', topic, ask }); return; }
    const answer = resolveAnswer(topic, v, today);
    if (!answer) { go({ kind: 'contact', reason: 'noanswer' }); return; }
    go({ kind: 'answer', topic, answer });
  }, [neededAsk, today, go]);

  // 校・コースの選択肢は全リスト（lib/faq.ts と共用）を出す。
  // 🚨 その質問の回答が対象にしている校・コースだけに絞ってはいけない。
  //    例：欠席・振替はウェルネス系だけ専用回答で、他コースは共通回答。
  //    絞ると「こども器械体操」の方が自分のコースを選べず、共通回答に辿り着けなくなる
  const askOptions = (ask: 'school' | 'course'): string[] =>
    ask === 'school' ? FAQ_SCHOOL_OPTIONS : FAQ_COURSE_OPTIONS;

  const pickOption = (topic: FaqTopic, ask: 'school' | 'course', value: string | null) => {
    if (value === null) {
      // 「この中にない・わからない」。校・コースを問わない共通の回答があればそれを出し、
      // 無ければお問い合わせ案内へ（行き止まりにしない）
      const cleared = ask === 'school' ? { ...viewer, school: null } : { ...viewer, course: null };
      const common = resolveAnswer(topic, cleared, today);
      if (common) { go({ kind: 'answer', topic, answer: common }); return; }
      go({ kind: 'contact', reason: 'unknown' });
      return;
    }
    const next = ask === 'school' ? { ...viewer, school: value } : { ...viewer, course: value };
    setViewer(next);
    openTopic(topic, next);
  };

  /**
   * 「← 質問の一覧に戻る」。1つ前ではなく最初の画面まで一気に戻す。
   * 履歴も積んだぶんだけ戻す（go(-深さ)）ので、そのあと端末の戻るボタンを押すと
   * ウィジェットを開く前のページへ抜けられる（履歴に空の階層が残らない）。
   */
  const backToHome = () => {
    setSearched(null);
    setQuery('');
    const depth = stackRef.current.length - 1;
    if (depth > 0) { window.history.go(-depth); return; }  // 画面の更新は popstate 側で行う
    setView({ kind: 'home' });
  };

  /**
   * 回答の対象表示（「この回答は【◯◯】の方向けです」）。
   * 対象が複数並ぶ回答（例：5コース共通）は、選んだ校・コースに合った1つを優先して出す
   * （全部並べると長くて読めないため）。
   */
  const targetLabel = (answer: FaqAnswer): string => {
    if (answer.targets.length === 0) return '全ての方';
    const matched = answer.targets.find(t =>
      (!t.school || t.school === viewer.school) && (!t.course || t.course === viewer.course) &&
      (t.school === viewer.school || t.course === viewer.course),
    );
    if (matched) return [matched.school, matched.course].filter(Boolean).join('・');
    const parts = answer.targets.map(t => [t.school, t.course].filter(Boolean).join('・')).filter(Boolean);
    return parts.join(' / ') || '全ての方';
  };

  if (loading) {
    return <div ref={rootRef} style={{ ...card, fontSize: 14, color: SUB }}>読み込んでいます...</div>;
  }
  if (loadError || topics.length === 0) {
    // データが取れない・0件のときに白画面や「質問がありません」で終わらせない
    return (
      <div ref={rootRef} style={card}>
        <p style={{ fontSize: 14, margin: '0 0 8px', lineHeight: 1.7 }}>
          ただいまこちらのご案内を表示できません。お手数ですが、お電話またはお問い合わせフォームからご連絡ください。
        </p>
        <ContactLinks />
      </div>
    );
  }

  return (
    <div ref={rootRef} style={card}>
      {view.kind === 'home' && (
        <>
          {/* 🚨 一度選んだ校・コースは覚えたままなので、質問一覧に戻ったときに
              「今どれで見ているか」が分からなくなる（2026-08-27 指摘）。上に出して選び直せるようにする */}
          {(viewer.school || viewer.course) && (
            <div style={{ background: BLUE_BG, borderRadius: 8, padding: '8px 12px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: BLUE_DARK }}>
                {[viewer.school, viewer.course].filter(Boolean).join('・')} のご案内を表示中
              </span>
              <button type="button" onClick={() => setViewer({})}
                style={{ border: 'none', background: 'none', color: BLUE_DARK, fontSize: 13, cursor: 'pointer', padding: 0, textDecoration: 'underline', whiteSpace: 'nowrap' }}>
                校を選び直す
              </button>
            </div>
          )}
          <p style={{ fontSize: 15, fontWeight: 'bold', margin: '0 0 10px' }}>ご質問をどうぞ</p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') doSearch(); }}
              placeholder="例：翌月の予約はいつから？"
              /* 🚨 fontSize 16px未満だとiPhoneがフォーカス時に画面を勝手に拡大する */
              style={{ flex: 1, minWidth: 0, padding: '10px 12px', fontSize: 16, border: `1px solid ${BORDER}`, borderRadius: 8, color: TEXT, boxSizing: 'border-box' }}
            />
            <button type="button" onClick={doSearch}
              style={{ padding: '10px 18px', fontSize: 14, fontWeight: 'bold', border: 'none', borderRadius: 8, background: BLUE, color: '#fff', cursor: 'pointer', flexShrink: 0 }}>
              検索
            </button>
          </div>

          {searched && (
            <div style={{ marginBottom: 16 }}>
              {candidates.length > 0 ? (
                <>
                  <p style={{ fontSize: 13, color: SUB, margin: '0 0 8px' }}>近いご質問が見つかりました。当てはまるものをお選びください。</p>
                  {/* 🚨 質問文を先、カテゴリを後に置くこと。カテゴリを上に置くと
                      「自分向けかどうかの札」として先に読まれ、当てはまる質問なのに
                      飛ばされる（2026-08-19 実機指摘：短期のカテゴリが付いた質問を
                      通常レッスンの方が読み飛ばす懸念）。 */}
                  <div style={{ display: 'grid', gap: 6 }}>
                    {candidates.map(m => (
                      <button key={m.topic.id} type="button" onClick={() => openTopic(m.topic, viewer, searched)} style={listBtn}>
                        <span style={{ display: 'block' }}>{m.topic.question}</span>
                        <span style={{ display: 'inline-block', fontSize: 12, background: BLUE_BG, color: BLUE_DARK, padding: '2px 8px', borderRadius: 4, marginTop: 4 }}>
                          {m.topic.category}
                        </span>
                      </button>
                    ))}
                  </div>
                  <p style={{ fontSize: 12, color: SUB, margin: '8px 0 0' }}>
                    どれも違う場合は、言葉を変えてもう一度ご入力いただくか、
                    <button type="button" onClick={() => go({ kind: 'contact', reason: 'nomatch' })}
                      style={{ border: 'none', background: 'none', color: BLUE_DARK, textDecoration: 'underline', cursor: 'pointer', fontSize: 12, padding: 0 }}>
                      お問い合わせ
                    </button>
                    ください。
                  </p>
                </>
              ) : (
                <div style={{ background: '#fff8e1', border: '1px solid #ffe0a3', borderRadius: 8, padding: 12 }}>
                  <p style={{ fontSize: 13, color: '#856404', margin: 0, lineHeight: 1.7 }}>
                    申し訳ございません、近いご質問が見つかりませんでした。言葉を変えてお試しいただくか、下記からお問い合わせください。
                  </p>
                  <div style={{ marginTop: 8 }}><ContactLinks /></div>
                </div>
              )}
            </div>
          )}

          {featured.length > 0 && (
            <>
              <p style={{ fontSize: 13, color: SUB, margin: '0 0 8px' }}>よくあるご質問</p>
              <div style={{ display: 'grid', gap: 6 }}>
                {featured.map(t => (
                  <button key={t.id} type="button" onClick={() => openTopic(t, viewer)} style={listBtn}>
                    <span style={{ color: BLUE_DARK, marginRight: 6 }}>▶</span>{t.question}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {view.kind === 'select' && (
        <>
          <p style={{ fontSize: 14, fontWeight: 'bold', margin: '0 0 4px' }}>{view.topic.question}</p>
          <p style={{ fontSize: 13, color: SUB, margin: '0 0 10px' }}>
            {view.ask === 'school' ? 'お通いの（ご検討中の）校をお選びください' : 'お通いの（レッスンを受けている）コースをお選びください'}
          </p>
          <div style={{ display: 'grid', gap: 6 }}>
            {askOptions(view.ask).map(op => (
              <button key={op} type="button" onClick={() => pickOption(view.topic, view.ask, op)} style={listBtn}>
                {op}
                {view.ask === 'course' && COURSE_NOTE[op] && (
                  <span style={{ display: 'block', fontSize: 12, color: SUB }}>【{COURSE_NOTE[op]}】</span>
                )}
              </button>
            ))}
            <button type="button" onClick={() => pickOption(view.topic, view.ask, null)}
              style={{ ...listBtn, color: SUB }}>
              この中にない・わからない
            </button>
          </div>
          <button type="button" onClick={backToHome} style={{ ...backBtn, marginTop: 12 }}>
            ← 質問の一覧に戻る
          </button>
        </>
      )}

      {view.kind === 'answer' && (
        <>
          {/* 上の帯＝「いま何向けの情報を見ているか」。
              ・対象指定のある回答 … その回答が誰向けかを出す（共通回答で「全ての方」と出すと
                本文冒頭の【プラスコースの方】等とちぐはぐになるので出さない）
              ・共通回答 … 代わりに選択中の校・コースを出す。
                これが無いと、校を選んでいるのに画面のどこにも出ず「今どれで見ているか」が分からない
              選び直しは下から上へ移した（重複させない） */}
          {(view.answer.targets.length > 0 || viewer.school || viewer.course) && (
            <div style={{ background: BLUE_BG, borderRadius: 8, padding: '8px 12px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: BLUE_DARK }}>
                {view.answer.targets.length > 0
                  ? <>この回答は【<span style={{ fontWeight: 'bold' }}>{targetLabel(view.answer)}</span>】向けのご案内です</>
                  : `${[viewer.school, viewer.course].filter(Boolean).join('・')} のご案内を表示中`}
              </span>
              {(viewer.school || viewer.course) && (
                <button type="button" onClick={() => { setViewer({}); openTopic(view.topic, {}); }}
                  style={{ border: 'none', background: 'none', color: BLUE_DARK, fontSize: 13, cursor: 'pointer', padding: 0, textDecoration: 'underline', whiteSpace: 'nowrap' }}>
                  校を選び直す
                </button>
              )}
            </div>
          )}
          <p style={{ fontSize: 14, fontWeight: 'bold', margin: '0 0 8px' }}>{view.topic.question}</p>
          <AnswerBody body={view.answer.body} />
          {view.answer.source_label && (
            <p style={{ fontSize: 12, color: '#999', margin: '0 0 12px' }}>
              出典：
              {view.answer.source_url
                ? <a href={view.answer.source_url} target="_blank" rel="noopener noreferrer" style={{ color: BLUE_DARK }}>{view.answer.source_label}</a>
                : view.answer.source_label}
            </p>
          )}

          {(() => {
            // 「違う場合はこちら」。読み込んだ一覧に無いID（非公開・期限切れ）のボタンは出さない
            const rels = view.topic.related
              .map(r => ({ r, topic: topics.find(t => t.id === r.topic_id) }))
              .filter((x): x is { r: (typeof view.topic.related)[number]; topic: FaqTopic } => !!x.topic);
            if (rels.length === 0) return null;
            return (
              <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 12, marginBottom: 4 }}>
                <p style={{ fontSize: 13, color: SUB, margin: '0 0 8px' }}>違う場合はこちら</p>
                <div style={{ display: 'grid', gap: 6 }}>
                  {rels.map(({ r, topic }) => (
                    <button key={topic.id} type="button" onClick={() => openTopic(topic, viewer)} style={listBtn}>
                      <span style={{ color: BLUE_DARK, marginRight: 6 }}>→</span>{r.label || topic.question}
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}


          <div style={{ borderTop: `1px solid ${BORDER}`, marginTop: 12, paddingTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={backToHome} style={backBtn}>
              ← 質問の一覧に戻る
            </button>
            <button type="button" onClick={() => go({ kind: 'contact', reason: 'nomatch' })} style={backBtn}>
              解決しない・問い合わせる
            </button>
          </div>
        </>
      )}

      {view.kind === 'contact' && (
        <>
          <p style={{ fontSize: 14, lineHeight: 1.8, margin: '0 0 10px' }}>
            {view.reason === 'unknown'
              ? 'お手数ですが、お通いの校に直接お問い合わせください。'
              : '申し訳ございません、こちらではお答えできませんでした。お手数ですが、お電話またはお問い合わせフォームからご連絡ください。'}
          </p>
          <ContactLinks />
          <button type="button" onClick={backToHome} style={{ ...backBtn, marginTop: 12 }}>
            ← 質問の一覧に戻る
          </button>
        </>
      )}
    </div>
  );
};

/** 電話・問い合わせフォームへの逃げ道（どの行き止まりからも出す） */
const ContactLinks: React.FC = () => (
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
    <a href={`tel:${CONTACT_PHONE.replace(/-/g, '')}`}
      style={{ display: 'inline-block', padding: '9px 14px', fontSize: 13, borderRadius: 8, border: `1px solid ${BORDER}`, background: '#fff', color: TEXT, textDecoration: 'none' }}>
      📞 {CONTACT_PHONE}（四条本校 総合受付）
    </a>
    <a href={CONTACT_FORM_URL} target="_blank" rel="noopener noreferrer"
      style={{ display: 'inline-block', padding: '9px 14px', fontSize: 13, borderRadius: 8, border: 'none', background: BLUE, color: '#fff', textDecoration: 'none' }}>
      お問い合わせフォーム
    </a>
  </div>
);

export default FaqWidget;
