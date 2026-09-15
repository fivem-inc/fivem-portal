// シフト管理（勤務表）の読み書き（2026-09-15）。計算と表示は lib/shiftRoster.ts（supabase を読まない側）。
// 🚨 書き込みは shift_patterns_save（DB の関数）だけ。weekly_shift_patterns に画面から直接書かない
//    （書き込みの許可は管理者だけのまま。関数が形を確かめ、先の版を残し、途中で失敗したら何も残さない）
// 🚨 読むときは「基準日に効いている行と、それより先の行」だけにする。条件なしで読むと1,000行で黙って欠ける

import { supabase } from './supabaseClient';
import type { PatternRowLike, RosterDayKind, RosterSegment, WorkArea } from './shiftRoster';

export interface RosterStaff {
  id: string;
  name: string;
  role_title: string;
  employment_type: string | null;
}

export interface RosterPatternRow extends PatternRowLike {
  id: string;
  user_id: string;
  break_minutes: number;
  labor_minutes: number;
}

export interface PersonNoteRow {
  id: string;
  user_id: string;
  note: string;
  valid_from: string;
  valid_to: string | null;
}

export interface RosterData {
  staff: RosterStaff[];
  areas: WorkArea[];
  mainAreas: Record<string, string>;
  patterns: RosterPatternRow[];
  notes: PersonNoteRow[];
  workplaces: string[];
}

const PATTERN_COLS = 'id, user_id, day_kind, start_time, end_time, start_time2, end_time2, location, segments, note, break_minutes, labor_minutes, valid_from, valid_to';

/** 基準日（sinceDate）に効いている行と、それより先の行を読む。失敗したら理由 */
export async function loadRosterData(sinceDate: string): Promise<{ data: RosterData | null; error: string | null }> {
  const [staffRes, areaRes, mainRes, patRes, noteRes, wpRes] = await Promise.all([
    supabase.from('profiles').select('id, name, role_title, employment_type').eq('is_active', true).order('name'),
    supabase.from('shift_work_areas').select('id, name, short_name, color, sort_order, active').order('sort_order'),
    supabase.from('staff_main_work_areas').select('user_id, area_id'),
    supabase.from('weekly_shift_patterns').select(PATTERN_COLS)
      .or(`valid_to.is.null,valid_to.gte.${sinceDate}`)
      .order('valid_from'),
    supabase.from('weekly_shift_person_notes').select('id, user_id, note, valid_from, valid_to')
      .or(`valid_to.is.null,valid_to.gte.${sinceDate}`),
    supabase.from('master_options').select('value').eq('category', 'workplace').order('sort_order'),
  ]);
  const failed = [
    staffRes.error && 'スタッフ', areaRes.error && '部門', mainRes.error && 'メインの部門',
    patRes.error && '週のシフト', noteRes.error && '書き添え', wpRes.error && '校の一覧',
  ].filter(Boolean);
  if (failed.length > 0) return { data: null, error: `${failed.join('・')}を読み込めませんでした。画面を開き直してください` };
  const mainAreas: Record<string, string> = {};
  for (const r of (mainRes.data ?? []) as { user_id: string; area_id: string }[]) mainAreas[r.user_id] = r.area_id;
  return {
    data: {
      staff: (staffRes.data ?? []) as RosterStaff[],
      areas: (areaRes.data ?? []) as WorkArea[],
      mainAreas,
      patterns: (patRes.data ?? []) as RosterPatternRow[],
      notes: (noteRes.data ?? []) as PersonNoteRow[],
      workplaces: ((wpRes.data ?? []) as { value: string }[]).map(r => r.value),
    },
    error: null,
  };
}

/** 1人の過去の版（開いた中の「過去の履歴」用） */
export async function loadPersonHistory(userId: string): Promise<{ rows: RosterPatternRow[]; error: string | null }> {
  const { data, error } = await supabase.from('weekly_shift_patterns').select(PATTERN_COLS)
    .eq('user_id', userId).order('valid_from', { ascending: false }).limit(300);
  if (error) return { rows: [], error: '過去の履歴を読み込めませんでした' };
  return { rows: (data ?? []) as RosterPatternRow[], error: null };
}

/** 開いた時点の目印（保存のときに、別の人が先に保存していないかを確かめる） */
export async function loadRosterToken(userIds: string[]): Promise<{ token: string | null; error: string | null }> {
  const { data, error } = await supabase.rpc('shift_patterns_token', { p_user_ids: userIds });
  if (error) return { token: null, error: error.message };
  return { token: (data as string) ?? '', error: null };
}

export interface SavePerson {
  user_id: string;
  main_area_id?: string;
  person_note?: string;
  days?: Partial<Record<RosterDayKind, { segments: RosterSegment[]; note: string }>>;
}

export interface SaveResult {
  ok: boolean;
  reason: 'past_confirm' | 'stale' | null;
  changed_people: number;
  unchanged_people: number;
  rows_written: number;
  kept_future: { user_id: string; name: string; day_kind: RosterDayKind; until: string }[];
  main_area_changed: number;
}

export async function saveRoster(payload: {
  apply_from: string; confirm_past: boolean; base_token: string; people: SavePerson[];
}): Promise<{ result: SaveResult | null; error: string | null }> {
  const { data, error } = await supabase.rpc('shift_patterns_save', { p_payload: payload });
  if (error) return { result: null, error: error.message };
  const r = data as Partial<SaveResult> | null;
  if (!r || typeof r.ok !== 'boolean') return { result: null, error: '保存の結果を確かめられませんでした' };
  return {
    result: {
      ok: r.ok, reason: (r.reason ?? null) as SaveResult['reason'],
      changed_people: r.changed_people ?? 0, unchanged_people: r.unchanged_people ?? 0,
      rows_written: r.rows_written ?? 0, kept_future: r.kept_future ?? [], main_area_changed: r.main_area_changed ?? 0,
    },
    error: null,
  };
}

/** 部門を足す。🚨 件数を見る（権限で弾かれても error にならないため） */
export async function addWorkArea(input: { name: string; short_name: string; color: string; sort_order: number }): Promise<string | null> {
  const { data, error } = await supabase.from('shift_work_areas').insert(input).select('id');
  if (error) return error.code === '23505' ? '同じ名前の部門がすでにあります' : `部門を追加できませんでした：${error.message}`;
  if (!data || data.length === 0) return '部門を追加できませんでした（権限がない可能性があります）';
  return null;
}

/** 部門を直す（名前・短い名前・色・並び・隠す） */
export async function updateWorkArea(id: string, patch: Partial<Pick<WorkArea, 'name' | 'short_name' | 'color' | 'sort_order' | 'active'>>): Promise<string | null> {
  const { data, error } = await supabase.from('shift_work_areas').update(patch).eq('id', id).select('id');
  if (error) return error.code === '23505' ? '同じ名前の部門がすでにあります' : `部門を直せませんでした：${error.message}`;
  if (!data || data.length === 0) return '部門を直せませんでした（権限がない可能性があります）';
  return null;
}
