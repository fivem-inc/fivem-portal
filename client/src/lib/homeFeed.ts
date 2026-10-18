// ホームの新着（2026-10-18・計画 docs/計画-ホームの新着.md）。DB の my_home_feed が返す形と、数え方。
// 🚨 supabase を読まない（node で検算できる）。読むのは hooks/useHomeFeed
// 🚨 「新着」＝確認していない（acked でない）・届いた時刻（at）が、ホームを最後に見た時刻（seen_at）より後

export type HomeKind = 'payroll' | 'safety' | 'announcement' | 'reminder' | 'encouragement' | 'part_request' | 'overtime_self' | 'overtime_team';
export interface HomeItem { k: string; kind: HomeKind; at: string | null; acked: boolean }
export interface HomeFeed { seen_at: string | null; items: HomeItem[] }

/** 種類の名前（ホームのいちばん上の「新しいお知らせ」に並べる・フォーマルな言い方） */
export const HOME_KIND_LABEL: Record<HomeKind, string> = {
  payroll: '締め日のお知らせ', safety: '安否確認', announcement: '管理者からのお知らせ', reminder: '回答のお願い',
  encouragement: '有休奨励日', part_request: '出勤のお願い', overtime_self: '残業の目安超え', overtime_team: '残業の目安超え（部門）',
};

/** since（この時刻）より後に届いた、まだ確認していないお知らせ。since が無い（一度もホームを見ていない）ときは全部 */
export function newHomeItems(items: readonly HomeItem[], since: string | null): HomeItem[] {
  const t = since ? new Date(since).getTime() : -Infinity;
  return items.filter(i => !i.acked && !!i.at && new Date(i.at).getTime() > t);
}

/** 並べる種類の名前（重なりは1つ・決まった順） */
export function homeKindsText(items: readonly HomeItem[]): string {
  const order: HomeKind[] = ['safety', 'payroll', 'announcement', 'overtime_self', 'overtime_team', 'reminder', 'encouragement', 'part_request'];
  const kinds = new Set(items.map(i => i.kind));
  return order.filter(k => kinds.has(k)).map(k => HOME_KIND_LABEL[k]).join('・');
}
