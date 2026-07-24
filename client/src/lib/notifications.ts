import { supabase } from './supabaseClient';

// 差し戻しバナー2行目用：申請した休暇日のサマリーを作る（例「7/26 有給休暇（1日）」「7/26・7/27 有給休暇（2日）」「7/26〜8/2 有給休暇（6日）」）
// leaveDates は leave_requests.leave_dates（'YYYY-MM-DD'の配列のJSON文字列）。旧申請でnullの場合は start/end から補完する
export function formatLeaveDateSummary(leaveDates: string | null | undefined, startDate: string | null | undefined, endDate: string | null | undefined, leaveTypeName: string): string {
  const fmt = (d: string) => {
    const m = d.match(/^\d{4}-(\d{2})-(\d{2})$/);
    return m ? `${Number(m[1])}/${Number(m[2])}` : d;
  };
  let dates: string[] = [];
  try { dates = leaveDates ? JSON.parse(leaveDates) : []; } catch { dates = []; }
  if (!Array.isArray(dates) || dates.length === 0) {
    // 旧申請（leave_datesなし）は start〜end の範囲表記にする（日数は範囲から計算）
    if (!startDate || !endDate) return leaveTypeName; // 日付情報が一切ない場合は種別のみ
    const days = Math.floor((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000) + 1;
    const range = startDate === endDate ? fmt(startDate) : `${fmt(startDate)}〜${fmt(endDate)}`;
    return `${range} ${leaveTypeName}（${days > 0 ? days : 1}日）`;
  }
  const sorted = [...dates].sort();
  const dateStr = sorted.length <= 3
    ? sorted.map(fmt).join('・')
    : `${fmt(sorted[0])}〜${fmt(sorted[sorted.length - 1])}`;
  return `${dateStr} ${leaveTypeName}（${sorted.length}日）`;
}

export async function insertNotification(userId: string, message: string, subMessage?: string, sourceType?: string, referenceId?: string, eventKey?: string) {
  try {
    // supabase-js は失敗を throw せず error で返すため、error を見ないとRLS拒否等を握りつぶしてしまう
    const { error } = await supabase.from('notifications').insert({ user_id: userId, message, sub_message: subMessage ?? null, source_type: sourceType ?? null, reference_id: referenceId ?? null, event_key: eventKey ?? null });
    if (error) console.error('通知挿入エラー:', error.message);
  } catch (e) {
    console.error('通知挿入エラー:', e);
  }
}
