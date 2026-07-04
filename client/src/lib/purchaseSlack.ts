import { supabase } from './supabaseClient'
import { shouldSend, getNotificationRecipient } from './notificationDispatch'

type PurchaseSlackEvent =
  | 'submitted'
  | 'approved'
  | 'returned'
  | 'board_all_approved'

type PurchaseSlackRoute = 'leader' | 'manager' | 'board' | 'self_judgment'

export async function sendPurchaseSlack(
  event: PurchaseSlackEvent,
  route: PurchaseSlackRoute,
  channels: string[],
  applicantName: string,
  itemName: string,
  amount: number,
  returnedReason?: string
) {
  if (channels.length === 0) return;
  try {
    await supabase.functions.invoke('send-purchase-slack', {
      body: { event, route, channels, applicantName, itemName, amount, returnedReason },
    })
  } catch (e) {
    console.error('Slack通知エラー:', e)
  }
}

// 通知設定（管理画面の「通知設定」タブ）で選択されたチャンネルを取得し、有効な場合のみSlack送信する。
// eventKey は notification_settings.event_key（例：'purchase_request:submitted'）。
export async function sendPurchaseSlackForEvent(
  eventKey: string,
  event: PurchaseSlackEvent,
  route: PurchaseSlackRoute,
  applicantName: string,
  itemName: string,
  amount: number,
  returnedReason?: string
) {
  try {
    if (!(await shouldSend(eventKey, 'slack'))) return;
    const recipient = await getNotificationRecipient(eventKey, 'slack');
    const channels: string[] = (() => {
      try {
        const parsed = JSON.parse(recipient ?? '{}');
        return Array.isArray(parsed.channels) ? parsed.channels : [];
      } catch {
        return [];
      }
    })();
    if (channels.length === 0) return;
    await sendPurchaseSlack(event, route, channels, applicantName, itemName, amount, returnedReason);
  } catch (e) {
    console.error('Slack通知エラー:', e)
  }
}
