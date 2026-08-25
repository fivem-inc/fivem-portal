import { insertNotification } from './notifications';
import { dispatchEmail, getUserEmail, shouldSendWithDefault } from './notificationDispatch';
import { supabase } from './supabaseClient';

// 残業・時間管理の通知送信（管理画面「通知設定」の overtime:* に従う）
//
// 同じ種類の通知が複数の画面から出るため、送信処理はここに集約する（片方だけ直す配線漏れを防ぐ）。
//   差し戻し   … Edge Function overtime-approve（確認者ビュー）と 管理画面 OvertimeAdminTab の2経路
//   申請の受信 … 残業ページの新規送信と、調整休の提案を受諾したときの自動作成の2経路
//
// チャンネルの内訳:
//   サイト通知 … ベル。event_key を付けて入れると、DBトリガー経由で本人へのプッシュも自動で流れる
//   プッシュ  … 上記トリガー＋push-dispatch が送るため、ここでは何もしない（送ると二重送信になる）
//   メール    … サイト通知と同じ人へ
//   Slack    … 2026-08-25 に対応（それまでは「個人の勤怠情報だから」と行自体を作っていなかった）。
//              専用チャンネル #17残業_調整_年休連絡用 ができたため方針変更。
//              本文は送信側（Edge Function send-overtime-slack）が report_id から組み立てる。
//              載せるのは Googleカレンダー相当（氏名・種別・日付・時間・勤務地）まで。理由・差分は載せない
//
// ⚠️ source_type は App.tsx がホームバナーの表示・タップ遷移・対応完了の自動消し込みに使っている
//    完全一致の文字列。event_key とは別体系なので、ここの値を変えないこと。
//      overtime_request:pending_approval … 確認者：要対応
//      overtime_request:pending_resubmit … 申請者：再提出待ち
//      overtime_request                  … 結果報告のみ

const LINK_APPLICANT = 'https://fivem-portal.vercel.app/overtime?tab=history';
const LINK_REVIEWER  = 'https://fivem-portal.vercel.app/overtime?view=confirm';

/**
 * Slackへ送る（送信先チャンネル・ON/OFFは管理画面の通知設定に従う）。
 * 🚨 本文の材料は渡さない。report_id だけ渡してサーバー側で組み立てる
 *    （呼び出し元が複数あるので、項目を足したときの渡し忘れを構造的に防ぐ）。
 * 失敗しても呼び出し元の処理は止めない。
 */
export async function sendOvertimeSlack(reportId: string, eventKey: string): Promise<void> {
  try {
    await supabase.functions.invoke('send-overtime-slack', {
      body: { report_id: reportId, event_key: eventKey },
    });
  } catch (e) {
    console.error('[send-overtime-slack] Slack通知失敗:', e);
  }
}

/** 申請・実績報告が届いた時 → 確認をお願いする人へ */
export async function notifyOvertimeNewRequest(info: {
  reportId: string;
  reviewerId: string;
  applicantName: string;
  phaseLabel: string;   // 「事前申請」または「実績報告」
  dateLabel: string;    // 例：2026-07-25（金）
  timeLabel: string;    // 例：+1:30
}): Promise<void> {
  const { reportId, reviewerId, applicantName, phaseLabel, dateLabel, timeLabel } = info;
  if (await shouldSendWithDefault('overtime:new_request', 'site', true)) {
    await insertNotification(
      reviewerId,
      `${applicantName}さんから残業・時間調整の${phaseLabel}が届きました`,
      `${dateLabel}　${timeLabel}`,
      'overtime_request:pending_approval',
      reportId,
      'overtime:new_request',
    );
  }
  const email = await getUserEmail(reviewerId);
  if (email) {
    await dispatchEmail(
      'overtime:new_request',
      { 申請者名: applicantName, 日付: dateLabel, 時間: timeLabel, 種別: phaseLabel, リンク: LINK_REVIEWER },
      { approver: email },
    );
  }
  await sendOvertimeSlack(reportId, 'overtime:new_request');
}

/** 差し戻した時 → 申請した本人へ（管理画面から差し戻す経路。確認者ビューからは Edge が送る） */
export async function notifyOvertimeReturned(info: {
  reportId: string;
  applicantId: string;
  dateLabel: string;
  reason: string;
}): Promise<void> {
  const { reportId, applicantId, dateLabel, reason } = info;
  if (await shouldSendWithDefault('overtime:returned', 'site', true)) {
    await insertNotification(
      applicantId,
      '残業・時間調整の申請が差し戻されました',
      `${dateLabel}　理由：${reason}`,
      'overtime_request:pending_resubmit',
      reportId,
      'overtime:returned',
    );
  }
  const email = await getUserEmail(applicantId);
  if (email) {
    await dispatchEmail(
      'overtime:returned',
      { 日付: dateLabel, 差し戻し理由: reason || '（記載なし）', 種別: '残業・時間調整', 時間: '', 申請者名: '', リンク: LINK_APPLICANT },
      { applicant: email },
    );
  }
}

