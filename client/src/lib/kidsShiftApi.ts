// ⑤ こどもシフト表の読み書き（2026-09-16）。計算と表示は lib/kidsShift.ts（supabase を読まない側）。
// 🚨 マス・案・決定の書き込みは DB の関数だけ（kids_shift_save / kids_shift_plan_save / kids_shift_plan_decide）。
//    一覧・設定・レッスンできる印・書き添えは画面から直接（error と件数を見る）
// 🚨 読むときは「基準日に効いている版と、それより先の版」だけ（1,000行で黙って欠けないように）
// 🚨 人の名前は在籍者に絞らずに読む（退職した人の名前が空にならないように）

import { supabase } from './supabaseClient';
import { normTime } from './shiftRoster';
import type {
  KidsCellValue, KidsCellVersion, KidsItem, KidsPerson, KidsPlace, KidsPlan, KidsPlanCell,
  KidsRoleKind, KidsRowKind, KidsSettings, KidsStaffLite,
} from './kidsShift';

export interface KidsNote {
  id: string;
  body: string;
  sort_order: number;
  active: boolean;
}

export interface KidsData {
  places: KidsPlace[];
  rowKinds: KidsRowKind[];
  roleKinds: KidsRoleKind[];
  cells: KidsCellVersion[];
  plans: KidsPlan[];
  notes: KidsNote[];
  settings: KidsSettings;
  flags: Map<string, boolean>;
  labels: Map<string, string>;
  staff: KidsStaffLite[];
  /** 「確認した」の記録。🚨 決定済みの表のマス（cell_id）か、案のマス（plan_cell_id）のどちらかに付く */
  acks: { cell_id: string | null; plan_cell_id: string | null; issue_key: string }[];
}

interface RawPerson { user_id: string; role: string; start_time: string | null; end_time: string | null; sort_order: number }
interface RawItem {
  id: string; cell_id: string | null; plan_cell_id: string | null; kind_key: string;
  start_time: string | null; end_time: string | null; class_name: string | null;
  groups: number | null; required: number | null; min_lesson: number | null;
  role_key: string | null; is_none: boolean; note: string | null; sort_order: number;
  kids_shift_item_people: RawPerson[] | null;
}

const ITEM_COLS =
  'id, cell_id, plan_cell_id, kind_key, start_time, end_time, class_name, groups, required, min_lesson, role_key, is_none, note, sort_order,'
  + ' kids_shift_item_people(user_id, role, start_time, end_time, sort_order)';

function toItems(rows: RawItem[]): KidsCellValue {
  return [...rows].sort((a, b) => a.sort_order - b.sort_order).map<KidsItem>(r => ({
    kind: r.kind_key,
    start: normTime(r.start_time),
    end: normTime(r.end_time),
    class_name: r.class_name ?? '',
    groups: r.groups,
    required: r.required,
    min_lesson: r.min_lesson,
    role_key: r.role_key,
    is_none: r.is_none,
    note: r.note ?? '',
    people: [...(r.kids_shift_item_people ?? [])].sort((a, b) => a.sort_order - b.sort_order).map<KidsPerson>(p => ({
      user_id: p.user_id,
      role: (p.role === 'onduty' || p.role === 'support') ? p.role : 'lead',
      start: normTime(p.start_time),
      end: normTime(p.end_time),
    })),
  }));
}

const DEFAULT_SETTINGS: KidsSettings = {
  lesson_check: true,
  required_by_groups: { 1: 2, 2: 2, 3: 3 },
  min_lesson_by_groups: { 1: 2, 2: 2, 3: 2 },
  plan_limit: 10,
};

