// 勤務変更の［履歴］の表（2026-11-05・残業の表と同じ形・権限 shift_report_calendar）
// ・1日1行。予定と報告が両方ある日だけ2段（1段目 灰色「予定 …」・2段目「報告 …」）。片方だけは1段で頭に「予定」「報告」
// ・状況の丸：済＝受理／待＝確認待ち／戻＝差し戻し／消＝取消／未＝予定だけで、まだ報告していない（「予」は残業の事前申請 受理済み＝使わない）
// ・「差」（いつものシフトとの差・shiftReportDiff）の列は、上長が人を選んで見るときだけ（showDiff）
// ・行を押すとカードの表示に移る（components/historyTable・URL の印 srday・目印 sr-row-）
// 🚨 予定の状態は lib/shiftReportTodo の classifyEntry 1か所（呼ぶ側が渡す）。種類は照合しない（日付だけ）
import React from 'react';
import type { CalendarEntry, EntryState } from '../lib/shiftReportTodo';
import { planText, SrPill } from './ShiftCalendarPlan';
import { shiftReportDiff, type ShiftDiffRow } from '../lib/shiftCalc';

export interface SrTableDay<R> { date: string; reports: R[]; plans: CalendarEntry[]; planState: EntryState | null }

type Mark = '受' | '済' | '待' | '戻' | '消' | '未';
const MARK_STYLE: Record<Mark, { label: string; color: string; bg: string; darkColor: string; darkBg: string }> = {
  受: { label: '受理済み（あとで報告）', color: '#0c447c', bg: '#e6f1fb', darkColor: '#90caf9', darkBg: '#1e3a5f' },
  済: { label: '受理', color: '#27500a', bg: '#e3f2e3', darkColor: '#a5d6a7', darkBg: '#1b3a1f' },
  待: { label: '確認待ち', color: '#854f0b', bg: '#fff3cd', darkColor: '#ffe082', darkBg: '#3d3420' },
  戻: { label: '差し戻し', color: '#9d174d', bg: '#fce7f3', darkColor: '#f48fb1', darkBg: '#3a2030' },
  消: { label: '取消', color: '#555', bg: '#eee', darkColor: '#bbb', darkBg: '#3d4349' },
  未: { label: 'まだ報告していない', color: '#a32d2d', bg: '#fde2e2', darkColor: '#f5b5b5', darkBg: '#5c2b2b' },
};
// 事前申請（2026-11-06）：受理済みは「受」・その日が過ぎても報告が無ければ「未」・受理待ちは「待」
const todayJst = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
const markOf = (status: string, date: string): Mark =>
  status === 'request_confirmed' ? (date < todayJst() ? '未' : '受')
  : status === 'confirmed' ? '済' : status === 'returned' ? '戻' : status === 'cancelled' ? '消' : '待';
const isAdvanceOpen = (status: string) => status === 'requested' || status === 'request_confirmed';

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const mdDow = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return `${m}/${dd}${DOW[new Date(y, m - 1, dd).getDay()]}`; };
const fmtDiff = (m: number) => `${m > 0 ? '+' : m < 0 ? '−' : ''}${Math.floor(Math.abs(m) / 60)}:${String(Math.abs(m) % 60).padStart(2, '0')}`;
const CSS = '.sr-tbl td.sr-c{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}@media (min-width:600px){.sr-tbl td.sr-c{white-space:normal}}';

