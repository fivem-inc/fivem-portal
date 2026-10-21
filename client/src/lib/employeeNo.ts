// 従業員番号の順（2026-10-21 ユーザー確定・給与計算で使っている並び）。
// 使うのは「残業の受理済み一覧（名前順・表で見る）」と「勤務変更のタブの名前順」だけ。人を選ぶ・探す一覧は今までどおり役職の順。
// 🚨 文字のまま比べると "10" が "9" より前に来るので numeric で比べる。番号の無い人は昇順・降順に関係なく最後（その中は名前順）

export function compareEmployeeNo(
  aNo: string | null | undefined, aName: string | null | undefined,
  bNo: string | null | undefined, bName: string | null | undefined,
  asc = true,
): number {
  const an = (aNo ?? '').trim(), bn = (bNo ?? '').trim();
  if (an && !bn) return -1;
  if (!an && bn) return 1;
  if (an && bn) {
    const c = an.localeCompare(bn, 'ja', { numeric: true });
    if (c !== 0) return asc ? c : -c;
  }
  return (aName ?? '').localeCompare(bName ?? '', 'ja');
}
