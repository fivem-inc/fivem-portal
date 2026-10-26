// 「休暇の種類のご案内」（2026-10-27 段2a・lib/leaveReplace）。上長からの「有休を時間外調整休に変更できることの案内」をご本人の残業ページに出すカード。
//
// 🚨 文言は 2026-10-27 ユーザー確定（法律の専門家2体のレビューのあと・何度も詰めた形）。勝手に足したり言い換えたりしないこと：
//    見出し「休暇の種類のご案内（◯◯さんから）」／「M月D日（曜）時点の残業時間は、下記のとおりです。」／
//    表（対象日・残業時間（期間）・時間外調整休に変更した場合。見込みは確定と違うときだけ下に小さく）／
//    「変更される場合は、「時間外調整休を申請する」を押してください。」「変更のご希望がなければ、有給休暇のままで問題ありません（不利益な取扱いはございません）。」
// 🚨 2つのボタンは同じ見た目にする（どちらかを勧めない・ユーザー確定）。どちらも押さなくてよい（押さなければ有給休暇のまま）
// 🚨 数字は開いたときに計算する（その日が入る給与期間の合計・lib/overtimeBalance の computeBalance＝残業ページの合計時間数と同じ）。
//    差し引く時間は呼ぶ側が渡す（その日の登録シフトの労働時間＝申請の画面の時間外調整休と同じ lib/overtimeShift）

import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { computeBalance, type BalanceRow } from '../lib/overtimeBalance';
import { calcPayPeriodStartJst, todayJstStr } from '../lib/breakCalc';
import { dismissAppRequest, type ReceivedAppRequest } from '../lib/appRequests';
import { mdDowShort, mdDowLong } from '../lib/leaveReplace';
import { resolveNormalShift, type PatternRow } from '../lib/overtimeShift';
import type { CalendarKind } from '../lib/breakCalc';

interface Props {
  r: ReceivedAppRequest;
  userId: string;
  isDark: boolean;
  /** 上長の確認の画面に出す見本（ボタンは押せない・2026-10-27 ユーザー確定「送る前に実際のカードを見せる」） */
  preview?: boolean;
  focused?: boolean;
  focusRef?: (el: HTMLDivElement | null) => void;
  onStart: () => void;
  /** ［有給休暇のままとする］が成立したあと（一覧から外す） */
  onKept: (r: ReceivedAppRequest) => void;
  onError: (message: string) => void;
}

/** 「12時間00分」。マイナスは「−3時間00分」 */
function hm(min: number): string {
  const sign = min < 0 ? '−' : '';
  const a = Math.abs(Math.round(min));
  return `${sign}${Math.floor(a / 60)}時間${String(a % 60).padStart(2, '0')}分`;
}

/** 給与期間の見出し「10/16〜11/15」 */
function periodLabel(start: string): string {
  const m = Number(start.slice(5, 7));
  const em = m === 12 ? 1 : m + 1;
  return `${m}/16〜${em}/15`;
}

