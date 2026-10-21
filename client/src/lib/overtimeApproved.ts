// 残業の「誰がいつ受理したか」（2026-10-17 ユーザー確定）。受理済み一覧の状況の札の下と、［表で見る］の確認サインで共用（2026-10-21）。
// 🚨 同じ決まりを画面ごとに書かない（片方だけ直す事故になる）

export interface OvertimeApprovedLine { label: string; name: string; at: string | null }

export interface OvertimeApprovedSource {
  applicant_id: string;
  reviewer_id: string | null;
  status: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  request_confirmed_at: string | null;
  application_types: string[] | null;
  hist: { change_kind: string | null }[] | null;
}

export const SELF_APPROVED_TEXT = '自己受理（自分で確認）';

/**
 * 🚨 事前申請の受理は「誰が」を記録していない（request_confirmed_at だけ）ので申請先（reviewer_id）を出す。
 *    経理が代わりに受理したもの（履歴 change_kind='approved'）はそう書く。本人＝自己受理
 * 🚨 打刻ズレの記録（残業なし）は、送信した時点で本人の記録として確定する（受理の手続きが無い）。
 *    「自己受理」と出すと、一般の方が受理したように読める（2026-10-20 ユーザー確定 案C）
 */
export function overtimeApprovedLines(r: OvertimeApprovedSource, nameOf: (id: string) => string): OvertimeApprovedLine[] {
  const proxy = (r.hist ?? []).some(h => h.change_kind === 'approved');
  const who = (id: string) => id === r.applicant_id ? SELF_APPROVED_TEXT : nameOf(id);
  const lines: OvertimeApprovedLine[] = [];
  if (r.status === 'confirmed' && r.confirmed_by === r.applicant_id && (r.application_types ?? []).includes('clock_only')) {
    lines.push({ label: '確定', name: '本人の記録（打刻ズレ）', at: r.confirmed_at });
  } else if (r.status === 'confirmed' && r.confirmed_by) {
    lines.push({ label: '受理', name: who(r.confirmed_by) + (proxy && r.confirmed_by !== r.applicant_id ? '（経理が代わりに）' : ''), at: r.confirmed_at });
  } else if ((r.status === 'request_confirmed' || r.status === 'reported') && r.request_confirmed_at) {
    lines.push({ label: '受理', name: proxy ? '経理が代わりに' : (r.reviewer_id ? who(r.reviewer_id) : '—'), at: r.request_confirmed_at });
  }
  return lines;
}
