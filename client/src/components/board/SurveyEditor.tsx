// 連絡板のアンケート：質問を作る（2026-10-29・計画 docs/計画-連絡板のアンケート.md・見本の①）。
// お知らせの作成画面（種別「回答」→［質問に答えてもらう］）と、送ったあとの［質問を直す］（回答0件のうち）の2か所が使う。
//
// ・質問は「たたんだカード」。押すと開いて直す。並べ替えは ↑↓（指で引っ張る形にしない）
// ・答え方は4つ（1つ選ぶ／いくつでも選ぶ／文字で書く／日付を選ぶ）。選択肢は行を足す・↑↓・✕
// 🚨 確かめの決まりは lib/boardSurvey の surveyDraftProblem（DB の board_survey_normalize と同じ）

import React, { useState } from 'react';
import {
  type SurveyDef, type SurveyKind, type SurveyQuestion, type SurveyVisibility,
  SURVEY_KIND_LABEL, SURVEY_VISIBILITY_LABEL, SURVEY_LIMITS, emptyQuestion, changeKind, newLocalId, surveyDateLabel,
} from '../../lib/boardSurvey';
import { TOGGLE_BLUE, tintBtn } from '../../lib/buttonStyles';

interface Props {
  value: SurveyDef;
  onChange: (v: SurveyDef) => void;
  isDark: boolean;
  /** 見せ方（作るときだけ。送ったあとの直しでは出さない） */
  visibility?: SurveyVisibility;
  onVisibility?: (v: SurveyVisibility) => void;
  /** 問題のある質問の番号（赤い枠） */
  problemIndex?: number | null;
}

const KINDS: SurveyKind[] = ['single', 'multi', 'text', 'date'];