const LeaveKindGuideCard: React.FC<Props> = ({ r, userId, isDark, preview = false, focused = false, focusRef, onStart, onKept, onError }) => {
  const date = (r.target_dates ?? [])[0] ?? '';
  const period = date ? calcPayPeriodStartJst(date) : '';
  const [leaveType, setLeaveType] = useState<string>('有給休暇');
  const [rows, setRows] = useState<BalanceRow[] | null>(null);
  // 差し引く時間＝その日の登録シフトの労働時間（申請の画面の時間外調整休と同じ lib/overtimeShift）
  const [shiftMinutes, setShiftMinutes] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!r.replaces_leave_id || !period) return;
    let alive = true;
    void (async () => {
      const [{ data: lv }, { data: ot, error }, { data: pat }, { data: cal }] = await Promise.all([
        supabase.from('leave_requests').select('leave_type').eq('id', r.replaces_leave_id).maybeSingle(),
        supabase.from('overtime_reports')
          .select('pay_period_start, status, entry_type, work_date, diff_minutes, application_types')
          .eq('applicant_id', userId)
          .eq('pay_period_start', period),
        supabase.from('weekly_shift_patterns').select('*').eq('user_id', userId),
        supabase.from('company_calendar').select('kind').eq('date', date).maybeSingle(),
      ]);
      if (!alive) return;
      setShiftMinutes(resolveNormalShift((pat as PatternRow[] | null) ?? [], date, ((cal as { kind?: CalendarKind } | null)?.kind ?? null)).labor_minutes);
      if (lv?.leave_type) setLeaveType(String(lv.leave_type));
      if (error) { console.error('[休暇の種類のご案内] 残業時間を読めませんでした', error.message); setRows([]); return; }
      setRows((ot ?? []) as BalanceRow[]);
    })();
    return () => { alive = false; };
  }, [r.replaces_leave_id, period, userId, date]);

  const b = rows ? computeBalance(rows, period) : null;
  const text = isDark ? '#dee2e6' : '#0d47a1';
  const btn: React.CSSProperties = {
    flex: 1, padding: '9px 0', borderRadius: 8, cursor: busy ? 'default' : 'pointer', fontSize: 12.5,
    background: isDark ? '#1b2a3a' : '#fff', border: `1px solid ${isDark ? '#90caf9' : '#1565c0'}`, color: isDark ? '#90caf9' : '#1565c0',
  };
  const row = (label: string, value: React.ReactNode, last = false) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '4px 0', borderBottom: last ? 'none' : `1px solid ${isDark ? '#2c3e50' : '#e3f2fd'}` }}>
      <span>{label}</span><span style={{ textAlign: 'right' }}>{value}</span>
    </div>
  );
  const amount = (total: number, planned: number) => (
    <>
      <b>{hm(total)}</b>
      {planned !== total && <><br /><span style={{ fontSize: 11.5 }}>見込み {hm(planned)}</span></>}
    </>
  );

  const keep = async () => {
    if (busy) return;
    setBusy(true);
    const fail = await dismissAppRequest(r, '有給休暇のまま');
    setBusy(false);
    if (fail) { onError(fail); return; }
    onKept(r);
  };

  return (
    <div ref={el => focusRef?.(el)}
      style={{ background: focused ? (isDark ? '#4a4423' : '#fff9c4') : (isDark ? '#243447' : '#e8f4fd'), border: `1px solid ${focused ? '#f59e0b' : (isDark ? '#3d5166' : '#90caf9')}`, borderRadius: 10, padding: '12px 14px', marginBottom: 8, color: text, lineHeight: 1.7, fontSize: 13, textAlign: 'left', transition: 'background 0.6s' }}>
      <b>休暇の種類のご案内（{r.requester_name ?? ''}さんから）</b>
      <div style={{ marginTop: 6, fontSize: 12.5 }}>{mdDowLong(todayJstStr())}時点の残業時間は、下記のとおりです。</div>
      <div style={{ background: isDark ? '#1b2a3a' : '#fff', borderRadius: 8, padding: '6px 10px', margin: '6px 0' }}>
        {row('対象日', `${date ? mdDowShort(date) : ''}${leaveType}`)}
        {row(`残業時間（${period ? periodLabel(period) : ''}）`, b ? amount(b.total, b.plannedTotal) : '…')}
        {row('時間外調整休に変更した場合', b ? amount(b.total - shiftMinutes, b.plannedTotal - shiftMinutes) : '…', true)}
      </div>
      <div style={{ fontSize: 12.5 }}>
        変更される場合は、「時間外調整休を申請する」を押してください。<br />
        変更のご希望がなければ、有給休暇のままで問題ありません（不利益な取扱いはございません）。
      </div>
      <div style={{ fontSize: 12, marginTop: 6 }}>※ このご案内は、変更の依頼ではありません。</div>
      {/* 🚨 2つのボタンは同じ見た目（どちらかを勧めない） */}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="button" data-net="write" onClick={preview ? undefined : keep} disabled={busy || preview} style={btn}>有給休暇のままとする</button>
        <button type="button" onClick={preview ? undefined : onStart} disabled={busy || preview} style={btn}>時間外調整休を申請する</button>
      </div>
    </div>
  );
};

export default LeaveKindGuideCard;