/** 表の中身（決定済みの版・案・一覧・設定）。sinceDate は「赤字の比べ先」の日 */
export async function loadKidsData(sinceDate: string): Promise<{ data: KidsData | null; error: string | null }> {
  const [placeRes, kindRes, roleRes, cellRes, planRes, noteRes, setRes, flagRes, labelRes, staffRes, areaRes, ackRes] = await Promise.all([
    supabase.from('kids_shift_places').select('id, kind, school, floor, label, sort_order, active').order('sort_order'),
    supabase.from('kids_shift_row_kinds').select('key, label, has_class, has_groups, has_people, issue_mode, sort_order, active').order('sort_order'),
    supabase.from('kids_shift_role_kinds').select('key, label, sort_order, active').order('sort_order'),
    supabase.from('kids_shift_cells')
      .select(`id, place_id, day_kind, valid_from, valid_to, kids_shift_items(${ITEM_COLS})`)
      .or(`valid_to.is.null,valid_to.gte.${sinceDate}`)
      .order('valid_from'),
    supabase.from('kids_shift_plans')
      .select('id, name, apply_from, status, archived_reason, archived_at, decided_from, revision, updated_by, updated_at')
      .order('updated_at', { ascending: false }),
    supabase.from('kids_shift_notes').select('id, body, sort_order, active').order('sort_order'),
    supabase.from('kids_shift_settings').select('lesson_check, required_by_groups, min_lesson_by_groups, plan_limit').maybeSingle(),
    supabase.from('kids_shift_staff_flags').select('user_id, can_lesson'),
    supabase.from('staff_display_names').select('user_id, label'),
    supabase.from('profiles').select('id, name, is_active, employment_type').order('name'),
    supabase.from('staff_main_work_areas').select('user_id, shift_work_areas(name)'),
    supabase.from('kids_shift_acks').select('cell_id, plan_cell_id, issue_key'),
  ]);

  const failed = [
    placeRes.error && '置き場所', kindRes.error && '行の種類', roleRes.error && '役割', cellRes.error && 'マス',
    planRes.error && '案', noteRes.error && '書き添え', setRes.error && '設定', flagRes.error && 'レッスンできる印',
    labelRes.error && '呼び名', staffRes.error && 'スタッフ', areaRes.error && 'メインの部門',
    ackRes.error && '確認した記録',
  ].filter(Boolean);
  if (failed.length > 0) return { data: null, error: `${failed.join('・')}を読み込めませんでした` };

  type AreaRow = { user_id: string; shift_work_areas: { name: string } | { name: string }[] | null };
  const areaByUser = new Map<string, string>();
  for (const r of (areaRes.data ?? []) as AreaRow[]) {
    const a = Array.isArray(r.shift_work_areas) ? r.shift_work_areas[0] : r.shift_work_areas;
    if (a?.name) areaByUser.set(r.user_id, a.name);
  }

  type CellRow = { id: string; place_id: string; day_kind: string; valid_from: string; valid_to: string | null; kids_shift_items: RawItem[] | null };
  const cells: KidsCellVersion[] = ((cellRes.data ?? []) as CellRow[]).map(c => ({
    id: c.id, place_id: c.place_id, day_kind: c.day_kind, valid_from: c.valid_from, valid_to: c.valid_to,
    items: toItems(c.kids_shift_items ?? []),
  }));

  const s = (setRes.data ?? null) as KidsSettings | null;
  return {
    data: {
      places: (placeRes.data ?? []) as KidsPlace[],
      rowKinds: (kindRes.data ?? []) as KidsRowKind[],
      roleKinds: (roleRes.data ?? []) as KidsRoleKind[],
      cells,
      plans: (planRes.data ?? []) as KidsPlan[],
      notes: (noteRes.data ?? []) as KidsNote[],
      settings: s ? {
        lesson_check: s.lesson_check,
        required_by_groups: s.required_by_groups ?? DEFAULT_SETTINGS.required_by_groups,
        min_lesson_by_groups: s.min_lesson_by_groups ?? DEFAULT_SETTINGS.min_lesson_by_groups,
        plan_limit: s.plan_limit ?? DEFAULT_SETTINGS.plan_limit,
      } : DEFAULT_SETTINGS,
      flags: new Map(((flagRes.data ?? []) as { user_id: string; can_lesson: boolean }[]).map(r => [r.user_id, r.can_lesson])),
      labels: new Map(((labelRes.data ?? []) as { user_id: string; label: string }[]).map(r => [r.user_id, r.label])),
      staff: ((staffRes.data ?? []) as { id: string; name: string; is_active: boolean; employment_type: string | null }[])
        .map<KidsStaffLite>(p => ({ ...p, main_area: areaByUser.get(p.id) ?? null })),
      acks: (ackRes.data ?? []) as { cell_id: string | null; plan_cell_id: string | null; issue_key: string }[],
    },
    error: null,
  };
}

