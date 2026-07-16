import { supabase } from './supabaseClient';
import { insertNotification } from './notifications';
import { dispatchEmail, getNotificationTemplate, getUserEmail, shouldSend } from './notificationDispatch';

// 勤務変更報告「差し戻し時」の通知送信（管理画面「通知設定」の shift_report:returned に従う）
//
// 管理画面(ShiftReportsTab)と申請画面(ShiftReportPage)の両方から差し戻せるため、
// 送信処理はここに集約する（片方だけ直す配線漏れを防ぐ）。
//
// チャンネルの内訳:
//   サイト通知 … ベル通知。event_keyを付けて入れると、DBトリガー経由で本人へのプッシュ通知も自動で流れる
//   プッシュ  … 上記トリガー＋push-dispatch側で送るため、ここでは何もしない（二重送信になる）
//   Slack    … Webhook URLがサーバー側の秘密のため shift-report-returned-notify 経由
//   メール    … 申請者本人宛て
export interface ShiftReportReturnedInfo {
  reportId: string;
  applicantId: string;
  applicantName: string;
  typeLabels: string;  // 例：「残業＋早退」
  workDate: string;    // 例：「2026-07-16」
  reason: string;      // 差戻しコメント（空欄可）
}

export async function notifyShiftReportReturned(info: ShiftReportReturnedInfo): Promise<void> {
  const { reportId, applicantId, applicantName, typeLabels, workDate, reason } = info;
  const vars: Record<string, string> = {
    申請者名: applicantName,
    種別: typeLabels,
    日付: workDate,
    差し戻し理由: reason || '（記載なし）',
    リンク: 'https://fivem-portal.vercel.app/shift-report?tab=history',
  };

  if (await shouldSend('shift_report:returned', 'site')) {
    const t = await getNotificationTemplate('shift_report:returned', 'site', vars);
    // subjectが未設定なら従来どおり「種別　日付（＋理由）」を2行目に出す
    const subMessage = `${typeLabels}　${workDate}${reason ? `\n理由：${reason}` : ''}`;
    await insertNotification(
      applicantId,
      t?.template ?? '勤務変更報告が差戻されました',
      t?.subject || subMessage,
      'shift_report:pending_resubmit',
      reportId,
      'shift_report:returned',
    );
  }

  if (await shouldSend('shift_report:returned', 'slack')) {
    const { error } = await supabase.functions.invoke('shift-report-returned-notify', {
      body: { applicant_name: applicantName, type_labels: typeLabels, date_label: workDate, reason },
    });
    if (error) console.error('[notifyShiftReportReturned] Slack送信失敗', error);
  }

  const email = await getUserEmail(applicantId);
  if (email) await dispatchEmail('shift_report:returned', vars, { applicant: email });
}
