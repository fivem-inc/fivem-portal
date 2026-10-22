// ⑤ こどもシフト表の読み書き（2026-09-16）。計算と表示は lib/kidsShift.ts（supabase を読まない側）。
// 🚨 マス・案・決定の書き込みは DB の関数だけ（kids_shift_save / kids_shift_plan_save / kids_shift_plan_decide）。
//    一覧・設定・レッスンできる印・書き添えは画面から直接（error と件数を見る）
// 🚨 読むときは「基準日に効いている版と、それより先の版」だけ（1,000行で黙って欠けないように）
// 🚨 人の名前は在籍者に絞らずに読む（退職した人の名前が空にならないように）

import { isShiftRosterMember, PREHIRE_COLS, type PrehireFields } from './staffState';
import { supabase } from './supabaseClient';
import { normTime } from './shiftRoster';
import type {
  ShiftBoard,
  KidsCellValue, KidsCellVersion, KidsItem, KidsPerson, KidsPlace, KidsPlan, KidsPlanCell,
  KidsRoleKind, KidsRowKind, KidsSettings, KidsStaffLite, TripLocationOption,
  KidsTemp, KidsPlanPerson, KidsPlanPersonDay,
} from './kidsShift';
import { isTempId, tempIdOf, tempKey } from './kidsShift';

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
  /** 出張の行き先リスト（出張報告と同じ・終了した行も読む＝古いマスの名前を出すため・2026-10-14） */
  tripLocations: TripLocationOption[];
  /** 仮の人（この表の分・2026-10-22） */
  temps: KidsTemp[];
  /** 週の目標時間（決定済みの表のぶん・人ごと・分）。行が無い正社員は40時間 */
  targets: Map<string, number>;
}

interface RawPerson { user_id: string | null; temp_id: string | null; role: string; start_time: string | null; end_time: string | null; sort_order: number }
interface RawItem {
  id: string; cell_id: string | null; plan_cell_id: string | null; kind_key: string;
  start_time: string | null; end_time: string | null; class_name: string | null;
  groups: number | null; required: number | null; min_lesson: number | null;
  role_key: string | null; is_none: boolean; note: string | null; sort_order: number;
  split_time: string | null; video: string | null; use_pool: boolean | null; trip_location_id: string | null;
  kids_shift_item_people: RawPerson[] | null;
}

const ITEM_COLS =
  'id, cell_id, plan_cell_id, kind_key, start_time, end_time, class_name, groups, required, min_lesson, role_key, is_none, note, sort_order,'
  + ' split_time, video, use_pool, trip_location_id,'
  + ' kids_shift_item_people(user_id, temp_id, role, start_time, end_time, sort_order)';

/**
 * 行き先の「表の名前」（短い名前 → 無ければリストの名前）。loadKidsData が入れ、toItems が使う（2026-10-14）。
 * 🚨 行き先があるマスは、表の名前をクラス名として見せる（印刷・Excel・人ごとの表もクラス名を読むため）。
 *    短い名前を直すと、DB のクラス名は次にそのマスを保存したときに変わる（それまでも画面はこの名前で出る）
 */
let tripLabels = new Map<string, string>();

function toItems(rows: RawItem[]): KidsCellValue {
  return [...rows].sort((a, b) => a.sort_order - b.sort_order).map<KidsItem>(r => ({
    kind: r.kind_key,
    start: normTime(r.start_time),
    end: normTime(r.end_time),
    class_name: (r.trip_location_id ? tripLabels.get(r.trip_location_id) : undefined) ?? r.class_name ?? '',
    groups: r.groups,
    required: r.required,
    min_lesson: r.min_lesson,
    role_key: r.role_key,
    is_none: r.is_none,
    note: r.note ?? '',
    people: [...(r.kids_shift_item_people ?? [])].sort((a, b) => a.sort_order - b.sort_order).map<KidsPerson>(p => ({
      // 🚨 仮の人は 'temp:<id>' で持つ（画面の名前・重なり・署名がそのまま使える・2026-10-22）
      user_id: p.user_id ?? (p.temp_id ? tempKey(p.temp_id) : ''),
      // 🚨 知らない役割も 'lead' に変えずにそのまま持つ（大人の役割を読んだときに書き換えないため・2026-10-06）
      role: (p.role || 'lead') as KidsPerson['role'],
      start: normTime(p.start_time),
      end: normTime(p.end_time),
    })),
    split_time: normTime(r.split_time),
    video: r.video === 'first' || r.video === 'second' ? r.video : null,
    use_pool: r.use_pool === true,
    trip_location_id: r.trip_location_id ?? null,
  }));
}