/** 管理者が取り消した時 → 申請した本人へ */
export async function notifyOvertimeAdminCancelled(info: {
  reportId: string;
  applicantId: string;
  dateLabel: string;
}): Promise<void> {
  const { reportId, applicantId, dateLabel } = info;
  if (await shouldSendWithDefault('overtime:admin_cancelled', 'site', true)) {
    await insertNotification(
      applicantId,
      '管理者が残業・時間調整の申請を取り消しました',
      dateLabel,
      'overtime_request',
      reportId,
      'overtime:admin_cancelled',
    );
  }
  const email = await getUserEmail(applicantId);
  if (email) {
    await dispatchEmail(
      'overtime:admin_cancelled',
      { 日付: dateLabel, 種別: '残業・時間調整', 時間: '', 申請者名: '', 差し戻し理由: '', リンク: LINK_APPLICANT },
      { applicant: email },
    );
  }
  await sendOvertimeSlack(reportId, 'overtime:admin_cancelled');
}

/** 経理が締め後申請を許可した時 → 許可された本人へ（本人がホーム・残業ページで見落とさないよう、ベル通知で確実に伝える） */
export async function notifyOvertimeGrant(info: {
  applicantId: string;
  workDatesLabel: string; // 例：7/18・7/19
}): Promise<void> {
  const { applicantId, workDatesLabel } = info;
  if (await shouldSendWithDefault('overtime:grant', 'site', true)) {
    await insertNotification(
      applicantId,
      `締め後の残業・時間調整申請が許可されました`,
      `${workDatesLabel}の新規申請ができます`,
      'overtime_request',
      undefined,
      'overtime:grant',
    );
  }
  const email = await getUserEmail(applicantId);
  if (email) {
    await dispatchEmail(
      'overtime:grant',
      { 対象日: workDatesLabel, 日付: '', 種別: '', 時間: '', 申請者名: '', 差し戻し理由: '', リンク: 'https://fivem-portal.vercel.app/overtime' },
      { applicant: email },
    );
  }
}

/** 経理が締め後申請の依頼を見送った時 → 依頼した本人へ */
export async function notifyOvertimeGrantDeclined(info: {
  applicantId: string;
  workDatesLabel: string;
  reason: string;
}): Promise<void> {
  const { applicantId, workDatesLabel, reason } = info;
  if (await shouldSendWithDefault('overtime:grant_declined', 'site', true)) {
    await insertNotification(
      applicantId,
      '締め後申請の依頼は見送られました',
      reason ? `${workDatesLabel}　理由：${reason}` : workDatesLabel,
      'overtime_request',
      undefined,
      'overtime:grant_declined',
    );
  }
  const email = await getUserEmail(applicantId);
  if (email) {
    await dispatchEmail(
      'overtime:grant_declined',
      { 対象日: workDatesLabel, 差し戻し理由: reason || '（記載なし）', 日付: '', 種別: '', 時間: '', 申請者名: '', リンク: 'https://fivem-portal.vercel.app/overtime' },
      { applicant: email },
    );
  }
}

/** 本人が締め後申請の許可を依頼した時 → 経理（役職＝管理者）全員へ */
export async function notifyOvertimeGrantRequest(info: {
  requestId: string;
  applicantName: string;
  workDatesLabel: string;
}): Promise<void> {
  await supabase.functions.invoke('overtime-grant-request-notify', {
    body: { applicant_name: info.applicantName, work_dates_label: info.workDatesLabel, request_id: info.requestId },
  }).then(null, () => {});
}

/** 管理者が内容を修正した時 → 修正された本人へ */
export async function notifyOvertimeAdminEdited(info: {
  reportId: string;
  applicantId: string;
  dateLabel: string;
  summary: string;   // 変更点の要約
  reason: string;    // 修正理由（必須入力）
}): Promise<void> {
  const { reportId, applicantId, dateLabel, summary, reason } = info;
  if (await shouldSendWithDefault('overtime:admin_edited', 'site', true)) {
    await insertNotification(
      applicantId,
      '管理者が残業・時間調整の内容を修正しました',
      `${summary}　理由：${reason}`,
      'overtime_request',
      reportId,
      'overtime:admin_edited',
    );
  }
  const email = await getUserEmail(applicantId);
  if (email) {
    await dispatchEmail(
      'overtime:admin_edited',
      { 日付: dateLabel, 種別: `${summary}（理由：${reason}）`, 時間: '', 申請者名: '', 差し戻し理由: '', リンク: LINK_APPLICANT },
      { applicant: email },
    );
  }
}