/** 1つの案のマス（開いたときに読む。しまった案も同じ形で読める） */
export async function loadPlanCells(planId: string): Promise<{ cells: KidsPlanCell[]; error: string | null }> {
  const { data, error } = await supabase
    .from('kids_shift_plan_cells')
    .select(`id, plan_id, place_id, day_kind, base_sig, kids_shift_items(${ITEM_COLS})`)
    .eq('plan_id', planId);
  if (error) return { cells: [], error: '案の中身を読み込めませんでした' };
  type Row = { id: string; plan_id: string; place_id: string; day_kind: string; base_sig: string; kids_shift_items: RawItem[] | null };
  return {
    cells: ((data ?? []) as Row[]).map(r => ({
      id: r.id, plan_id: r.plan_id, place_id: r.place_id, day_kind: r.day_kind, base_sig: r.base_sig,
      items: toItems(r.kids_shift_items ?? []),
    })),
    error: null,
  };
}

export async function loadKidsToken(): Promise<{ token: string | null; error: string | null }> {
  const { data, error } = await supabase.rpc('kids_shift_token');
  if (error) return { token: null, error: error.message };
  return { token: (data as string) ?? null, error: null };
}

/** 送る形（DB の関数が受け取る形）にする */
export function toPayloadCells(cells: { placeId: string; day: string; items: KidsCellValue }[]) {
  return cells.map(c => ({
    place_id: c.placeId,
    day_kind: c.day,
    items: (c.items ?? []).map(it => ({
      kind: it.kind,
      start: normTime(it.start) || null,
      end: normTime(it.end) || null,
      class_name: it.class_name || null,
      groups: it.groups,
      required: it.required,
      min_lesson: it.min_lesson,
      role_key: it.role_key || null,
      is_none: it.is_none,
      note: it.note || null,
      people: (it.people ?? []).map(p => ({
        user_id: p.user_id,
        role: p.role,
        start: normTime(p.start) || null,
        end: normTime(p.end) || null,
      })),
    })),
  }));
}

export interface KidsSaveResult {
  ok: boolean;
  reason: string | null;
  changed?: number;
  unchanged?: number;
  kept_future?: { place_id: string; day_kind: string; next_from: string }[];
  error?: string | null;
  [key: string]: unknown;
}

async function callRpc(fn: string, payload: unknown): Promise<KidsSaveResult> {
  // 🚨 supabase.rpc は 4xx/5xx でも throw しない。error と ok の両方を見る
  const { data, error } = await supabase.rpc(fn, { p_payload: payload });
  if (error) return { ok: false, reason: null, error: error.message };
  const r = (data ?? {}) as KidsSaveResult;
  return { ...r, error: null };
}

/** 決定済みの表を保存する */
export function saveKidsCells(payload: {
  apply_from: string; base_token: string; confirm_past?: boolean;
  cells: ReturnType<typeof toPayloadCells>;
}): Promise<KidsSaveResult> {
  return callRpc('kids_shift_save', payload);
}

/** 案（作る・写す・名前と予定日・マス・しまう） */
export function savePlan(payload: Record<string, unknown>): Promise<KidsSaveResult> {
  return callRpc('kids_shift_plan_save', payload);
}

/** 案を決定する（confirm:false で一覧だけ・true で書き込み） */
export function decidePlan(payload: Record<string, unknown>): Promise<KidsSaveResult> {
  return callRpc('kids_shift_plan_decide', payload);
}

