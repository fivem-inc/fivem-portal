// 連絡板のアンケート：回答する（2026-10-29・計画 docs/計画-連絡板のアンケート.md・見本の②）。
// 受信トレイでアンケートのお知らせを開いたときに出す（宛先の人だけ）。
//
// ・上に「3/8問」・必須は文字で・選ぶものは行全体を押せる（44px 以上）・入力欄は 16px（iPhone の勝手な拡大を防ぐ）
// ・送るときは最初の問題の質問まで画面を動かして赤い枠＋文
// ・書きかけは端末に残す（下書き・ログアウトで消える）
// ・期限までは［回答を直す］。期限のあとも回答できる（「期限後」）が、送ったあとは直せない
// 🚨 回答を書くのは DB の board_survey_answer だけ。確かめの決まりは lib/boardSurvey（DB と同じ）

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  type SurveyAnswers, type SurveyAnswerValue, type SurveyDef, type SurveyQuestion, type SurveyVisibility,
  OTHER_ID, SURVEY_LIMITS, answerProblem, answerText, answeredCount, cleanAnswers, isPastDeadline, surveyDateLabel,
} from '../../lib/boardSurvey';
import { loadMySurveyAnswer, sendSurveyAnswer, loadSurveyResults, type MySurveyAnswer, type SurveyResults } from '../../lib/boardSurveyApi';
import { sendFailureText } from '../../lib/netFailure';
import { todayJstStr } from '../../lib/breakCalc';
import { primaryBtn, backBtn, TOGGLE_BLUE } from '../../lib/buttonStyles';
import SurveyResultsView from './SurveyResultsView';

interface Props {
  messageId: string;
  survey: SurveyDef;
  deadline: string | null;
  visibility: SurveyVisibility;
  userId: string;
  isDark: boolean;
  /** 回答した（初めて）ときに親の「回答済み」を立てる */
  onAnswered?: () => void;
  profiles: { id: string; name: string | null }[];
}

