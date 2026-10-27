// 休暇申請と残業申請の終日の休み（時間外調整休・振替休日・欠勤）が、同じ日に重ならないようにする（2026-10-19 ユーザー確定・文は案1）
// ・止めるのは DB（migration 20261019123153 のトリガー）。止めたときは 'DAYOFF_CONFLICT|<文>' を投げる
// ・送る前の確かめは DB の my_day_off_conflict（文はトリガーと同じ関数が作る）
// 🚨 文と呼び名は DB の1か所だけ。画面に同じ表を書かない
// 🚨 文を取り出す dayOffConflictText は supabase を読まない別のファイル（lib/dayOffConflictText）

import { supabase } from './supabaseClient';

export { dayOffConflictText } from './dayOffConflictText';

/**
 * 送る前の確かめ。重なっていれば案内の文、無ければ null。
 * side='overtime'：kind＝残業申請の終日の種類（chosei_off／furikae_off／ot_absence）
 * side='leave'   ：kind＝休暇の種類（有給休暇・調整休 など）。encouragement＝有休奨励日の回答か
 * 🚨 読めなかったときは null（送らせる）。最後は DB のトリガーが止めるので、ここで止め過ぎない
 */
export async function checkDayOffConflict(dates: string[], side: 'overtime' | 'leave', kind: string, encouragement = false, skipLeaveId?: string | null, skipOtId?: string | null): Promise<string | null> {
  if (dates.length === 0 || !kind) return null;
  // skipLeaveId：有休を時間外調整休に変更する申請のとき、その有休は重なりに数えない（2026-10-27 段2a・DB も同じ）
  // skipOtId：時間外調整休を有休に変更する申請のとき、その時間外調整休は重なりに数えない（2026-10-27 段2b・DB も同じ）
  const { data, error } = await supabase.rpc('my_day_off_conflict', { p_dates: dates, p_side: side, p_kind: kind, p_encouragement: encouragement, ...(skipLeaveId ? { p_skip_leave: skipLeaveId } : {}), ...(skipOtId ? { p_skip_ot: skipOtId } : {}) });
  if (error) { console.error('[重なりの確かめ]', error.message); return null; }
  return typeof data === 'string' && data ? data : null;
}
