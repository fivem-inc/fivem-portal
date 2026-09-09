// 役職の属性（承認者／リーダー以上／マネージャー以上／決裁者／経営／立場／序列）の判定。
//
// 【なぜ要るか（2026-09-09）】
// 役職名（'社長' 等）がコード46か所に直書きされていて、改名や役職の新設で権限が壊れた。
// → 判定は roles テーブルの属性で行い、役職名は「表示」にだけ使う。
//    画面はこのファイルの関数を呼ぶだけにし、役職名の配列を二度と書かない。
//
// 🚨 このファイルは supabase を import しない（roles の配列は呼び出し側から渡す）。
//    画面を開かずに検算できる形を保つため（lib/statusUpdate.ts と同じ約束）。
//
// 🚨 DB側にも同じ判定がある（role_is_approver() 等・migration 20260909232945）。
//    「〜以上」の意味を変えるときは DB と画面の両方を見ること。

/** roles テーブルの1行（画面が読む列だけ） */
export interface RoleRow {
  id: string;
  name: string;
  sort_order: number;
  is_fixed: boolean;
  /** 承認フロー上の立場。非一意（会長と社長が同じ 'president' に立てる）。null＝どの段にも立たない */
  acts_as: 'leader' | 'manager' | 'accounting' | 'president' | null;
  is_approver: boolean;
  is_leader_plus: boolean;
  is_manager_plus: boolean;
  is_board_approver: boolean;
  is_org_wide: boolean;
}

/** supabase の select に渡す列の並び（RoleRow と揃える） */
export const ROLE_COLUMNS = 'id, name, sort_order, is_fixed, acts_as, is_approver, is_leader_plus, is_manager_plus, is_board_approver, is_org_wide';

export type ActsAs = NonNullable<RoleRow['acts_as']>;

/** 役職が見つからないときの値（すべて false・立場なし）。🚨 NULL ではなく false に確定させる */
const NONE: Pick<RoleRow, 'acts_as' | 'is_approver' | 'is_leader_plus' | 'is_manager_plus' | 'is_board_approver' | 'is_org_wide'> = {
  acts_as: null, is_approver: false, is_leader_plus: false, is_manager_plus: false, is_board_approver: false, is_org_wide: false,
};

/**
 * PostgREST の埋め込み `roles(...)` は「1件のオブジェクト」と「配列」のどちらでも来る
 * （型推論も配列になる。2026-09-04 の場所予約でも同じ罠を踏んでいる）。どちらでも読めるようにする。
 */
export type EmbeddedRoleRow<T> = { roles?: T | T[] | null };
export function embeddedRole<T>(row: EmbeddedRoleRow<T> | null | undefined): T | null {
  const r = row?.roles;
  if (!r) return null;
  return Array.isArray(r) ? (r[0] ?? null) : r;
}

/** 役職名から行を引く。無ければ null（役職名は表示用だが、profiles.role_title が正なので名前で引く） */
export function roleByName(roles: readonly RoleRow[], name: string | null | undefined): RoleRow | null {
  if (!name) return null;
  return roles.find(r => r.name === name) ?? null;
}

/** 役職名 → 属性。役職が無ければ全部 false */
export function attrsFor(roles: readonly RoleRow[], name: string | null | undefined) {
  const r = roleByName(roles, name);
  return r ? {
    acts_as: r.acts_as, is_approver: r.is_approver, is_leader_plus: r.is_leader_plus,
    is_manager_plus: r.is_manager_plus, is_board_approver: r.is_board_approver, is_org_wide: r.is_org_wide,
  } : NONE;
}

/**
 * 序列。小さいほど上（既存の ROLE_RANK / overtime_role_rank と同じ向き）。
 * roles.sort_order は大きいほど上なので反転する（DB の role_rank() と同じ式）。
 * 役職が無ければ null（呼び出し側で「最下位扱い（99）」か「最上位扱い（1）」を選ぶ。既存の使い分けを保つ）
 */
export function rankOf(roles: readonly RoleRow[], name: string | null | undefined): number | null {
  const r = roleByName(roles, name);
  if (!r || roles.length === 0) return null;
  const max = Math.max(...roles.map(x => x.sort_order));
  return max + 1 - r.sort_order;
}

/** 役職名の並び（上位が先）。表示のグルーピングやプルダウンの順に使う */
export function rolesByRank(roles: readonly RoleRow[]): RoleRow[] {
  return [...roles].sort((a, b) => b.sort_order - a.sort_order);
}

/** 役職プレビューに出す役職（管理者＝固定行は除く）。下位が先＝既存のプルダウンと同じ並び */
export function previewRoleOptions(roles: readonly RoleRow[]): RoleRow[] {
  return [...roles].filter(r => !r.is_fixed).sort((a, b) => a.sort_order - b.sort_order);
}

/** その立場に立つ役職（複数ありうる）。通知の宛先キー（leader/manager/president）の解決に使う */
export function rolesActingAs(roles: readonly RoleRow[], pos: ActsAs): RoleRow[] {
  return roles.filter(r => r.acts_as === pos);
}

/** その立場に立つ役職の名前の配列（DB を role_title で引くときの過渡用。🚨 段5以降は role_id で引くこと） */
export function roleNamesActingAs(roles: readonly RoleRow[], ...pos: ActsAs[]): string[] {
  return roles.filter(r => r.acts_as !== null && pos.includes(r.acts_as)).map(r => r.name);
}

/** 属性が ON の役職の名前の配列（同上・過渡用） */
export function roleNamesWhere(roles: readonly RoleRow[], key: 'is_approver' | 'is_leader_plus' | 'is_manager_plus' | 'is_board_approver' | 'is_org_wide'): string[] {
  return roles.filter(r => r[key]).map(r => r.name);
}
