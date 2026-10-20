import React, { useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { partialToggleCase, type PartialToggleReport } from '../lib/partialShiftAdjust';
import type { PartialSlot } from '../hooks/usePartialSlotMap';

// 受理済みの遅出・早退・勤務地変更の申請で「シフト調整」をあとから変える欄（2026-10-20 ユーザー確定）。
//   シフト調整：調整不要  ［必要に変える］
//   シフト調整：必要（相談あり）  ［調整不要に変える］
// ・残業申請の受理は申請先1人だけなので、申請先がリーダーだとマネージャーに受理の場面が無い → ここで変えられるようにする
// ・変えられるのはシフト調整の権限（leave_shift_adjust）がある人。いない時間が始まる前まで（細かい時刻の判定は DB の関数）
// ・書き込みは DB の overtime_set_shift_adjust_needed 1か所（見張り・相談の作り直しも DB）
// ・置き場所：残業の部門集計の人の詳細／管理画面の残業の一覧。読み込みは usePartialSlotMap で1回にまとめる（行ごとに読まない）

const PartialShiftToggle: React.FC<{
  report: PartialToggleReport;
  slot: PartialSlot | undefined;
  canChange: boolean;
  isDark: boolean;
  onChanged: () => void;
}> = ({ report, slot, canChange, isDark, onChanged }) => {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!partialToggleCase(report)) return null;
  // 同じ日に休暇などの相談があるときは、そちらで扱う（欄を出さない）
  if (slot && slot.cause !== 'ot_partial') return null;
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const active = !!slot && ['pending', 'working'].includes(slot.status);
  const decided = !!slot && slot.status === 'decided';
  const label = decided ? '調整済み'
    : active ? `必要（相談あり・${slot!.status === 'working' ? '調整中' : '未調整'}）`
    : '調整不要';
  const toNeeded = !active && !decided;
  const change = async () => {
    setBusy(true); setErr('');
    const { data, error } = await supabase.rpc('overtime_set_shift_adjust_needed', { p_report_id: report.id, p_needed: toNeeded });
    setBusy(false);
    const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; reason?: string | null } | null;
    if (error || !row?.ok) { setErr(row?.reason ?? error?.message ?? '変えられませんでした'); return; }
    onChanged();
  };
  return (
    <div style={{ marginTop: 4, fontSize: 12, color: sub, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span>シフト調整：{label}</span>
      {canChange && !decided && (
        <button type="button" onClick={change} disabled={busy}
          style={{ padding: '3px 10px', borderRadius: 12, fontSize: 11.5, fontWeight: 'bold', border: 'none', cursor: busy ? 'default' : 'pointer',
            background: isDark ? '#1e3a5f' : '#e3f2fd', color: isDark ? '#90caf9' : '#1565c0', opacity: busy ? 0.6 : 1 }}>
          {busy ? '変えています…' : (toNeeded ? '必要に変える' : '調整不要に変える')}
        </button>
      )}
      {err && <span style={{ color: '#dc3545' }}>{err}</span>}
    </div>
  );
};

export default PartialShiftToggle;
