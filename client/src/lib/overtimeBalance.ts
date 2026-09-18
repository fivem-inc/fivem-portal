// 残業・時間調整の「合計時間数」の計算（本人カード・部門集計・個人詳細・管理画面の受理済み一覧で共用）。
// 🚨 同じ計算を画面ごとに書かない。給与に効く数字なので、どこで見ても同じ値にする。
// 🚨 休暇由来の自動計上（entry_type='leave_auto'）も含める。手で出した申請だけ足すと食い違う。

/** 計算に要る列だけ（overtime_reports の行）。画面ごとの型に依存しない */
export interface BalanceRow {
  pay_period_start: string;
  status: 'requested' | 'request_confirmed' | 'reported' | 'confirmed' | 'returned' | 'cancelled';
  entry_type: string;
  work_date: string;
  diff_minutes: number | null;
  application_types: string[] | null;
}

// 見込み(予定込み)合計に加算する未確定ステータス。
// request_confirmed（事前受理済み・実績待ち）を含めないと受理済みの時間が消えるため必ず含める。
// returned（差し戻し中）・cancelled（取消済み）は合計に入れない（cancelledは同日再申請で行が残存＝足すと二重計上）。
const PLANNED_STATUSES: BalanceRow['status'][] = ['requested', 'request_confirmed', 'reported'];

export interface BalanceSummary {
  total: number;         // 確定合計 = Σ diff_minutes（confirmed）。給与に効く数字
  plannedDelta: number;  // 見込みの増分 = Σ diff_minutes（未確定ステータス）
  plannedTotal: number;  // 見込み合計 = total + plannedDelta
  plus: number;          // 残業（確定・プラス分）
  choseiMinus: number;   // 調整休（確定・マイナス分）
  otherMinus: number;    // 早退・調整（確定・マイナス分）
  holidayPlus: number;   // うち休日出勤（確定）。🚨 残業（plus）の内訳であって、別に足す数字ではない
  minus: number;
  absenceDays: number;   // 欠勤（確定・日数別枠。時間には入れない）
  absencePending: number;// 欠勤（申請中）
  pendingCount: number;  // 確認待ち件数（requested/reported）
}

// 合計時間数の内訳を計算する純関数。本人カード・部門集計・個人詳細で共用する。
// allRows: 任意ユーザーの overtime_reports（複数期間を含んでよい）。period で対象期を絞る。
export function computeBalance(allRows: BalanceRow[], period: string): BalanceSummary {
  const inPeriod = allRows.filter(r => r.pay_period_start === period);
  const confirmed = inPeriod.filter(r => r.status === 'confirmed');

  // 二重減算防止: 同日に確定済みの leave_auto（休暇由来の自動マイナス行）がある場合、
  // 同日の手動 chosei_off は計上しない（leave_auto を正とする）。両者は別々の部分ユニークで共存し得る。
  const autoDates = new Set(confirmed.filter(r => r.entry_type === 'leave_auto').map(r => r.work_date));
  const isDupChosei = (r: BalanceRow) =>
    r.entry_type === 'manual' && (r.application_types ?? []).includes('chosei_off') && autoDates.has(r.work_date);
  const counted = confirmed.filter(r => !isDupChosei(r));

  // 調整休系（休みによる貸借）= 時間外調整休 / 休暇由来の自動計上 / 振替休日。
  // 振替休日の差分は net（振替元労働 − 対象日労働）で ± どちらもあり得るが、負のときは
  // 「早退・調整」ではなく「調整休」バケットに入れる（休みによる調整のため）。
  const isChosei = (r: BalanceRow) => r.entry_type === 'leave_auto'
    || (r.application_types ?? []).includes('chosei_off')
    || (r.application_types ?? []).includes('furikae_off');
  const total = counted.reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
  const plus = counted.filter(r => (r.diff_minutes ?? 0) > 0).reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
  const choseiMinus = counted.filter(r => (r.diff_minutes ?? 0) < 0 && isChosei(r)).reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
  const otherMinus = counted.filter(r => (r.diff_minutes ?? 0) < 0 && !isChosei(r)).reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
  const minus = choseiMinus + otherMinus;
  // 休日出勤した時間（2026-09-18 ユーザー指示「休み日の時間数の合計も」）。休日はシフトが0なので差分＝働いた時間
  const holidayPlus = counted.filter(r => (r.application_types ?? []).includes('holiday_work') && (r.diff_minutes ?? 0) > 0)
    .reduce((s, r) => s + (r.diff_minutes ?? 0), 0);

  // 見込み: 未確定ステータスの diff を加算（終日欠勤は diff=0 のため時間には影響しない）
  // 確定合計と同じ二重減算防止を適用: 同日に確定 leave_auto がある未確定の手動 chosei_off は見込みに入れない
  const plannedDelta = inPeriod.filter(r => PLANNED_STATUSES.includes(r.status) && !isDupChosei(r)).reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
  const plannedTotal = total + plannedDelta;

  // 欠勤は時間に入れず日数で別枠カウント
  const absenceDays = counted.filter(r => (r.application_types ?? []).includes('absence')).length;
  const absencePending = inPeriod.filter(r => r.status === 'requested' && (r.application_types ?? []).includes('absence')).length;
  const pendingCount = inPeriod.filter(r => r.status === 'requested' || r.status === 'reported').length;

  return { total, plannedDelta, plannedTotal, plus, choseiMinus, otherMinus, holidayPlus, minus, absenceDays, absencePending, pendingCount };
}
