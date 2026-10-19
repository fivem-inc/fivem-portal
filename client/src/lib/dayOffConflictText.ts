// 重なりのエラー（DB の 'DAYOFF_CONFLICT|<文>'）から案内の文を取り出す（2026-10-19）。
// 🚨 supabase を読まない（lib/overtimeSubmit の friendlyOvertimeDbError から使うため）。送る前の確かめは lib/dayOffConflict
const MARK = 'DAYOFF_CONFLICT|';

/** DB のエラーの文から、重なりの案内の文を取り出す（重なりのエラーでなければ null） */
export function dayOffConflictText(message: string | null | undefined): string | null {
  if (!message) return null;
  const i = message.indexOf(MARK);
  return i >= 0 ? message.slice(i + MARK.length).trim() : null;
}
