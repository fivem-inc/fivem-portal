// 上長・管理者が休暇の種類を変えるときの選択肢（2026-10-26 言葉をそろえる 不具合5・6）。
// 受理の画面の［差し戻す］（components/LeaveApprovals）と管理画面の休暇のタブ（admin/LeaveRequestsTab）が同じこれを使う。
// 🐛 5：前は「BD休暇」「慶弔休」「病欠」と、本人の画面・DB（バースデー休暇（有給）・慶弔休暇）と違う綴りだった
// 🐛 6：前は「調整休」だけで、時間外調整休の印（chosei_sub_type='zangyou'）が付かず、受理しても残業の時間から引かれなかった。
//    時間外調整休・振替休日を分けて選び、印も一緒に入れる
// 🚨 区切りの日（10/16）以降の調整休は DB（enforce_leave_adjust_moved）が止める＝そのときは残業申請の終日で出してもらう

export const LEAVE_TYPE_CHOICES = ['有給休暇', 'バースデー休暇（有給）', '慶弔休暇', '時間外調整休', '振替休日', 'その他'] as const;

/** 選んだ名前 → 書き込む列 */
export function leaveTypeFields(label: string): { leave_type: string; chosei_sub_type: string | null } {
  if (label === '時間外調整休') return { leave_type: '調整休', chosei_sub_type: 'zangyou' };
  if (label === '振替休日') return { leave_type: '調整休', chosei_sub_type: 'furikae' };
  return { leave_type: label, chosei_sub_type: null };
}

/** 今の申請の種類の名前（選択肢から今のものを外すため） */
export function currentLeaveTypeLabel(r: { leave_type: string | null; chosei_sub_type?: string | null }): string {
  if (r.leave_type === '調整休') return r.chosei_sub_type === 'zangyou' ? '時間外調整休' : r.chosei_sub_type === 'furikae' ? '振替休日' : '調整休';
  return r.leave_type ?? '';
}
