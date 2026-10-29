// 連絡板のアンケート：回答の見せ方（2026-10-29・見本の③の中身）。
// 送った人の一覧（SurveyResultsPanel）と、回答した人どうしで見る画面（SurveyAnswerForm の［みんなの回答を見る］）の2か所が使う。
// 🚨 何を返すか（だれに何を見せるか）は DB の board_survey_results が決める。ここは届いたものを並べるだけ

import React from 'react';
import { type SurveyDef, answerText, surveyDateLabel, tallyAnswers, OTHER_ID } from '../../lib/boardSurvey';
import type { SurveyResults, SurveyResultRow } from '../../lib/boardSurveyApi';

interface Props {
  survey: SurveyDef;
  results: SurveyResults;
  isDark: boolean;
  profiles: { id: string; name: string | null }[];
  /** 人ごとのカードに出す行（送った人の画面が絞り込みに使う）。省略なら全員 */
  rows?: SurveyResultRow[];
}

const fmtWhen = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const SurveyResultsView: React.FC<Props> = ({ survey, results, isDark, profiles, rows }) => {
  const text = isDark ? '#f8f9fa' : '#212529';
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const cardBg = isDark ? '#2b3035' : '#fff';

  const counts = results.mode === 'count' ? results.counts : tallyAnswers(survey, results.rows);
  const respondents = results.mode === 'count' ? results.respondents : results.rows.length;
  const nameOf = (r: SurveyResultRow) => r.name || profiles.find(p => p.id === r.user_id)?.name || '不明';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* まとめ（選択肢・日付の数） */}
      <div style={{ padding: '10px 12px', borderRadius: 10, border: `1px solid ${border}`, background: cardBg }}>
        <div style={{ fontSize: 13, color: sub, marginBottom: 6 }}>まとめ（回答 {respondents}人）</div>
        {survey.questions.map((q, i) => {
          if (q.kind === 'text') return null;
          const c = counts[q.id] ?? {};
          const items: { label: string; n: number }[] = q.kind === 'date'
            ? Object.keys(c).sort().map(d => ({ label: surveyDateLabel(d), n: c[d] }))
            : [...(q.options ?? []).map(o => ({ label: o.label, n: c[o.id] ?? 0 })), ...(q.allow_other ? [{ label: 'その他', n: c[OTHER_ID] ?? 0 }] : [])];
          return (
            <div key={q.id} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 14, color: text, fontWeight: 'bold' }}>{i + 1}. {q.label}</div>
              {items.length === 0
                ? <div style={{ fontSize: 13, color: sub }}>（まだありません）</div>
                : <div style={{ fontSize: 14, color: text }}>{items.map(x => `${x.label} ${x.n}`).join('・')}</div>}
            </div>
          );
        })}
        {results.mode === 'count' && survey.questions.some(q => q.kind === 'text') && (
          <div style={{ fontSize: 12, color: sub }}>文字で書く質問の回答は、送った人だけが見られます。</div>
        )}
      </div>

      {/* 人ごと */}
      {results.mode !== 'count' && (rows ?? results.rows).map(r => (
        <div key={r.user_id} style={{ padding: '10px 12px', borderRadius: 10, border: `1px solid ${border}`, background: cardBg }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <span style={{ fontSize: 15, fontWeight: 'bold', color: text }}>{nameOf(r)}</span>
            {results.mode === 'full' && (
              <span style={{ fontSize: 12, color: sub }}>
                {fmtWhen(r.answered_at)}
                {(r.edit_count ?? 0) > 0 && `・${fmtWhen(r.updated_at)} 直した`}
                {r.is_late && <span style={{ marginLeft: 6, padding: '1px 8px', borderRadius: 10, border: `1px solid ${border}`, color: text }}>期限後</span>}
              </span>
            )}
          </div>
          {survey.questions.map((q, i) => (
            <div key={q.id} style={{ marginTop: 4 }}>
              <span style={{ fontSize: 12, color: sub }}>{i + 1}. {q.label}：</span>
              <span style={{ fontSize: 14, color: text, whiteSpace: 'pre-wrap' }}>{answerText(q, r.answers?.[q.id]) || '—'}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
};

export default SurveyResultsView;
