import { supabase } from './supabaseClient';

// 差し戻しバナー2行目用：申請した休暇日のサマリーを作る（例「7/26 有給休暇（1日）」「7/26・7/27 有給休暇（2日）」「7/26〜8/2 有給休暇（6日）」）
// leaveDates は leave_requests.leave_dates（'YYYY-MM-DD'の配列のJSON文字列）。旧申請でnullの場合は start/end から補完する
export function formatLeaveDateSummary(leaveDates: string | null | undefined, startDate: string | null | undefined, endDate: string | null | undefined, leaveTypeName: string): string {
  const fmt = (d: string) => {
    const m = d.match(/^\d{4}-(\d{2})-(\d{2})$/);
    return m ? `${Number(m[1])}/${Number(m[2])}` : d;
  };
  // 種別を別の行に出したいとき（Slack本文など）は leaveTypeName に空文字を渡す
  const typePart = leaveTypeName ? ` ${leaveTypeName}` : '';
  let dates: string[] = [];
  try { dates = leaveDates ? JSON.parse(leaveDates) : []; } catch { dates = []; }
  if (!Array.isArray(dates) || dates.length === 0) {
    // 旧申請（leave_datesなし）は start〜end の範囲表記にする（日数は範囲から計算）
    if (!startDate || !endDate) return leaveTypeName; // 日付情報が一切ない場合は種別のみ
    const days = Math.floor((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000) + 1;
    const range = startDate === endDate ? fmt(startDate) : `${fmt(startDate)}〜${fmt(endDate)}`;
    return `${range}${typePart}（${days > 0 ? days : 1}日）`;
  }
  const sorted = [...dates].sort();
  const dateStr = sorted.length <= 3
    ? sorted.map(fmt).join('・')
    : `${fmt(sorted[0])}〜${fmt(sorted[sorted.length - 1])}`;
  return `${dateStr}${typePart}（${sorted.length}日）`;
}

// 連絡板のメッセージを読んだときに、そのメッセージのベル通知も既読にする（2026-09-10 ユーザー依頼）。
// ベルから開いたときは既読になるのに、受信トレイで直接読んだときはベルが未読のまま残っていた。
//
// 🚨 **「届きました」の通知だけを既読にする。**「対応がまだ完了していません」（board:confirm_request）は
//    読んだだけでは対応が終わっていないので**既読にしない**。消すと対応漏れに気づけなくなる。
// 🚨 判定は reference_id（＝連絡板のメッセージID）。通知を作るときに必ず入れている。
// 🚨 失敗しても読み込みは続ける（既読の印が付かないだけで、メッセージは読める）。
//    ただし error は握りつぶさず console に出す（supabase は throw しないため）。
const BELL_READ_ON_MESSAGE_READ = ['board:notice', 'board:group_message', 'board:dm_message'] as const;

/** ベルを読み直してほしいときに投げる合図。
 *  🚨 ベルは30秒ごとの自動更新なので、これが無いと**読んだ直後は数字が減らず**
 *     「効いていない」ように見える。App 側がこれを受けてその場で読み直す。 */
export const BELL_REFRESH_EVENT = 'fivem:bell-refresh';

export async function markBellReadForMessages(userId: string, messageIds: string[]) {
  const ids = [...new Set(messageIds.filter(Boolean))];
  if (ids.length === 0) return;
  // 🚨 呼び出し側は待たずに投げっぱなしにする（読む操作を遅くしないため）。
  //    そのため**ここで必ず受け止める**。外に例外を出すと、通信断のときに
  //    「未処理のエラー」になる。
  try {
    const { data, error } = await supabase.from('notifications')
      .update({ read: true, read_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('read', false)
      .in('reference_id', ids)
      .in('event_key', BELL_READ_ON_MESSAGE_READ as unknown as string[])
      .select('id');
    if (error) { console.error('ベルの既読化に失敗:', error.code, error.message); return; }
    // 🚨 **0件は正常**。自分が送ったメッセージ・すでに既読・そもそも通知が無い場合があるので、
    //    件数0を失敗として扱わない（件数を見るのは「変わったときだけ知らせる」ため）。
    if ((data ?? []).length > 0) window.dispatchEvent(new Event(BELL_REFRESH_EVENT));
  } catch (e) {
    console.error('ベルの既読化に失敗:', e);
  }
}

// pushUrgent: 連絡板の「当日の連絡・緊急」チェック用。true にすると、
// 受け取る人の「受信時間帯・休暇日」設定を無視してプッシュがすぐ届く
// （notifications.push_urgent → トリガーが push_queue.urgent へコピー → push-dispatch が判定を飛ばす）
export async function insertNotification(userId: string, message: string, subMessage?: string, sourceType?: string, referenceId?: string, eventKey?: string, pushUrgent?: boolean) {
  try {
    // supabase-js は失敗を throw せず error で返すため、error を見ないとRLS拒否等を握りつぶしてしまう
    // push_urgent は true のときだけ列に含める（false は列既定値に任せる。
    // 万一DBマイグレーション前にクライアントが先に配られても、通常通知が壊れないように）
    const row: Record<string, unknown> = { user_id: userId, message, sub_message: subMessage ?? null, source_type: sourceType ?? null, reference_id: referenceId ?? null, event_key: eventKey ?? null };
    if (pushUrgent) row.push_urgent = true;
    const { error } = await supabase.from('notifications').insert(row);
    if (error) console.error('通知挿入エラー:', error.message);
  } catch (e) {
    console.error('通知挿入エラー:', e);
  }
}