function ShiftReportHistoryTable<R extends ShiftDiffRow & { status: string; planned?: unknown }>({ days, showDiff, isDark, text, subText, borderColor, onPick, reportText, plannedText, between, dayNote }: {
  days: SrTableDay<R>[];
  showDiff: boolean;
  isDark: boolean; text: string; subText: string; borderColor: string;
  onPick: (date: string) => void;
  /** 報告の中身（種類 時刻）。呼ぶ側の書き方（TYPE_INFO）を使う */
  reportText: (r: R) => string;
  /** 事前申請の中身（受理されたときの写し）。報告のあとに「申請」の段として出す */
  plannedText?: (r: R) => string | null;
  /** 報告も予定も無い日に出す文（いつものシフト・休み・会社休）。無ければ — */
  dayNote?: (date: string) => string;
  /** 日の前に挟む行（期ごとの見出し） */
  between?: (d: SrTableDay<R>, i: number) => React.ReactNode;
}) {
  if (days.length === 0) return null;
  const cols = showDiff ? 4 : 3;
  const th: React.CSSProperties = { padding: '5px 4px', fontSize: 11.5, fontWeight: 'bold', color: subText, background: isDark ? '#343a40' : '#f1f3f5' };
  const td: React.CSSProperties = { padding: '6px 4px', verticalAlign: 'top', fontSize: 12.5, lineHeight: 1.45 };
  const dowColor = (d: string): string | undefined => {
    const [y, m, dd] = d.split('-').map(Number); const w = new Date(y, m - 1, dd).getDay();
    return w === 0 ? (isDark ? '#ef9a9a' : '#c62828') : w === 6 ? (isDark ? '#90caf9' : '#1565c0') : undefined;
  };
  const mark = (k: Mark) => {
    const st = MARK_STYLE[k];
    return (
      <span title={st.label} aria-label={st.label}
        style={{ display: 'inline-block', width: 20, height: 20, lineHeight: '20px', borderRadius: '50%', textAlign: 'center', fontSize: 11, fontWeight: 'bold', background: isDark ? st.darkBg : st.bg, color: isDark ? st.darkColor : st.color }}>{k}</span>
    );
  };
  const used = new Set<Mark>();
  for (const d of days) {
    for (const r of d.reports) used.add(markOf(r.status, d.date));
    if (d.reports.length === 0 && d.planState === 'todo') used.add('未');
  }
  const legend = (['受', '済', '待', '戻', '消', '未'] as Mark[]).filter(k => used.has(k));
  const small = { fontSize: 11, color: subText } as const;
  return (
    <>
      <style>{CSS}</style>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', fontSize: 11.5, color: subText, margin: '0 0 6px', alignItems: 'center' }}>
        {legend.map(k => <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>{mark(k)}{MARK_STYLE[k].label}</span>)}
        <span>行を押すと詳しく見られます</span>
      </div>
      <table className="sr-tbl" style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', color: text, textAlign: 'left', marginBottom: 12 }}>
        <thead>
          <tr>
            <th style={{ ...th, width: 52, textAlign: 'left' }}>日付</th>
            <th style={{ ...th, textAlign: 'left' }}>内容</th>
            {showDiff && <th style={{ ...th, width: 50, textAlign: 'right' }}>差</th>}
            <th style={{ ...th, width: 26, textAlign: 'center' }}>状</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d, i) => {
            const r = d.reports[0];
            const planOnly = !r && d.plans.length > 0;
            const empty = !r && d.plans.length === 0;
            const settled = r?.status === 'confirmed';
            // 事前申請のまま（受理待ち・報告待ち）は差を（ ）で囲む＝合計に入れない
            // 🚨 欠勤の報告は変更前（いつものシフト）が空のことが多く、差が 0:00 に見える（2026-10-22 の［表で見る］と同じ）→ そのときは —
            const dd = r && r.status !== 'cancelled' && r.status !== 'returned' ? shiftReportDiff(r) : null;
            const isAbs = !!r && (r.application_types?.length ? r.application_types : [r.application_type]).includes('absence');
            const diff = dd && !(isAbs && dd.original === 0) ? dd.diff : null;
            return (
              <React.Fragment key={`sr-${d.date}`}>
                {between && (() => { const node = between(d, i); return node ? <tr><td colSpan={cols} style={{ padding: 0 }}>{node}</td></tr> : null; })()}
                <tr id={`sr-row-${d.date}`} onClick={empty ? undefined : () => onPick(d.date)}
                  style={{ borderTop: `1px solid ${borderColor}`, cursor: empty ? 'default' : 'pointer', background: planOnly ? (isDark ? '#3d3420' : '#fffaf0') : undefined, color: !r || settled ? text : subText }}>
                  <td style={{ ...td, whiteSpace: 'nowrap', fontSize: 12, color: dowColor(d.date) ?? (empty ? subText : undefined) }}>{mdDow(d.date)}</td>
                  <td className="sr-c" style={td}>
                    {empty && <span style={{ color: subText }}>{dayNote?.(d.date) || '—'}</span>}
                    {r && d.plans.map((p, j) => <div key={j} className="sr-c" style={{ ...small, overflow: 'hidden', textOverflow: 'ellipsis' }}><SrPill label="上長が入力" isDark={isDark} />{planText(p)}</div>)}
                    {r && !isAdvanceOpen(r.status) && plannedText?.(r) && <div className="sr-c" style={{ ...small, overflow: 'hidden', textOverflow: 'ellipsis' }}><SrPill label="申請" isDark={isDark} />{plannedText(r)}</div>}
                    {r && <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}><SrPill label={isAdvanceOpen(r.status) ? '申請' : '報告'} isDark={isDark} />{reportText(r)}</div>}
                    {r && markOf(r.status, d.date) === '未' && <div style={{ fontSize: 11, color: isDark ? '#f5b5b5' : '#a32d2d' }}>報告してください</div>}
                    {r && r.status === 'cancelled' && d.plans.length > 0 && <div style={small}>報告は取り消し済み（出し直しは管理者へ）</div>}
                    {planOnly && d.plans.map((p, j) => <div key={j} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}><SrPill label="上長が入力" isDark={isDark} />{planText(p)}</div>)}
                    {planOnly && d.planState === 'todo' && <div style={{ fontSize: 11, color: isDark ? '#f5b5b5' : '#a32d2d' }}>報告してください</div>}
                  </td>
                  {showDiff && (
                    <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap', fontSize: 12, fontWeight: settled ? 600 : 400, color: diff == null ? subText : undefined }}>
                      {diff == null ? (empty ? '' : '—') : settled ? fmtDiff(diff) : `(${fmtDiff(diff)})`}
                    </td>
                  )}
                  <td style={{ ...td, textAlign: 'center' }}>{r ? mark(markOf(r.status, d.date)) : planOnly && d.planState === 'todo' ? mark('未') : null}</td>
                </tr>
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

export default ShiftReportHistoryTable;
export { fmtDiff as fmtShiftDiff };
