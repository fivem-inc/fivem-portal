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
    if (ask) { setView({ kind: 'select', topic, ask }); return; }
    const answer = resolveAnswer(topic, v, today);
    if (!answer) { setView({ kind: 'contact', reason: 'noanswer' }); return; }
    setView({ kind: 'answer', topic, answer });
  }, [neededAsk, today]);

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
      if (common) { setView({ kind: 'answer', topic, answer: common }); return; }
      setView({ kind: 'contact', reason: 'unknown' });
      return;
    }
    const next = ask === 'school' ? { ...viewer, school: value } : { ...viewer, course: value };
    setViewer(next);
    openTopic(topic, next);
  };

  const backToHome = () => { setView({ kind: 'home' }); setSearched(null); setQuery(''); };

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
                  <div style={{ display: 'grid', gap: 6 }}>
                    {candidates.map(m => (
                      <button key={m.topic.id} type="button" onClick={() => openTopic(m.topic, viewer, searched)} style={listBtn}>
                        <span style={{ display: 'inline-block', fontSize: 12, background: BLUE_BG, color: BLUE_DARK, padding: '2px 8px', borderRadius: 4, marginBottom: 4 }}>
                          {m.topic.category}
                        </span>
                        <span style={{ display: 'block' }}>{m.topic.question}</span>
                      </button>
                    ))}
                  </div>
                  <p style={{ fontSize: 12, color: SUB, margin: '8px 0 0' }}>
                    どれも違う場合は、言葉を変えてもう一度ご入力いただくか、
                    <button type="button" onClick={() => setView({ kind: 'contact', reason: 'nomatch' })}
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
          <button type="button" onClick={backToHome}
            style={{ marginTop: 12, border: 'none', background: 'none', color: BLUE_DARK, fontSize: 13, cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
            ← 質問の一覧に戻る
          </button>
        </>
      )}

      {view.kind === 'answer' && (
        <>
          {/* 対象バナーは校・コース指定のある回答だけ。共通回答で「全ての方」と出すと、
              本文冒頭の【プラスコースの方】等の対象表示とちぐはぐになるため */}
          {view.answer.targets.length > 0 && (
            <div style={{ background: BLUE_BG, borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
              <p style={{ fontSize: 13, color: BLUE_DARK, margin: 0 }}>
                この回答は【<span style={{ fontWeight: 'bold' }}>{targetLabel(view.answer)}</span>】向けのご案内です
              </p>
            </div>
          )}
          <p style={{ fontSize: 14, fontWeight: 'bold', margin: '0 0 8px' }}>{view.topic.question}</p>
          <p style={{ fontSize: 15, lineHeight: 1.8, margin: '0 0 10px', whiteSpace: 'pre-wrap' }}>{view.answer.body}</p>
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

          {(viewer.school || viewer.course) && (
            <p style={{ fontSize: 12, color: SUB, margin: '10px 0 0' }}>
              選択中：{[viewer.school, viewer.course].filter(Boolean).join('・')}
              <button type="button" onClick={() => { setViewer({}); openTopic(view.topic, {}); }}
                style={{ border: 'none', background: 'none', color: BLUE_DARK, fontSize: 12, cursor: 'pointer', padding: 0, marginLeft: 8, textDecoration: 'underline' }}>
                校・コースを選び直す
              </button>
            </p>
          )}

          <div style={{ borderTop: `1px solid ${BORDER}`, marginTop: 12, paddingTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={backToHome}
              style={{ padding: '9px 14px', fontSize: 13, borderRadius: 8, border: `1px solid ${BORDER}`, background: '#fff', color: TEXT, cursor: 'pointer' }}>
              別の質問をする
            </button>
            <button type="button" onClick={() => setView({ kind: 'contact', reason: 'nomatch' })}
              style={{ padding: '9px 14px', fontSize: 13, borderRadius: 8, border: `1px solid ${BORDER}`, background: '#fff', color: TEXT, cursor: 'pointer' }}>
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
          <button type="button" onClick={backToHome}
            style={{ marginTop: 12, border: 'none', background: 'none', color: BLUE_DARK, fontSize: 13, cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
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