const SurveyEditor: React.FC<Props> = ({ value, onChange, isDark, visibility, onVisibility, problemIndex }) => {
  const [openId, setOpenId] = useState<string | null>(value.questions[0]?.id ?? null);
  const text = isDark ? '#f8f9fa' : '#212529';
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const cardBg = isDark ? '#2b3035' : '#fff';
  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`,
    background: isDark ? '#212529' : '#fff', color: text, fontSize: 16, fontFamily: 'inherit',
  };
  const chip = (on: boolean): React.CSSProperties => ({
    padding: '8px 12px', minHeight: 40, borderRadius: 20, cursor: 'pointer', fontSize: 14,
    border: `1.5px solid ${on ? TOGGLE_BLUE : border}`, background: on ? TOGGLE_BLUE : 'transparent', color: on ? '#fff' : text,
    fontWeight: on ? 'bold' : 'normal',
  });
  const smallBtn: React.CSSProperties = {
    minWidth: 36, minHeight: 36, borderRadius: 8, border: `1px solid ${border}`, background: 'transparent', color: text, cursor: 'pointer', fontSize: 14,
  };

  const qs = value.questions;
  const setQ = (i: number, q: SurveyQuestion) => onChange({ v: 1, questions: qs.map((x, j) => (j === i ? q : x)) });
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= qs.length) return;
    const next = [...qs]; [next[i], next[j]] = [next[j], next[i]];
    onChange({ v: 1, questions: next });
  };
  const remove = (i: number) => onChange({ v: 1, questions: qs.filter((_, j) => j !== i) });
  const add = () => {
    if (qs.length >= SURVEY_LIMITS.questions) return;
    const q = emptyQuestion('single');
    onChange({ v: 1, questions: [...qs, q] });
    setOpenId(q.id);
  };

  const summaryOf = (q: SurveyQuestion) => {
    const parts = [SURVEY_KIND_LABEL[q.kind]];
    if (q.required) parts.push('必須');
    if (q.kind === 'single' || q.kind === 'multi') parts.push(`選択肢${q.options?.length ?? 0}つ${q.allow_other ? '＋その他' : ''}`);
    if (q.kind === 'date' && (q.date_from || q.date_to)) parts.push(`${q.date_from ? surveyDateLabel(q.date_from) : ''}〜${q.date_to ? surveyDateLabel(q.date_to) : ''}`);
    return parts.join('・');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {qs.map((q, i) => {
        const open = openId === q.id;
        const bad = problemIndex === i;
        return (
          <div key={q.id} style={{ border: `1.5px solid ${bad ? '#dc3545' : border}`, borderRadius: 10, background: cardBg, padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <button type="button" onClick={() => setOpenId(open ? null : q.id)}
                style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: text, minHeight: 36 }}>
                <div style={{ fontSize: 15, fontWeight: 'bold' }}>{i + 1}. {q.label.trim() || <span style={{ color: sub, fontWeight: 'normal' }}>（質問の文を入れてください）</span>}</div>
                <div style={{ fontSize: 12, color: sub, marginTop: 2 }}>{summaryOf(q)}</div>
              </button>
              <button type="button" aria-label="上へ" style={smallBtn} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" aria-label="下へ" style={smallBtn} disabled={i === qs.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button type="button" aria-label={open ? '閉じる' : '開く'} style={smallBtn} onClick={() => setOpenId(open ? null : q.id)}>{open ? '▲' : '▼'}</button>
            </div>

            {open && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 13, color: sub, marginBottom: 4 }}>答え方</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {KINDS.map(k => (
                      <button key={k} type="button" style={chip(q.kind === k)} onClick={() => setQ(i, changeKind(q, k))}>{SURVEY_KIND_LABEL[k]}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 13, color: sub, marginBottom: 4 }}>質問の文</div>
                  <input value={q.label} maxLength={SURVEY_LIMITS.label} onChange={e => setQ(i, { ...q, label: e.target.value })}
                    placeholder="例：11/22 の振り替えはどれにしますか？" style={inputStyle} />
                </div>
                <div>
                  <div style={{ fontSize: 13, color: sub, marginBottom: 4 }}>説明（任意）</div>
                  <input value={q.help ?? ''} maxLength={SURVEY_LIMITS.help} onChange={e => setQ(i, { ...q, help: e.target.value })}
                    placeholder="例：12月中に取れる日を選んでください" style={inputStyle} />
                </div>

                {(q.kind === 'single' || q.kind === 'multi') && (
                  <div>
                    <div style={{ fontSize: 13, color: sub, marginBottom: 4 }}>選択肢（2つ以上）</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {(q.options ?? []).map((o, oi) => {
                        const opts = q.options ?? [];
                        const setOpts = (next: typeof opts) => setQ(i, { ...q, options: next });
                        return (
                          <div key={o.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <input value={o.label} maxLength={SURVEY_LIMITS.optionLabel}
                              onChange={e => setOpts(opts.map((x, xi) => (xi === oi ? { ...x, label: e.target.value } : x)))}
                              placeholder={`選択肢 ${oi + 1}`} style={{ ...inputStyle, flex: 1 }} />
                            <button type="button" aria-label="上へ" style={smallBtn} disabled={oi === 0}
                              onClick={() => { const n = [...opts]; [n[oi - 1], n[oi]] = [n[oi], n[oi - 1]]; setOpts(n); }}>↑</button>
                            <button type="button" aria-label="下へ" style={smallBtn} disabled={oi === opts.length - 1}
                              onClick={() => { const n = [...opts]; [n[oi + 1], n[oi]] = [n[oi], n[oi + 1]]; setOpts(n); }}>↓</button>
                            <button type="button" aria-label="この選択肢を消す" style={smallBtn} disabled={opts.length <= 2}
                              onClick={() => setOpts(opts.filter((_, xi) => xi !== oi))}>✕</button>
                          </div>
                        );
                      })}
                    </div>
                    {(q.options?.length ?? 0) < SURVEY_LIMITS.options && (
                      <button type="button" style={{ ...tintBtn(isDark), marginTop: 6 }}
                        onClick={() => setQ(i, { ...q, options: [...(q.options ?? []), { id: newLocalId(), label: '' }] })}>＋ 選択肢を足す</button>
                    )}
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 14, color: text, minHeight: 36, cursor: 'pointer' }}>
                      <input type="checkbox" checked={!!q.allow_other} onChange={e => setQ(i, { ...q, allow_other: e.target.checked })} style={{ width: 20, height: 20 }} />
                      「その他（自由に書く）」も選べるようにする
                    </label>
                  </div>
                )}

                {q.kind === 'date' && (
                  <div>
                    <div style={{ fontSize: 13, color: sub, marginBottom: 4 }}>選べる日の範囲（任意）</div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input type="date" value={q.date_from ?? ''} onChange={e => setQ(i, { ...q, date_from: e.target.value || undefined })} style={{ ...inputStyle, flex: 1 }} />
                      <span style={{ color: sub }}>〜</span>
                      <input type="date" value={q.date_to ?? ''} onChange={e => setQ(i, { ...q, date_to: e.target.value || undefined })} style={{ ...inputStyle, flex: 1 }} />
                    </div>
                    <div style={{ fontSize: 12, color: sub, marginTop: 4 }}>回答する人は、この範囲の日をいくつでも選べます</div>
                  </div>
                )}

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: text, minHeight: 36, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!q.required} onChange={e => setQ(i, { ...q, required: e.target.checked })} style={{ width: 20, height: 20 }} />
                  必須（答えないと送れない）
                </label>
                <div style={{ textAlign: 'right' }}>
                  <button type="button" disabled={qs.length <= 1} onClick={() => remove(i)}
                    style={{ background: 'none', border: 'none', color: qs.length <= 1 ? sub : '#dc3545', cursor: qs.length <= 1 ? 'not-allowed' : 'pointer', fontSize: 13, padding: '6px 0' }}>
                    この質問を消す
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {qs.length < SURVEY_LIMITS.questions && (
        <button type="button" style={{ ...tintBtn(isDark), alignSelf: 'flex-start' }} onClick={add}>＋ 質問を足す</button>
      )}

      {visibility && onVisibility && (
        <div style={{ marginTop: 4 }}>
          <div style={{ fontSize: 13, color: sub, marginBottom: 4 }}>回答の見せ方</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {(Object.keys(SURVEY_VISIBILITY_LABEL) as SurveyVisibility[]).map(v => (
              <button key={v} type="button" style={chip(visibility === v)} onClick={() => onVisibility(v)}>{SURVEY_VISIBILITY_LABEL[v]}</button>
            ))}
          </div>
          <div style={{ fontSize: 12, color: sub, marginTop: 4 }}>
            {visibility === 'sender' && '回答を見られるのは、送った人・写し（CC）の代表者・管理者だけです。'}
            {visibility === 'respondents_count' && '回答した人は、選択肢ごとの数だけ見られます（だれが何と答えたかは見えません）。'}
            {visibility === 'respondents_named' && '回答した人は、ほかの人の回答を名前つきで見られます。回答する画面にもそのことを出します。'}
          </div>
        </div>
      )}
    </div>
  );
};

export default SurveyEditor;