/** レッスンできる印（画面から直接・件数を見る） */
export async function saveLessonFlag(userId: string, canLesson: boolean | null): Promise<string | null> {
  if (canLesson === null) {
    const { error } = await supabase.from('kids_shift_staff_flags').delete().eq('user_id', userId).select('user_id');
    return error ? `保存できませんでした：${error.message}` : null;
  }
  const { data, error } = await supabase
    .from('kids_shift_staff_flags')
    .upsert({ user_id: userId, can_lesson: canLesson, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    .select('user_id');
  if (error) return `保存できませんでした：${error.message}`;
  if (!data || data.length === 0) return '保存できませんでした（権限がないか、行が見つかりません）';
  return null;
}

/** 設定（レッスンできる人の確かめ・班の数ごとの人数・案の上限） */
export async function saveKidsSettings(patch: Partial<KidsSettings>): Promise<string | null> {
  const { data, error } = await supabase
    .from('kids_shift_settings')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', true)
    .select('id');
  if (error) return `保存できませんでした：${error.message}`;
  if (!data || data.length === 0) return '保存できませんでした（権限がないか、設定の行が見つかりません）';
  return null;
}

/** 置き場所（列）の追加・並べ替え・隠す */
export async function savePlace(place: Partial<KidsPlace> & { id?: string }): Promise<string | null> {
  if (place.id) {
    const { data, error } = await supabase.from('kids_shift_places').update(place).eq('id', place.id).select('id');
    if (error) return `保存できませんでした：${error.message}`;
    if (!data || data.length === 0) return '保存できませんでした（権限がないか、行が見つかりません）';
    return null;
  }
  const { data, error } = await supabase.from('kids_shift_places').insert(place).select('id');
  if (error) return `保存できませんでした：${error.message}`;
  if (!data || data.length === 0) return '保存できませんでした（権限がないか、行が見つかりません）';
  return null;
}

/** 行の種類・役割・書き添え（同じ形） */
export async function saveMasterRow(
  table: 'kids_shift_row_kinds' | 'kids_shift_role_kinds' | 'kids_shift_notes',
  row: Record<string, unknown>, keyName: 'key' | 'id',
): Promise<string | null> {
  const key = row[keyName];
  if (key !== undefined && key !== null && key !== '' && !('__new' in row)) {
    const { data, error } = await supabase.from(table).update(row).eq(keyName, key as string).select(keyName);
    if (error) return `保存できませんでした：${error.message}`;
    if (!data || data.length === 0) return '保存できませんでした（権限がないか、行が見つかりません）';
    return null;
  }
  const insert = { ...row };
  delete insert.__new;
  const { data, error } = await supabase.from(table).insert(insert).select(keyName);
  if (error) return `保存できませんでした：${error.message}`;
  if (!data || data.length === 0) return '保存できませんでした（権限がないか、行が見つかりません）';
  return null;
}

/** ⚠️ を「確認した」にする。
 *  🚨 決定済みの表のマスなら cellId、案のマスなら planCellId を渡す（DBの決まりでどちらか一方）。
 *  🚨 二度押し（23505）は成功として扱う。すでにそうなっているので失敗ではない。
 *  🚨 0件でもエラーにならないので件数を見る。 */
export async function ackKidsIssue(
  owner: { cellId: string } | { planCellId: string }, issueKey: string,
): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return 'ログインし直してください';
  const row = 'cellId' in owner
    ? { cell_id: owner.cellId, issue_key: issueKey, acked_by: user.id }
    : { plan_cell_id: owner.planCellId, issue_key: issueKey, acked_by: user.id };
  const { data, error } = await supabase.from('kids_shift_acks').insert(row).select('id');
  if (error) return error.code === '23505' ? null : `確認を残せませんでした：${error.message}`;
  if (!data || data.length === 0) return '確認を残せませんでした（権限がない可能性があります）';
  return null;
}
