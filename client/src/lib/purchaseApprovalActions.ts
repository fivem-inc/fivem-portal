import { supabase } from './supabaseClient';
import { insertNotification } from './notifications';
import { dispatchSiteNotification, dispatchEmail, getUserEmail, resolveRoleRecipients } from './notificationDispatch';
import { sendPurchaseSlackForEvent } from './purchaseSlack';

export type PurchaseApprovalRoute = 'leader' | 'manager' | 'board';

interface ActionParams {
  id: string;
  route: PurchaseApprovalRoute;
  fromStatus: string;
  applicantUserId: string;
  applicantName: string;
  itemNameSummary: string;
  amount: number;
}

// PurchaseApprovals.tsx（申請者本人向け）のhandleApproveと全く同じ処理を共通化したもの。
// 管理画面からの代行実行でも同一の通知・Slack・メール送信を行う。
// .eq('status', fromStatus)を必ず付けて、他の操作者が先にステータスを変えていた場合は
// 0件更新（何も起きない）になるようにする（同時実行時の事故防止）
export async function approvePurchaseRequestAction(params: ActionParams & { comment?: string }): Promise<string | null> {
  const { id, route, fromStatus, applicantUserId, applicantName, itemNameSummary, amount, comment } = params;
  if (route !== 'leader' && route !== 'manager') {
    return '全員承認ルートは自動確定のため、この操作では承認できません。';
  }
  // 承認時のひとこと（任意）。差し戻し理由と違い必須ではないので、空なら列を触らない
  const approvalComment = comment?.trim() ? { approval_comment: comment.trim() } : {};
  const update = route === 'leader'
    ? { status: 'leader_approved', leader_approved_at: new Date().toISOString(), ...approvalComment }
    : { status: 'manager_approved', manager_approved_at: new Date().toISOString(), ...approvalComment };
  const eventKey = route === 'leader' ? 'purchase_request:leader_approved' : 'purchase_request:manager_approved';

  const { data, error } = await supabase.from('purchase_requests').update(update).eq('id', id).eq('status', fromStatus).select('id');
  if (error) return '最終決定に失敗しました: ' + error.message;
  if (!data || data.length === 0) return '他の操作によりステータスが変わっているため、この操作は反映されませんでした。一覧を更新してご確認ください。';

  const vars = { '申請者名': applicantName, '品目名': itemNameSummary, '金額': amount.toLocaleString() };
  // 通知の失敗で承認そのものを失敗扱いにしない（承認はDBで確定済み）
  try {
    await dispatchSiteNotification(eventKey, vars, { applicant: applicantUserId }, insertNotification, 'purchase_request', id);
  } catch (e) { console.error('[purchase] 承認通知に失敗:', e); }
  sendPurchaseSlackForEvent(eventKey, 'approved', route, applicantName, itemNameSummary, amount).then(null, () => {});
  (async () => {
    const applicantEmail = await getUserEmail(applicantUserId);
    if (applicantEmail) await dispatchEmail(eventKey, vars, { applicant: applicantEmail });
  })().then(null, () => {});
  return null;
}

// PurchaseApprovals.tsxのhandleReturnと同じ処理を共通化したもの
export async function returnPurchaseRequestAction(params: ActionParams & { reason: string }): Promise<string | null> {
  const { id, route, fromStatus, applicantUserId, applicantName, itemNameSummary, amount, reason } = params;
  const { data, error } = await supabase.from('purchase_requests').update({
    status: 'returned',
    returned_reason: reason,
  }).eq('id', id).eq('status', fromStatus).select('id');
  if (error) return '差し戻しに失敗しました: ' + error.message;
  if (!data || data.length === 0) return '他の操作によりステータスが変わっているため、この操作は反映されませんでした。一覧を更新してご確認ください。';

  const vars = { '申請者名': applicantName, '品目名': itemNameSummary, '金額': amount.toLocaleString() };
  // 通知の失敗で差し戻しそのものを失敗扱いにしない（差し戻しはDBで確定済み）
  try {
    // 宛先で役職（リーダー・マネージャー・社長）を選んでいれば、その人たちにも届くようにする
    // （以前は applicant しか解決しておらず、チェックしても無視されていた）
    const roleSite = await resolveRoleRecipients(applicantUserId, 'purchase_request:returned', 'site');
    await dispatchSiteNotification('purchase_request:returned', vars, { applicant: applicantUserId, ...roleSite.ids }, insertNotification, 'purchase_request', id);
  } catch (e) { console.error('[purchase] 差し戻し通知に失敗:', e); }
  sendPurchaseSlackForEvent('purchase_request:returned', 'returned', route, applicantName, itemNameSummary, amount, reason).then(null, () => {});
  (async () => {
    const applicantEmail = await getUserEmail(applicantUserId);
    const roleMail = await resolveRoleRecipients(applicantUserId, 'purchase_request:returned', 'email');
    await dispatchEmail('purchase_request:returned', vars, { applicant: applicantEmail ?? '', ...roleMail.emails });
  })().then(null, () => {});
  return null;
}

// 金額帯・自己判断フラグから、差し戻し前に戻るべきpending_*ステータスを一意に算出する。
// purchase_requests_type_status_check制約により、この組み合わせは常に一意に決まる
// （新しい列は不要）
export function computeReturnCancelTargetStatus(record: {
  amount: number;
  is_self_judgment: boolean;
  president_self_judgment?: boolean | null;
}): string | null {
  const { amount, is_self_judgment } = record;
  if (is_self_judgment) return null; // 自己判断ルートは差し戻しされない想定
  if (amount <= 10000) return 'pending_leader';
  if (amount <= 30000) return 'pending_manager';
  if (record.president_self_judgment) return null;
  return 'pending_board';
}

// 差し戻し済みの申請を「取り消し」て、元の承認待ちステータスに戻す。
// 過去ラウンドの意見が「回答済み」として誤カウントされないよう、approval_roundを1つ進める
export async function cancelReturnedPurchaseRequest(record: {
  id: string;
  amount: number;
  is_self_judgment: boolean;
  president_self_judgment?: boolean | null;
  approval_round: number;
}): Promise<string | null> {
  const targetStatus = computeReturnCancelTargetStatus(record);
  if (!targetStatus) return '取り消し可能な差し戻しではありません。';

  const { data, error } = await supabase.from('purchase_requests').update({
    status: targetStatus,
    returned_reason: null,
    approval_round: record.approval_round + 1,
  }).eq('id', record.id).eq('status', 'returned').select('id');
  if (error) return '取り消しに失敗しました: ' + error.message;
  if (!data || data.length === 0) return '他の操作によりステータスが変わっているため、この操作は反映されませんでした。一覧を更新してご確認ください。';
  return null;
}
