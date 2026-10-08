// 勤務変更：カレンダーに入っている予定（まだ出していない分）の一覧（2026-10-05・第1段階）
//
// ・上長が勤怠カレンダーに入れた自分の予定のうち、まだ勤務変更を出していない日を並べる。［内容を確認］でフォームが入力済みで開く（2026-10-05：［出す］から改名＝送信と間違えないように）
// ・判定は lib/shiftReportTodo.ts（buildTodo）の1か所
// ・0件のときは何も出さない（パートの方の多くは、ふだん0件）。4件以上は3件だけ出して［ほかに◯件］
// ・予定が違うときの出口の一文を常に出す（本人はカレンダーを消せないため・UX レビュー）
// 🚨 自分の attendance_exceptions は本人が読める（RLS「Users can view own attendance_exceptions」）
// ・権限管理の「勤務変更：カレンダーの予定の一覧」で出し分ける（2026-10-05・最初はマネージャー以上だけ）。
//   承認者（マネージャー以上など）は「だれの予定を見るか」でパートの方を選べる（勤怠入力・承認者は全員の予定と勤務変更を読める）

import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { ABSENCE_LABEL } from '../lib/attendanceTypes';
import { buildTodo, todoFromDate, type CalendarEntry, type TodoItem } from '../lib/shiftReportTodo';
import { calcPayPeriodStartJst, payPeriodCloseCutoff, todayJstStr } from '../lib/breakCalc';

const mdw = (ymd: string) => {
  const d = new Date(`${ymd}T12:00:00+09:00`);
  return `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}（${'日月火水木金土'[d.getUTCDay()]}）`;
};

