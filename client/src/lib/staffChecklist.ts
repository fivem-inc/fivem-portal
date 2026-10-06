// 入社・退職の手続きのチェック表（2026-10-06）。退職（2026-09-19）と入社（2026-10-06）で同じ画面の部品を使う。
//
// 🚨 表は別々（退職＝retire_*／入社＝hire_*）。動いている退職の表に手を入れないため。
//    どの表を読むか・誰が対象かは、この1か所（CHECKLIST）で決める。画面・ホームの案内は必ずここを通す
// 🚨 残りの数え方は lib/retire.ts の retireRemaining 1つ（入社も同じ数え方：必須で、記録が無い項目の数）

import { supabase } from './supabaseClient';
import { retireRemaining } from './retire';

export type ChecklistKind = 'hire' | 'retire';

export const CHECKLIST: Record<ChecklistKind, {
  label: string;
  items: 'hire_checklist_items' | 'retire_checklist_items';
  checks: 'hire_checklist_checks' | 'retire_checklist_checks';
  notes: 'hire_notes' | 'retire_notes';
  /** profiles の日付の列（入社日・退職日） */
  dateCol: 'hire_date' | 'retire_date';
  dateLabel: string;
}> = {
  hire:   { label: '入社', items: 'hire_checklist_items',   checks: 'hire_checklist_checks',   notes: 'hire_notes',   dateCol: 'hire_date',   dateLabel: '入社日' },
  retire: { label: '退職', items: 'retire_checklist_items', checks: 'retire_checklist_checks', notes: 'retire_notes', dateCol: 'retire_date', dateLabel: '退職日' },
};

/**
 * 対象の人を読む。🚨 入社は「入社日が入っていて、退職していない・退職日の入っていない人」。
 * 入社日は入社後も消さない列なので、ここで退職まわりを外す（退職の一覧と二重に出さない）
 */
export function peopleQuery(kind: ChecklistKind, cols: string) {
  const q = supabase.from('profiles').select(cols).not(CHECKLIST[kind].dateCol, 'is', null);
  return kind === 'hire'
    ? q.is('retire_date', null).is('retired_at', null).order('hire_date', { ascending: false })
    : q.order('retire_date', { ascending: false });
}

export interface PendingPerson { id: string; name: string; date: string; remaining: number }

/**
 * 必須が残っている人（ホームの案内・タブの人数で共用）。
 * 🚨 読めないときは空を返す（案内は補助。誤って「残っています」と出さない）
 */
export async function loadPendingPeople(kind: ChecklistKind): Promise<PendingPerson[]> {
  const c = CHECKLIST[kind];
  const pp = await peopleQuery(kind, `id, name, ${c.dateCol}`);
  if (pp.error || !pp.data || pp.data.length === 0) return [];
  const rows = pp.data as unknown as Record<string, string | null>[];
  const ids = rows.map(p => p.id as string);
  const [it, ck] = await Promise.all([
    supabase.from(c.items).select('id, required, active'),
    supabase.from(c.checks).select('user_id, item_id').in('user_id', ids),
  ]);
  if (it.error || ck.error) return [];
  return rows
    .map(p => ({
      id: p.id as string,
      name: p.name ?? '',
      date: p[c.dateCol] ?? '',
      remaining: retireRemaining(it.data ?? [], ck.data ?? [], p.id as string),
    }))
    .filter(r => r.remaining > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}
