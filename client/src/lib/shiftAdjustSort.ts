// シフト調整の「候補」「この日に勤務予定がない人」の並び（2026-09-14 ユーザー確定）
//
//   並びは 校 → 役職（高い順）→ 名前。
//   ・この日に勤務予定がある人 … その日の校（「四条本校→西陣校」は最初の校）
//   ・勤務予定がない人 … いつもの校＝週の基本シフトでいちばん多く入っている校（同数なら校の並び順が先の方）
//   ・校が分からない人（週のシフト未登録）は最後
//
// 🚨 役職の高さは roles.sort_order（大きいほど上）。役職名で判定しない（改名で壊れるため）。
//    2026-09-14 実測：管理者7・社長6・マネージャー5・リーダー4・フロア責任者3・一般2・パート1＝序列の決まりと一致
// 🚨 このファイルは supabase を読まない（画面を開かずに検算できるようにするため）

/** 「四条本校→西陣校」→「四条本校」。空なら '' */
export const firstWorkplace = (location: string | null | undefined): string =>
  (location ?? '').split('→')[0].trim();

/** 週の基本シフトの校の並びから、いつもの校を決める（無ければ ''） */
export function usualWorkplace(locations: readonly (string | null | undefined)[], workplaces: readonly string[]): string {
  const count = new Map<string, number>();
  for (const l of locations) {
    const w = firstWorkplace(l);
    if (w) count.set(w, (count.get(w) ?? 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [w, n] of count) {
    const better = n > bestN || (n === bestN && placeIndex(w, workplaces) < placeIndex(best, workplaces));
    if (better) { best = w; bestN = n; }
  }
  return best;
}

/** 校の並び順（分からない校・空は最後） */
export const placeIndex = (place: string, workplaces: readonly string[]): number => {
  const i = place ? workplaces.indexOf(place) : -1;
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
};

export interface SortKey {
  place: string;
  /** roles.sort_order。大きいほど上。分からなければ 0 */
  roleRank: number;
  name: string;
}

/** 校 → 役職（高い順）→ 名前 */
export const compareByPlaceRole = (a: SortKey, b: SortKey, workplaces: readonly string[]): number =>
  placeIndex(a.place, workplaces) - placeIndex(b.place, workplaces)
  || b.roleRank - a.roleRank
  || a.name.localeCompare(b.name, 'ja');
