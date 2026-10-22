// 管理画面の 残業の一覧・勤務変更の一覧の並べ方（2026-10-22 ユーザー指示：2つの一覧をそろえる・2段で並べ替える）。
// ・並べる物：出した日／対象日／名前順（従業員番号）／差分。1段目で同じなら2段目で並べる（2段目は「なし」も選べる）
// ・最初の状態：出した日の新しい順 → 同じなら対象日の新しい順（上が新しい・ユーザー確定）
// 🚨 2つの一覧が同じこの1か所を使う。並べ方を足すときはここだけ直す
import { compareEmployeeNo } from './employeeNo';

export type ListSortKey = 'created_at' | 'work_date' | 'name' | 'diff' | 'none';
export interface ListSort { key: ListSortKey; dir: 'asc' | 'desc' }

export const LIST_SORT_LABELS: Record<Exclude<ListSortKey, 'none'>, string> = {
  created_at: '出した日',
  work_date: '対象日',
  name: '名前順（従業員番号）',
  diff: '差分',
};
export const DEFAULT_LIST_SORTS: [ListSort, ListSort] = [{ key: 'created_at', dir: 'desc' }, { key: 'work_date', dir: 'desc' }];
export const isDefaultListSorts = (s: ListSort[]): boolean =>
  s.length === DEFAULT_LIST_SORTS.length && s.every((x, i) => x.key === DEFAULT_LIST_SORTS[i].key && x.dir === DEFAULT_LIST_SORTS[i].dir);

/** 向きの言葉（日付＝新しい順／古い順・名前＝番号の小さい順／大きい順・差分＝多い順／少ない順） */
export function listSortDirLabel(key: ListSortKey, dir: 'asc' | 'desc'): string {
  if (key === 'name') return dir === 'asc' ? '番号の小さい順' : '番号の大きい順';
  if (key === 'diff') return dir === 'desc' ? '多い順' : '少ない順';
  return dir === 'desc' ? '新しい順' : '古い順';
}

export interface ListSortVals { workDate: string; createdAt: string; empNo: string | null | undefined; name: string; diff: number | null }

export function compareByListSorts(a: ListSortVals, b: ListSortVals, sorts: ListSort[]): number {
  for (const s of sorts) {
    if (s.key === 'none') continue;
    const sign = s.dir === 'asc' ? 1 : -1;
    let c = 0;
    if (s.key === 'name') c = compareEmployeeNo(a.empNo, a.name, b.empNo, b.name, s.dir === 'asc');
    else if (s.key === 'diff') {
      // 差分の無い行（計算できない報告）はいつも最後
      if (a.diff == null || b.diff == null) c = a.diff == null && b.diff == null ? 0 : a.diff == null ? 1 : -1;
      else c = (a.diff - b.diff) * sign;
    } else if (s.key === 'created_at') {
      // 出した日の無い古い行はいつも最後
      if (!a.createdAt || !b.createdAt) c = !a.createdAt && !b.createdAt ? 0 : !a.createdAt ? 1 : -1;
      else c = a.createdAt.localeCompare(b.createdAt) * sign;
    } else c = a.workDate.localeCompare(b.workDate) * sign;
    if (c !== 0) return c;
  }
  return 0;
}
