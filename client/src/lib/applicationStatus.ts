// 申請の状態の呼び名（2026-10-26・「受理済みの変更」のタブを作るときに1か所にまとめた）。
// 🚨 画面ごとに同じ状態を別の言葉で書いていた（削除の記録「確認済み」と修正依頼「受理済み」など）。状態の日本語はここから引く
// 言い方は「承認→受理」「却下→差し戻し」（CLAUDE.md の決まり）

export type ApplicationKind = 'overtime' | 'leave' | 'shift' | 'expense' | 'attendance';

export const APPLICATION_KIND_LABEL: Record<ApplicationKind, string> = {
  overtime: '残業', leave: '休暇', shift: '勤務変更', expense: '交通費', attendance: '勤怠カレンダー',
};

const STATUS: Record<Exclude<ApplicationKind, 'attendance'>, Record<string, string>> = {
  overtime: {
    requested: '受理待ち', request_confirmed: '事前受理（実績報告待ち）', reported: '実績の確認待ち',
    confirmed: '受理済み', returned: '差し戻し', cancelled: '取消済み',
  },
  leave: {
    pending: '受理待ち', step2_pending: '受理待ち', manager_approved: '経理の受理待ち', admin_approved: '最終受理待ち（社長）',
    approved: '受理済み', rejected: '差し戻し', cancelled: '取消済み',
  },
  shift: {
    pending: '確認待ち', resubmitted: '再提出（確認待ち）', confirmed: '受理済み', returned: '差し戻し', cancelled: '取消済み',
  },
  expense: {
    pending: '受理待ち', approved: '受理済み', rejected: '差し戻し',
  },
};

/** 状態の日本語。種類が分からないとき（古い記録など）は、どの種類にも当てはめて探す */
export function statusLabel(kind: ApplicationKind | string | null | undefined, status: string | null | undefined): string {
  if (!status) return '';
  if (kind === 'attendance') return '確定';
  const table = kind && kind in STATUS ? STATUS[kind as keyof typeof STATUS] : null;
  if (table?.[status]) return table[status];
  for (const t of Object.values(STATUS)) if (t[status]) return t[status];
  return status;
}
