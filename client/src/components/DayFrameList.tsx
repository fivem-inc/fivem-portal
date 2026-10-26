import React from 'react';
import type { CalendarKind } from '../lib/breakCalc';
import { CALENDAR_CELL_STYLE } from '../hooks/useCompanyCalendar';
import { leaveDateList } from '../lib/leaveDates';
import { COMPANY_LABEL, leaveTypeText, visibleLeavesOn, type SheetLeave } from '../lib/payrollSheet';
import { statusLabel } from '../lib/applicationStatus';

/**
 * 残業の履歴（本人の［履歴］・部門集計の人の画面）に、休暇と会社の予定を足す部品（2026-10-26 ユーザー確定）。
 * ・休暇は日付の順に「休暇：有給休暇」の薄いピンクのカードで並べる（見るだけ）
 * ・会社の予定（会社休・休館・有休奨励日）の日に申請・休暇があれば、その日の分を枠で囲む（見出しは「10/31（土）休館・有休奨励日」）
 *   🚨 申請の無い日は枠を出さない（ユーザー確定 案B「出たものだけ」）
 * 🚨 休暇の出し分け（受理済みの時間外調整休は残業の側の「休暇から自動」と二重になるので出さない）は lib/payrollSheet の visibleLeavesOn 1か所
 */

export type DayUnit<T> = { date: string; key: string; rep?: T; leave?: SheetLeave };

/** 申請の並び（並び替え済み）に、休暇の日を日付の順で差し込む。asc＝古い順 */
export function mergeLeaveUnits<T>(reps: T[], dateOf: (r: T) => string, keyOf: (r: T) => string,
  leaves: SheetLeave[], userId: string, inRange: (d: string) => boolean, asc: boolean): DayUnit<T>[] {
  const leaveUnits: DayUnit<T>[] = [];
  const dates = new Set<string>();
  for (const l of leaves) for (const d of leaveDateList(l.leave_dates, l.start_date, l.end_date)) if (inRange(d)) dates.add(d);
  for (const d of dates) for (const l of visibleLeavesOn(leaves, userId, d)) leaveUnits.push({ date: d, key: `lv-${l.id}-${d}`, leave: l });
  leaveUnits.sort((a, b) => (asc ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)));
  const out: DayUnit<T>[] = [];
  let i = 0;
  const before = (a: string, b: string) => (asc ? a <= b : a >= b);   // 同じ日は休暇を先に
  for (const r of reps) {
    const d = dateOf(r);
    while (i < leaveUnits.length && before(leaveUnits[i].date, d)) out.push(leaveUnits[i++]);
    out.push({ date: d, key: keyOf(r), rep: r });
  }
  while (i < leaveUnits.length) out.push(leaveUnits[i++]);
  return out;
}

/** 続いた同じ日を1つにまとめる */
export function groupUnitsByDay<T>(units: DayUnit<T>[]): { date: string; units: DayUnit<T>[] }[] {
  const out: { date: string; units: DayUnit<T>[] }[] = [];
  for (const u of units) {
    const last = out[out.length - 1];
    if (last && last.date === u.date) last.units.push(u); else out.push({ date: u.date, units: [u] });
  }
  return out;
}

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const mdDow = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return `${m}/${dd}（${DOW[new Date(y, m - 1, dd).getDay()]}）`; };

/** 会社の予定の日の枠。中に、その日の申請・休暇のカードを入れる */
export const DayFrame: React.FC<{ date: string; kind: CalendarKind; children: React.ReactNode }> = ({ date, kind, children }) => {
  const st = CALENDAR_CELL_STYLE[kind];
  return (
    <div style={{ border: `1.5px solid ${st.text}55`, borderRadius: 10, marginBottom: 10, overflow: 'hidden', textAlign: 'left' }}>
      <div style={{ background: st.bg, color: st.text, fontSize: 12.5, fontWeight: 'bold', padding: '5px 10px' }}>
        {mdDow(date)}　{COMPANY_LABEL[kind]}
      </div>
      <div style={{ padding: '8px 8px 0' }}>{children}</div>
    </div>
  );
};

/** 休暇のカード（見るだけ）。onOpen があれば［休暇申請で見る ›］ */
export const LeaveCard: React.FC<{ leave: SheetLeave; date: string; isDark: boolean; showDate: boolean; onOpen?: () => void }> = ({ leave, date, isDark, showDate, onOpen }) => {
  const ok = leave.status === 'approved';
  const fg = isDark ? '#f4c0d1' : '#72243e';
  return (
    <div style={{ border: `1px solid ${isDark ? '#6b3a4c' : '#f4c0d1'}`, background: isDark ? '#3a2a33' : '#fbeaf0', color: fg, borderRadius: 10, padding: '9px 12px', marginBottom: 8, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', textAlign: 'left' }}>
      <span style={{ fontSize: 11, fontWeight: 'bold', background: isDark ? '#4b1528' : '#fff', border: `1px solid ${isDark ? '#6b3a4c' : '#f4c0d1'}`, borderRadius: 10, padding: '1px 8px' }}>休暇</span>
      {showDate && <span style={{ fontWeight: 'bold' }}>{mdDow(date)}</span>}
      <span>休暇：{leaveTypeText(leave)}</span>
      <span style={{ fontSize: 12, opacity: ok ? 1 : 0.85 }}>{ok ? '受理済み' : statusLabel('leave', leave.status)}</span>
      {onOpen && (
        <button type="button" onClick={onOpen}
          style={{ marginLeft: 'auto', background: 'none', border: 'none', padding: 0, color: fg, textDecoration: 'underline', fontSize: 12, cursor: 'pointer' }}>
          休暇申請で見る ›
        </button>
      )}
    </div>
  );
};

/** 1日分（会社の予定の日なら枠で囲む） */
export function renderDayGroup<T>(g: { date: string; units: DayUnit<T>[] }, kind: CalendarKind | null | undefined,
  renderRep: (r: T) => React.ReactNode, isDark: boolean, onOpenLeave?: (l: SheetLeave) => void): React.ReactNode {
  const body = g.units.map(u => u.rep !== undefined
    ? <React.Fragment key={u.key}>{renderRep(u.rep)}</React.Fragment>
    : <LeaveCard key={u.key} leave={u.leave!} date={u.date} isDark={isDark} showDate={!kind} onOpen={onOpenLeave ? () => onOpenLeave(u.leave!) : undefined} />);
  if (!kind) return <React.Fragment key={`d-${g.date}-${g.units[0].key}`}>{body}</React.Fragment>;
  return <DayFrame key={`f-${g.date}-${g.units[0].key}`} date={g.date} kind={kind}>{body}</DayFrame>;
}
