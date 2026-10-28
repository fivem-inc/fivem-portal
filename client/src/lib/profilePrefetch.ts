// 起動のときの本人のプロフィールの受け渡し（2026-10-28 ログの量の見直し B2）。
// contexts/AuthContext が在籍の確認で profiles を読むとき、hooks/useAuth が使う列も一緒に読んでここに置く。
// useAuth はその直後（PREFETCH_FRESH_MS 以内）なら、profiles をもう1回読まずにこれを使う（前は開くたびに2回読んでいた）。
// 🚨 古い値を使い回すためのものではない。置いてから少しのあいだだけ・1回使ったら捨てる
export const PROFILE_PREFETCH_COLUMNS = 'name, role_title, role_id, employment_type, leave_request_enabled, is_faq_editor, nav_order, nav_two_row';
const PREFETCH_FRESH_MS = 30 * 1000;

export type PrefetchedProfile = Record<string, unknown>;
let slot: { userId: string; at: number; row: PrefetchedProfile } | null = null;

export function putPrefetchedProfile(userId: string, row: PrefetchedProfile): void {
  slot = { userId, at: Date.now(), row };
}

/** 置いた直後の本人の行を1回だけ受け取る（無い・古い・別の人なら null） */
export function takePrefetchedProfile(userId: string): PrefetchedProfile | null {
  const s = slot;
  slot = null;
  if (!s || s.userId !== userId || Date.now() - s.at > PREFETCH_FRESH_MS) return null;
  return s.row;
}