const DEFAULT_SETTINGS: KidsSettings = {
  lesson_check: true,
  required_by_groups: { 1: 2, 2: 2, 3: 3 },
  min_lesson_by_groups: { 1: 2, 2: 2, 3: 2 },
  plan_limit: 10,
  pre_minutes: 30,
  post_minutes: 15,
  gap_split_minutes: 60,
};

/**
 * 表の中身（決定済みの版・案・一覧・設定）。sinceDate は「赤字の比べ先」の日。
 * 🚨 board でその表の分だけ読む（2026-10-06：大人シフト表も同じ表で持つため。絞らないと大人の列がこどもの表に出る）
 */
export async function loadKidsData(sinceDate: string, board: ShiftBoard = 'kids'): Promise<{ data: KidsData | null; error: string | null }> {
  const [placeRes, kindRes, roleRes, cellRes, planRes, noteRes, setRes, flagRes, labelRes, staffRes, areaRes, ackRes, tripRes, tempRes, targetRes] = await Promise.all([
    supabase.from('kids_shift_places').select('id, board, kind, school, floor, label, sort_order, active').eq('board', board).order('sort_order'),
    supabase.from('kids_shift_row_kinds').select('key, label, has_class, has_groups, has_people, issue_mode, sort_order, active, boards, default_minutes, counts_as_lesson')
      .contains('boards', [board]).order('sort_order'),
    supabase.from('kids_shift_role_kinds').select('key, label, sort_order, active').order('sort_order'),
    supabase.from('kids_shift_cells')
      .select(`id, place_id, day_kind, valid_from, valid_to, kids_shift_items(${ITEM_COLS}), kids_shift_places!inner(board)`)
      .eq('kids_shift_places.board', board)
      .or(`valid_to.is.null,valid_to.gte.${sinceDate}`)
      .order('valid_from'),
    supabase.from('kids_shift_plans')
      .select('id, board, name, apply_from, status, archived_reason, archived_at, decided_from, revision, updated_by, updated_at, memo')
      .eq('board', board)
      .order('updated_at', { ascending: false }),
    supabase.from('kids_shift_notes').select('id, body, sort_order, active').eq('board', board).order('sort_order'),
    supabase.from('kids_shift_settings').select('lesson_check, required_by_groups, min_lesson_by_groups, plan_limit, pre_minutes, post_minutes, gap_split_minutes').maybeSingle(),
    supabase.from('kids_shift_staff_flags').select('user_id, can_lesson'),
    supabase.from('staff_display_names').select('user_id, label'),
    supabase.from('profiles').select(`id, name, employment_type, ${PREHIRE_COLS}`).order('name'),
    supabase.from('staff_main_work_areas').select('user_id, shift_work_areas(name)'),
    supabase.from('kids_shift_acks').select('cell_id, plan_cell_id, issue_key'),
    supabase.from('master_options').select('id, category, value, short_label, sort_order, ended_at').like('category', 'trip_location_%').order('sort_order'),
    supabase.from('kids_shift_temps').select('id, board, label, note').eq('board', board).order('created_at'),
    supabase.from('kids_shift_person_targets').select('user_id, weekly_minutes'),
  ]);

  const failed = [
    placeRes.error && '置き場所', kindRes.error && '行の種類', roleRes.error && '役割', cellRes.error && 'マス',
    planRes.error && '案', noteRes.error && '書き添え', setRes.error && '設定', flagRes.error && 'レッスンできる印',
    labelRes.error && '呼び名', staffRes.error && 'スタッフ', areaRes.error && 'メインの部門',
    ackRes.error && '確認した記録', tripRes.error && '出張の行き先', tempRes.error && '仮の人', targetRes.error && '週の目標時間',
  ].filter(Boolean);
  if (failed.length > 0) return { data: null, error: `${failed.join('・')}を読み込めませんでした` };

  type AreaRow = { user_id: string; shift_work_areas: { name: string } | { name: string }[] | null };
  const areaByUser = new Map<string, string>();
  for (const r of (areaRes.data ?? []) as AreaRow[]) {
    const a = Array.isArray(r.shift_work_areas) ? r.shift_work_areas[0] : r.shift_work_areas;
    if (a?.name) areaByUser.set(r.user_id, a.name);
  }

  const tripLocations = (tripRes.data ?? []) as TripLocationOption[];
  tripLabels = new Map(tripLocations.map(o => [o.id, o.short_label || o.value]));

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
        pre_minutes: s.pre_minutes ?? DEFAULT_SETTINGS.pre_minutes,
        post_minutes: s.post_minutes ?? DEFAULT_SETTINGS.post_minutes,
        gap_split_minutes: s.gap_split_minutes ?? DEFAULT_SETTINGS.gap_split_minutes,
      } : DEFAULT_SETTINGS,
      flags: new Map(((flagRes.data ?? []) as { user_id: string; can_lesson: boolean }[]).map(r => [r.user_id, r.can_lesson])),
      labels: new Map(((labelRes.data ?? []) as { user_id: string; label: string }[]).map(r => [r.user_id, r.label])),
      // 🚨 is_active は「シフト管理に出す人か」に置き換える（入社予定の人も出す・2026-10-04）
      staff: ((staffRes.data ?? []) as ({ id: string; name: string; employment_type: string | null } & PrehireFields)[])
        .map<KidsStaffLite>(p => ({ id: p.id, name: p.name, employment_type: p.employment_type, is_active: isShiftRosterMember(p), main_area: areaByUser.get(p.id) ?? null })),
      acks: (ackRes.data ?? []) as { cell_id: string | null; plan_cell_id: string | null; issue_key: string }[],
      tripLocations,
      temps: (tempRes.data ?? []) as KidsTemp[],
      targets: new Map(((targetRes.data ?? []) as { user_id: string; weekly_minutes: number }[]).map(r => [r.user_id, r.weekly_minutes])),
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