const ShiftReportTodo: React.FC<{
  userId: string;
  /** 自分の勤務変更がある勤務日（自分の予定を見るとき） */
  reportedDates: Set<string>;
  refreshKey: number;
  isDark: boolean;
  /** パートの方を選んでその人の予定を見られるか（承認者） */
  canPickOthers: boolean;
  onPick: (item: TodoItem, applicantId: string) => void;
  onCount?: (n: number) => void;
  /** 「だれの予定を見るか」を変えたとき（下のフォームと食い違わないように、入れていた中身を消すため） */
  onTargetChange?: (applicantId: string) => void;
  /** だれの予定を見るか（ページが持つ値・下のフォームの「対象スタッフ」と同じ） */
  targetId?: string;
}> = ({ userId, reportedDates, refreshKey, isDark, canPickOthers, onPick, onCount, onTargetChange, targetId: targetIdProp }) => {
  const [entries, setEntries] = useState<CalendarEntry[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const today = todayJstStr();
  // だれの予定を見るか（承認者だけ）。既定は自分
  const [innerTarget, setTargetId] = useState(userId);
  const targetId = targetIdProp ?? innerTarget;
  const [partList, setPartList] = useState<{ id: string; name: string }[]>([]);
  const [otherReported, setOtherReported] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!canPickOthers) return;
    supabase.from('profiles').select('id, name').eq('is_active', true).eq('employment_type', 'パート').order('name')
      .then(({ data, error }) => { if (!error) setPartList((data ?? []) as { id: string; name: string }[]); });
  }, [canPickOthers]);
  useEffect(() => {
    if (targetId === userId) { setOtherReported(null); return; }
    let alive = true;
    supabase.from('shift_reports').select('work_date').eq('applicant_id', targetId).gte('work_date', todoFromDate(today))
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) { console.error('[shift-report] 勤務変更を読めませんでした:', error.message); setOtherReported(new Set()); return; }
        setOtherReported(new Set(((data ?? []) as { work_date: string }[]).map(r => r.work_date)));
      });
    return () => { alive = false; };
  }, [targetId, userId, today, refreshKey]);

  useEffect(() => {
    let alive = true;
    supabase.from('attendance_exceptions').select('date, type, location, work_segments, notes, planned_break_minutes')
      .eq('user_id', targetId).gte('date', todoFromDate(today)).lte('date', today)
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) { console.error('[shift-report] カレンダーの予定を読めませんでした:', error.message); setEntries([]); return; }
        setEntries((data ?? []) as CalendarEntry[]);
      });
    return () => { alive = false; };
  }, [targetId, today, refreshKey]);

  const items = useMemo(
    () => buildTodo(entries ?? [], targetId === userId ? reportedDates : (otherReported ?? new Set<string>()), today),
    [entries, targetId, userId, reportedDates, otherReported, today]);
  useEffect(() => { onCount?.(items.length); }, [items.length, onCount]);
  const picker = canPickOthers && (
    <div style={{ fontSize: 13, margin: '0 0 6px' }}>
      だれの予定を見るか{' '}
      <select value={targetId} onChange={e => { setTargetId(e.target.value); setShowAll(false); onTargetChange?.(e.target.value); }}
        style={{ padding: '4px 6px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13, background: isDark ? '#495057' : '#fff', color: isDark ? '#fff' : '#000' }}>
        <option value={userId}>自分</option>
        {partList.filter(p => p.id !== userId).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </div>
  );
  // 承認者は0件でも枠を出す（選び替えられるように）。パートの方は0件なら何も出さない
  if (!entries || (items.length === 0 && !canPickOthers)) return null;
  if (items.length === 0) {
    return (
      <div style={{ border: `1px dashed ${isDark ? '#6b5a2a' : '#f5c26b'}`, borderRadius: 10, padding: '10px 14px', marginBottom: 16, textAlign: 'left', fontSize: 13, color: isDark ? '#adb5bd' : '#666' }}>
        <div style={{ fontWeight: 'bold', color: isDark ? '#fff' : '#1a1a2e', marginBottom: 4 }}>📋 未報告の勤務変更</div>
        {picker}
        {targetId === userId ? '自分の予定はありません。パートの方を選ぶと、その人の画面と同じ一覧が見られます。' : 'この方の未報告の勤務変更はありません。'}
      </div>
    );
  }

  const deadline = payPeriodCloseCutoff(calcPayPeriodStartJst(items[0].date));
  const shown = showAll ? items : items.slice(0, 3);
  const text = isDark ? '#fff' : '#1a1a2e';
  const sub = isDark ? '#adb5bd' : '#666';
  const border = isDark ? '#6b5a2a' : '#f5c26b';

  return (
    <div style={{ border: `2px solid ${border}`, background: isDark ? '#3d3420' : '#fffaf0', borderRadius: 10, padding: '12px 14px', marginBottom: 16, textAlign: 'left', color: text }}>
      <div style={{ fontWeight: 'bold', fontSize: 14 }}>📋 未報告の勤務変更（{items.length}件）</div>
      {picker}
      <div style={{ fontSize: 12.5, color: sub, margin: '2px 0 8px' }}>予定として登録済み｜締め切り {mdw(deadline)}{targetId !== userId ? '（［内容を確認］から送ると代理報告になります）' : ''}</div>
      {shown.map(it => {
        const segs = it.segments.filter(s => s.start && s.end);
        const time = segs.length ? `${segs[0].start}〜${segs[segs.length - 1].end}` : '';
        const loc = segs.length ? [...new Set(segs.map(s => s.location).filter(Boolean))].join('→') : (it.location ?? '');
        return (
          <div key={it.date} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderTop: `1px solid ${isDark ? '#5a4d2a' : '#f3e2bf'}`, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 'bold', minWidth: 78 }}>{mdw(it.date)}</span>
            <span style={{ fontWeight: 'bold' }}>{ABSENCE_LABEL[it.calendarType] ?? it.calendarType}</span>
            <span style={{ fontSize: 13, color: sub }}>{[time, loc].filter(Boolean).join(' ')}</span>
            <button type="button" onClick={() => onPick(it, targetId)}
              style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 8, border: 'none', background: '#1976d2', color: '#fff', fontWeight: 'bold', fontSize: 13, cursor: 'pointer' }}>
              内容を確認 ›
            </button>
          </div>
        );
      })}
      {items.length > 3 && (
        <button type="button" onClick={() => setShowAll(v => !v)}
          style={{ background: 'none', border: 'none', padding: '4px 0', color: isDark ? '#90caf9' : '#1565c0', fontSize: 13, cursor: 'pointer', textDecoration: 'underline' }}>
          {showAll ? '▲ 閉じる' : `▼ ほかに${items.length - 3}件`}
        </button>
      )}
      <div style={{ fontSize: 12, color: sub, marginTop: 6, lineHeight: 1.6 }}>
        内容が違うときは、送信せずに担当のリーダー・マネージャーにお知らせください。
      </div>
    </div>
  );
};

export default ShiftReportTodo;