const draftKey = (uid: string, mid: string) => `fivem_survey_draft:${uid}:${mid}`;
const readDraft = (uid: string, mid: string): SurveyAnswers | null => {
  try { const s = localStorage.getItem(draftKey(uid, mid)); return s ? (JSON.parse(s) as SurveyAnswers) : null; } catch { return null; }
};
const writeDraft = (uid: string, mid: string, a: SurveyAnswers | null) => {
  try { if (a) localStorage.setItem(draftKey(uid, mid), JSON.stringify(a)); else localStorage.removeItem(draftKey(uid, mid)); } catch { /* 端末に保存できなくても回答はできる */ }
};
const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const SurveyAnswerForm: React.FC<Props> = ({ messageId, survey, deadline, visibility, userId, isDark, onAnswered, profiles }) => {
  const text = isDark ? '#f8f9fa' : '#212529';
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const cardBg = isDark ? '#2b3035' : '#f8f9fa';

  const [mine, setMine] = useState<MySurveyAnswer | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [answers, setAnswers] = useState<SurveyAnswers>({});
  const [problem, setProblem] = useState<{ index: number; message: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [results, setResults] = useState<SurveyResults | null>(null);
  const [resultsError, setResultsError] = useState<string | null>(null);
  const [resultsOpen, setResultsOpen] = useState(false);
  const qRefs = useRef<(HTMLDivElement | null)[]>([]);

  const late = isPastDeadline(deadline, todayJstStr());

  const reload = async () => {
    setLoading(true); setLoadError(null);
    const r = await loadMySurveyAnswer(messageId, userId);
    if (r.error) { setLoadError(r.error); setLoading(false); return; }
    setMine(r.answer);
    if (!r.answer) {
      setEditing(true);
      setAnswers(readDraft(userId, messageId) ?? {});
    } else {
      setEditing(false);
    }
    setLoading(false);
  };
  // reload は messageId・userId が変わったときだけ読み直す
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, [messageId, userId]);

  const setA = (q: SurveyQuestion, v: SurveyAnswerValue) => {
    setAnswers(prev => {
      const next = { ...prev, [q.id]: v };
      writeDraft(userId, messageId, next);
      return next;
    });
    if (problem) setProblem(null);
  };

  const progress = useMemo(() => answeredCount(survey, answers), [survey, answers]);

  const submit = async () => {
    const p = answerProblem(survey, answers);
    if (p) {
      setProblem(p);
      qRefs.current[p.index]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    setSending(true); setSendError(null);
    const r = await sendSurveyAnswer(messageId, cleanAnswers(survey, answers));
    setSending(false);
    if (!r.ok) {
      setSendError(sendFailureText(r.error) ?? `送れませんでした：${r.error.message || '不明なエラー'}`);
      return;
    }
    const first = !mine;
    writeDraft(userId, messageId, null);
    setMine(r.answer);
    setEditing(false);
    setDone(first ? `回答しました（${fmtWhen(r.answer.answered_at)}）` : `回答を直しました（${fmtWhen(r.answer.updated_at)}）`);
    if (first) onAnswered?.();
    if (resultsOpen) void openResults();
  };

  const openResults = async () => {
    setResultsOpen(true); setResultsError(null);
    const r = await loadSurveyResults(messageId);
    if (r.error) { setResultsError(r.error); return; }
    setResults(r.results);
  };

  const optRow = (on: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 44, padding: '8px 12px', boxSizing: 'border-box',
    borderRadius: 10, border: `1.5px solid ${on ? TOGGLE_BLUE : border}`, background: on ? TOGGLE_BLUE : 'transparent',
    color: on ? '#fff' : text, cursor: 'pointer', fontSize: 15, textAlign: 'left', fontWeight: on ? 'bold' : 'normal',
  });
  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8, border: `1px solid ${border}`,
    background: isDark ? '#212529' : '#fff', color: text, fontSize: 16, fontFamily: 'inherit',
  };

  if (loading) return <div style={{ fontSize: 13, color: sub, padding: '8px 0' }}>アンケートを読み込んでいます…</div>;
  if (loadError) {
    return (
      <div style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #f5c2c7', background: isDark ? '#3a1d20' : '#f8d7da', color: isDark ? '#f5c2c7' : '#842029', fontSize: 13 }}>
        アンケートを読み込めませんでした（{loadError}）
        <button type="button" onClick={() => void reload()} style={{ ...backBtn(isDark), padding: '6px 12px', fontSize: 13, marginLeft: 8 }}>再読み込み</button>
      </div>
    );
  }

  // ── 回答したあと（読むだけ） ──
  if (mine && !editing) {
    const canEdit = !late;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {done && (
          <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '9px 12px', fontSize: 13, color: '#166534', fontWeight: 600 }}>✓ {done}</div>
        )}
        <div style={{ fontSize: 13, color: sub }}>
          あなたの回答（{fmtWhen(mine.answered_at)}{mine.edit_count > 0 ? `・${fmtWhen(mine.updated_at)} に直しました` : ''}{mine.is_late ? '・期限後' : ''}）
        </div>
        {survey.questions.map((q, i) => (
          <div key={q.id} style={{ padding: '8px 12px', borderRadius: 8, background: cardBg, border: `1px solid ${border}` }}>
            <div style={{ fontSize: 13, color: sub }}>{i + 1}. {q.label}</div>
            <div style={{ fontSize: 15, color: text, marginTop: 2, whiteSpace: 'pre-wrap' }}>{answerText(q, mine.answers[q.id]) || <span style={{ color: sub }}>（回答なし）</span>}</div>
          </div>
        ))}
        {canEdit ? (
          <div style={{ fontSize: 12, color: sub }}>期限（{deadline ? surveyDateLabel(deadline) : 'なし'}）までは直せます。</div>
        ) : (
          <div style={{ fontSize: 12, color: sub }}>期限を過ぎたため、回答は直せません。</div>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canEdit && (
            <button type="button" data-net="write" onClick={() => { setAnswers(mine.answers); setEditing(true); setDone(null); }}
              style={{ ...backBtn(isDark), padding: '10px 16px', fontSize: 14 }}>回答を直す</button>
          )}
          {visibility !== 'sender' && (
            <button type="button" onClick={() => (resultsOpen ? setResultsOpen(false) : void openResults())}
              style={{ ...backBtn(isDark), padding: '10px 16px', fontSize: 14 }}>{resultsOpen ? 'みんなの回答を閉じる' : 'みんなの回答を見る'}</button>
          )}
        </div>
        {resultsOpen && (
          resultsError
            ? <div style={{ fontSize: 13, color: '#dc3545' }}>読み込めませんでした（{resultsError}）</div>
            : results ? <SurveyResultsView survey={survey} results={results} isDark={isDark} profiles={profiles} />
            : <div style={{ fontSize: 13, color: sub }}>読み込んでいます…</div>
        )}
      </div>
    );
  }

  // ── 回答する・直す ──
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: sub }}>
          <span>{survey.questions.length}問のアンケート</span>
          <span>{progress}/{survey.questions.length}問</span>
        </div>
        <div style={{ height: 4, background: border, borderRadius: 2, marginTop: 4 }}>
          <div style={{ width: `${Math.round((progress / survey.questions.length) * 100)}%`, height: 4, background: TOGGLE_BLUE, borderRadius: 2 }} />
        </div>
      </div>

      {survey.questions.map((q, i) => {
        const v = answers[q.id] ?? {};
        const bad = problem?.index === i;
        return (
          <div key={q.id} ref={el => { qRefs.current[i] = el; }}
            style={{ padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${bad ? '#dc3545' : border}`, background: cardBg }}>
            <div style={{ fontSize: 15, fontWeight: 'bold', color: text }}>
              {i + 1}. {q.label}
              {q.required && <span style={{ marginLeft: 6, fontSize: 12, color: '#dc3545', fontWeight: 'normal' }}>必須</span>}
            </div>
            {q.help && <div style={{ fontSize: 13, color: sub, marginTop: 2, whiteSpace: 'pre-wrap' }}>{q.help}</div>}
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {q.kind === 'single' && (
                <>
                  {(q.options ?? []).map(o => (
                    <button key={o.id} type="button" style={optRow(v.choice === o.id)} onClick={() => setA(q, { choice: v.choice === o.id ? undefined : o.id })}>
                      <span>{v.choice === o.id ? '●' : '○'}</span>{o.label}
                    </button>
                  ))}
                  {q.allow_other && (
                    <>
                      <button type="button" style={optRow(v.choice === OTHER_ID)} onClick={() => setA(q, { choice: v.choice === OTHER_ID ? undefined : OTHER_ID, other: v.other })}>
                        <span>{v.choice === OTHER_ID ? '●' : '○'}</span>その他
                      </button>
                      {v.choice === OTHER_ID && (
                        <input value={v.other ?? ''} maxLength={SURVEY_LIMITS.other} onChange={e => setA(q, { choice: OTHER_ID, other: e.target.value })}
                          placeholder="その他の内容" style={inputStyle} />
                      )}
                    </>
                  )}
                </>
              )}
              {q.kind === 'multi' && (() => {
                const cs = v.choices ?? [];
                const toggle = (id: string) => setA(q, { choices: cs.includes(id) ? cs.filter(x => x !== id) : [...cs, id], other: v.other });
                return (
                  <>
                    <div style={{ fontSize: 12, color: sub }}>いくつでも選べます</div>
                    {(q.options ?? []).map(o => (
                      <button key={o.id} type="button" style={optRow(cs.includes(o.id))} onClick={() => toggle(o.id)}>
                        <span>{cs.includes(o.id) ? '☑' : '☐'}</span>{o.label}
                      </button>
                    ))}
                    {q.allow_other && (
                      <>
                        <button type="button" style={optRow(cs.includes(OTHER_ID))} onClick={() => toggle(OTHER_ID)}>
                          <span>{cs.includes(OTHER_ID) ? '☑' : '☐'}</span>その他
                        </button>
                        {cs.includes(OTHER_ID) && (
                          <input value={v.other ?? ''} maxLength={SURVEY_LIMITS.other} onChange={e => setA(q, { choices: cs, other: e.target.value })}
                            placeholder="その他の内容" style={inputStyle} />
                        )}
                      </>
                    )}
                  </>
                );
              })()}
              {q.kind === 'text' && (
                <textarea value={v.text ?? ''} maxLength={SURVEY_LIMITS.text} rows={3} onChange={e => setA(q, { text: e.target.value })}
                  placeholder="ここに書いてください" style={{ ...inputStyle, resize: 'vertical' }} />
              )}
              {q.kind === 'date' && (() => {
                const ds = v.dates ?? [];
                return (
                  <>
                    {(q.date_from || q.date_to) && (
                      <div style={{ fontSize: 12, color: sub }}>選べる日：{q.date_from ? surveyDateLabel(q.date_from) : ''}〜{q.date_to ? surveyDateLabel(q.date_to) : ''}（いくつでも）</div>
                    )}
                    {ds.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {ds.map(d => (
                          <span key={d} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 10px', borderRadius: 16, background: TOGGLE_BLUE, color: '#fff', fontSize: 14 }}>
                            {surveyDateLabel(d)}
                            <button type="button" aria-label={`${surveyDateLabel(d)} を外す`} onClick={() => setA(q, { dates: ds.filter(x => x !== d) })}
                              style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 14, minWidth: 28, minHeight: 28 }}>✕</button>
                          </span>
                        ))}
                      </div>
                    )}
                    {ds.length < SURVEY_LIMITS.dates && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: text }}>
                        ＋ 日付を足す
                        <input type="date" value="" min={q.date_from} max={q.date_to}
                          onChange={e => { const d = e.target.value; if (d && !ds.includes(d)) setA(q, { dates: [...ds, d].sort() }); }}
                          style={{ ...inputStyle, width: 'auto', flex: 1 }} />
                      </label>
                    )}
                  </>
                );
              })()}
            </div>
            {bad && <div style={{ fontSize: 13, color: '#dc3545', marginTop: 6 }}>{problem?.message}</div>}
          </div>
        );
      })}

      {visibility === 'respondents_named' && (
        <div style={{ fontSize: 13, color: isDark ? '#ffda6a' : '#856404', background: isDark ? '#332701' : '#fff3cd', border: `1px solid ${isDark ? '#664d03' : '#ffe69c'}`, borderRadius: 8, padding: '8px 12px' }}>
          あなたの回答は、回答した方全員に名前つきで見えます。
        </div>
      )}
      {late && (
        <div style={{ fontSize: 13, color: isDark ? '#ffda6a' : '#856404', background: isDark ? '#332701' : '#fff3cd', border: `1px solid ${isDark ? '#664d03' : '#ffe69c'}`, borderRadius: 8, padding: '8px 12px' }}>
          期限（{deadline ? surveyDateLabel(deadline) : ''}）を過ぎているため、送ったあとは直せません。
        </div>
      )}
      {problem && problem.index < 0 && <div style={{ fontSize: 13, color: '#dc3545' }}>{problem.message}</div>}
      {sendError && <div style={{ fontSize: 13, color: '#dc3545' }}>{sendError}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        {mine && (
          <button type="button" onClick={() => { setEditing(false); setProblem(null); setSendError(null); }}
            style={{ ...backBtn(isDark), flex: 1 }}>やめる</button>
        )}
        <button type="button" data-net="write" disabled={sending} onClick={() => void submit()}
          style={{ ...primaryBtn({ disabled: sending }), flex: 2 }}>
          {sending ? '送っています…' : mine ? '直した回答を送る' : '回答を送る'}
        </button>
      </div>
    </div>
  );
};

export default SurveyAnswerForm;