export async function loadKidsToken(board: ShiftBoard = 'kids'): Promise<{ token: string | null; error: string | null }> {
  // 🚨 表ごとの token（こどもを保存しても大人の画面は「ほかの人が変えました」にならない）
  const { data, error } = await supabase.rpc('kids_shift_token', { p_board: board });
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
      split_time: normTime(it.split_time) || null,
      video: it.video,
      use_pool: it.use_pool,
      trip_location_id: it.trip_location_id || null,
      // 🚨 仮の人は temp_id で送る（DB の kids_shift_check_items／put_items）
      people: (it.people ?? []).map(p => ({
        user_id: isTempId(p.user_id) ? null : p.user_id,
        temp_id: isTempId(p.user_id) ? tempIdOf(p.user_id) : null,
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
  /** 省略＝こども（DB の既定） */
  board?: ShiftBoard;
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
/**
 * 出張の行き先の「表の名前」（短い名前）を変える（2026-10-14）。その場で保存（シフト表の［保存］とは別）。
 * 🚨 書けるのはシフト表を直せる人と管理者だけ（DB の master_option_set_short_label が確かめる）。空にするとリストの名前に戻る
 */
export async function setTripShortLabel(id: string, label: string): Promise<string | null> {
  const { error } = await supabase.rpc('master_option_set_short_label', { p_id: id, p_label: label });
  return error ? error.message : null;
}

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

// ── 週のまとめ・案の前提・仮の人（2026-10-22・docs/計画-シフト表の時間と週休.md） ──────────────

/** 案の前提（人ごと・人と曜日ごと）。key は user_id か 'temp:<id>' */
export async function loadPlanTerms(planId: string): Promise<{ people: KidsPlanPerson[]; days: KidsPlanPersonDay[]; error: string | null }> {
  const [p, d] = await Promise.all([
    supabase.from('kids_shift_plan_people').select('user_id, temp_id, weekly_off, weekly_minutes, daily_minutes, keep, keep_reason').eq('plan_id', planId),
    supabase.from('kids_shift_plan_person_days').select('user_id, temp_id, day_kind, start_time, end_time, office').eq('plan_id', planId),
  ]);
  if (p.error || d.error) return { people: [], days: [], error: '案の前提を読み込めませんでした' };
  type P = { user_id: string | null; temp_id: string | null; weekly_off: number | null; weekly_minutes: number | null; daily_minutes: number | null; keep: boolean; keep_reason: string | null };
  type D = { user_id: string | null; temp_id: string | null; day_kind: string; start_time: string | null; end_time: string | null; office: { start: string; end: string }[] | null };
  const keyOf = (u: string | null, t: string | null) => u ?? (t ? tempKey(t) : '');
  return {
    people: ((p.data ?? []) as P[]).map(r => ({
      key: keyOf(r.user_id, r.temp_id), weekly_off: r.weekly_off, weekly_minutes: r.weekly_minutes, daily_minutes: r.daily_minutes,
      keep: r.keep, keep_reason: r.keep_reason,
    })),
    days: ((d.data ?? []) as D[]).map(r => ({
      key: keyOf(r.user_id, r.temp_id), day_kind: r.day_kind, start: normTime(r.start_time), end: normTime(r.end_time),
      office: (r.office ?? []).map(o => ({ start: normTime(o.start), end: normTime(o.end) })),
    })),
    error: null,
  };
}

/** 案の前提を送る形（1人ぶん）。days を入れたときだけ、その人の曜日の分を丸ごと入れ替える */
export function termsPayload(t: KidsPlanPerson, days?: KidsPlanPersonDay[]) {
  const who = isTempId(t.key) ? { temp_id: tempIdOf(t.key) } : { user_id: t.key };
  return {
    ...who,
    weekly_off: t.weekly_off == null ? '' : String(t.weekly_off),
    weekly_minutes: t.weekly_minutes == null ? '' : String(t.weekly_minutes),
    daily_minutes: t.daily_minutes == null ? '' : String(t.daily_minutes),
    keep: t.keep,
    keep_reason: t.keep_reason ?? '',
    ...(days ? { days: days.map(d => ({ day_kind: d.day_kind, start: d.start, end: d.end, office: d.office })) } : {}),
  };
}

/** 案のメモを保存する（2026-10-22・案の revision は上げない）。エラーの文を返す */
export async function setPlanMemo(planId: string, memo: string): Promise<string | null> {
  // 🚨 supabase.rpc は失敗しても throw しない。error と ok の両方を見る
  const { data, error } = await supabase.rpc('kids_shift_plan_set_memo', { p_plan_id: planId, p_memo: memo });
  if (error) return `メモを保存できませんでした：${error.message}`;
  if (!(data as { ok?: boolean } | null)?.ok) return 'この案は過去の案に移されています。';
  return null;
}

/** 案の前提を保存する（DB の kids_shift_plan_save op='terms'・案の revision を見る） */
export function savePlanTerms(planId: string, revision: number, people: ReturnType<typeof termsPayload>[]): Promise<KidsSaveResult> {
  return callRpc('kids_shift_plan_save', { op: 'terms', plan_id: planId, revision, people });
}

/** 仮の人を入社した人に置き換える（この案のマスと前提だけ） */
export function assignTemp(planId: string, revision: number, tempId: string, userId: string): Promise<KidsSaveResult> {
  return callRpc('kids_shift_plan_save', { op: 'assign_temp', plan_id: planId, revision, temp_id: tempId, user_id: userId });
}

/** 仮の人を作る（表ごとに「仮1」「仮2」…） */
export async function createTemp(board: ShiftBoard, label: string, note: string): Promise<{ id: string | null; error: string | null }> {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase.from('kids_shift_temps')
    .insert({ board, label: label.trim(), note: note.trim() || null, created_by: user?.id ?? null }).select('id');
  if (error) return { id: null, error: error.code === '23505' ? '同じ名前の仮の人がいます。別の名前にしてください' : `仮の人を作れませんでした：${error.message}` };
  if (!data || data.length === 0) return { id: null, error: '仮の人を作れませんでした（権限がない可能性があります）' };
  return { id: (data[0] as { id: string }).id, error: null };
}

/** 仮の人を消す（🚨 どのマスにも入っていないときだけ消せる＝DB が止める） */
export async function deleteTemp(id: string): Promise<string | null> {
  const { data, error } = await supabase.from('kids_shift_temps').delete().eq('id', id).select('id');
  if (error) return error.code === '23503' ? 'まだどこかの案のマスに入っています。先にマスから外すか、入社した人に置き換えてください' : `消せませんでした：${error.message}`;
  if (!data || data.length === 0) return '消せませんでした（権限がないか、もう消えています）';
  return null;
}

/** 週の目標時間（決定済みの表のぶん）。minutes=null で既定（正社員 40時間）に戻す */
export async function saveWeeklyTarget(userId: string, minutes: number | null): Promise<string | null> {
  if (minutes == null) {
    const { error } = await supabase.from('kids_shift_person_targets').delete().eq('user_id', userId).select('user_id');
    return error ? `保存できませんでした：${error.message}` : null;
  }
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase.from('kids_shift_person_targets')
    .upsert({ user_id: userId, weekly_minutes: minutes, updated_by: user?.id ?? null, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    .select('user_id');
  if (error) return `保存できませんでした：${error.message}`;
  if (!data || data.length === 0) return '保存できませんでした（権限がない可能性があります）';
  return null;
}
