// 経理の「ここまで確認した」の印（2026-10-26・「受理済みの変更」のタブ）。
// Excel・CSV を出したとき、その給与期間に印を残す（その時刻より後の変更が「未確認」になる）。
// 🚨 印が残せなくても出力は止めない（理由は console にだけ）。印を残せるのは管理者だけ（DB の payroll_check_mark）
import { supabase } from './supabaseClient';

export type PayrollCheckKind = 'excel_overtime' | 'excel_shift' | 'list_overtime' | 'list_shift' | 'expense' | 'change_log_excel' | 'manual';

export const PAYROLL_CHECK_KIND_LABEL: Record<PayrollCheckKind, string> = {
  excel_overtime: '残業の表を Excel で出したとき',
  excel_shift: '勤務変更の表を Excel で出したとき',
  list_overtime: '残業の一覧を Excel で出したとき',
  list_shift: '勤務変更の一覧を CSV で出したとき',
  expense: '交通費を CSV で出したとき',
  change_log_excel: 'この一覧を Excel で出したとき',
  manual: '［確認済みにする］を押したとき',
};

/** 印を残す。period は給与期間の初日（16日） */
export async function recordPayrollCheck(period: string, kind: PayrollCheckKind, opts?: { upto?: string; count?: number }): Promise<{ id: string } | null> {
  if (!/^\d{4}-\d{2}-16$/.test(period)) return null;
  const { data, error } = await supabase.rpc('payroll_check_mark', {
    p_period: period, p_kind: kind, p_upto: opts?.upto ?? null, p_count: opts?.count ?? null,
  });
  if (error) {
    console.error('[確認の印] 残せませんでした:', error.message);
    return null;
  }
  return (data as { id: string } | null) ?? null;
}
