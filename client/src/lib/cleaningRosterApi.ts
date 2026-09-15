// ④ 掃除担当表の読み書き（2026-09-15）。計算と表示は lib/cleaningRoster.ts（supabase を読まない側）。
// 🚨 マスの書き込みは cleaning_save（DB の関数）だけ。行・注意書き・対象外は画面から直接（件数を見る）
// 🚨 読むときは「基準日に効いている版と、それより先の版」だけ（1,000行で黙って欠けないように）
// 🚨 人の名前は在籍者に絞らずに読む（退職した人の名前が空にならないように）

import { supabase } from './supabaseClient';
import { normTime, type RosterDayKind } from './shiftRoster';
import type { CleaningCellValue, CleaningCellVersion, CleaningNote, CleaningRow } from './cleaningRoster';

export interface CleaningStaff {
  id: string;
  name: string;
  is_active: boolean;
}

export interface CleaningAck {
  cell_id: string;
  issue_key: string;
}

export interface CleaningData {
  rows: CleaningRow[];
  notes: CleaningNote[];
  cells: CleaningCellVersion[];
  acks: CleaningAck[];
  excluded: Set<string>;
  labels: Map<string, string>;
  staff: CleaningStaff[];
}

const ROW_COLS = 'id, school, floor, task, short_name, vacuum_mark, note_below, minutes, sort_order, active';

interface CellRow {
  id: string; row_id: string; day_kind: string; is_none: boolean; note: string | null; valid_from: string; valid_to: string | null;
  cleaning_cell_entries: { user_id: string; start_time: string | null; sort_order: number }[] | null;
}

/** 呼び名だけ（勉強会の欄など） */
export async function loadDisplayNames(): Promise<{ labels: Map<string, string>; error: string | null }> {
  const { data, error } = await supabase.from('staff_display_names').select('user_id, label');
  if (error) return { labels: new Map(), error: '呼び名を読み込めませんでした' };
  return { labels: new Map(((data ?? []) as { user_id: string; label: string }[]).map(r => [r.user_id, r.label])), error: null };
}

export async function loadCleaningData(sinceDate: string): Promise<{ data: CleaningData | null; error: string | null }> {
  const [rowRes, noteRes, cellRes, ackRes, exRes, labelRes, staffRes] = await Promise.all([
    supabase.from('cleaning_rows').select(ROW_COLS).order('sort_order'),
    supabase.from('cleaning_notes').select('id, kind, body, sort_order, active').order('sort_order'),
    supabase.from('cleaning_cells')
      .select('id, row_id, day_kind, is_none, note, valid_from, valid_to, cleaning_cell_entries(user_id, start_time, sort_order)')
      .or(`valid_to.is.null,valid_to.gte.${sinceDate}`)
      .order('valid_from'),
    supabase.from('cleaning_acks').select('cell_id, issue_key'),
    supabase.from('cleaning_excluded_staff').select('user_id'),
    supabase.from('staff_display_names').select('user_id, label'),
    supabase.from('profiles').select('id, name, is_active').order('name'),
  ]);
  const failed = [
    rowRes.error && '行の一覧', noteRes.error && '注意書き', cellRes.error && 'マス', ackRes.error && '確認の記録',
    exRes.error && '掃除の対象外', labelRes.error && '呼び名', staffRes.error && 'スタッフ',
  ].filter(Boolean);
  if (failed.length > 0) return { data: null, error: `${failed.join('・')}を読み込めませんでした。画面を開き直してください` };

  const cells: CleaningCellVersion[] = ((cellRes.data ?? []) as CellRow[]).map(c => ({
    id: c.id, row_id: c.row_id, day_kind: c.day_kind as RosterDayKind, is_none: c.is_none, note: c.note ?? '',
    valid_from: c.valid_from, valid_to: c.valid_to,
    entries: [...(c.cleaning_cell_entries ?? [])].sort((a, b) => a.sort_order - b.sort_order)
      .map(e => ({ user_id: e.user_id, start: normTime(e.start_time) })),
  }));
  return {
    data: {
      rows: (rowRes.data ?? []) as CleaningRow[],
      notes: (noteRes.data ?? []) as CleaningNote[],
      cells,
      acks: (ackRes.data ?? []) as CleaningAck[],
      excluded: new Set(((exRes.data ?? []) as { user_id: string }[]).map(r => r.user_id)),
      labels: new Map(((labelRes.data ?? []) as { user_id: string; label: string }[]).map(r => [r.user_id, r.label])),
      staff: (staffRes.data ?? []) as CleaningStaff[],
    },
    error: null,
  };
}

export async function loadCleaningToken(): Promise<{ token: string | null; error: string | null }> {
  const { data, error } = await supabase.rpc('cleaning_token');
  if (error) return { token: null, error: error.message };
  return { token: (data as string) ?? '', error: null };
}

export interface CleaningSaveCell extends CleaningCellValue {
  row_id: string;
  day_kind: RosterDayKind;
}

export interface CleaningSaveResult {
  ok: boolean;
  reason: 'past_confirm' | 'stale' | null;
  changed: number;
  unchanged: number;
  kept_future: { row_id: string; day_kind: string; next_from: string }[];
}

export async function saveCleaning(payload: { apply_from: string; confirm_past: boolean; base_token: string; cells: CleaningSaveCell[] })
  : Promise<{ result: CleaningSaveResult | null; error: string | null }> {
  const body = {
    ...payload,
    cells: payload.cells.map(c => ({
      row_id: c.row_id, day_kind: c.day_kind, is_none: c.is_none, note: c.note.trim() || null,
      entries: c.entries.map(e => ({ user_id: e.user_id, start: normTime(e.start) || null })),
    })),
  };
  const { data, error } = await supabase.rpc('cleaning_save', { p_payload: body });
  if (error) return { result: null, error: error.message };
  const r = data as Partial<CleaningSaveResult> | null;
  if (!r || typeof r.ok !== 'boolean') return { result: null, error: '保存の結果を確かめられませんでした' };
  return {
    result: {
      ok: r.ok, reason: (r.reason ?? null) as CleaningSaveResult['reason'],
      changed: Number(r.changed ?? 0), unchanged: Number(r.unchanged ?? 0), kept_future: r.kept_future ?? [],
    },
    error: null,
  };
}

/** ⚠️ を「確認した」にする。🚨 件数を見る（権限で弾かれても error にならないため） */
export async function ackCleaningIssue(cellId: string, issueKey: string): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return 'ログインし直してください';
  const { data, error } = await supabase.from('cleaning_acks')
    .insert({ cell_id: cellId, issue_key: issueKey, acked_by: user.id }).select('id');
  if (error) return error.code === '23505' ? null : `確認を残せませんでした：${error.message}`;
  if (!data || data.length === 0) return '確認を残せませんでした（権限がない可能性があります）';
  return null;
}

export async function setCleaningExcluded(userId: string, excluded: boolean): Promise<string | null> {
  if (excluded) {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('cleaning_excluded_staff')
      .insert({ user_id: userId, created_by: user?.id ?? null }).select('user_id');
    if (error) return error.code === '23505' ? null : `対象外にできませんでした：${error.message}`;
    if (!data || data.length === 0) return '対象外にできませんでした（権限がない可能性があります）';
    return null;
  }
  const { error } = await supabase.from('cleaning_excluded_staff').delete().eq('user_id', userId).select('user_id');
  if (error) return `対象に戻せませんでした：${error.message}`;
  return null;
}

export async function saveDisplayName(userId: string, label: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('staff_display_name_save', { p_user_id: userId, p_label: label });
  if (error) return `呼び名を保存できませんでした：${error.message}`;
  if (!(data as { ok?: boolean } | null)?.ok) return '呼び名を保存できませんでした';
  return null;
}

export type CleaningRowInput = Omit<CleaningRow, 'id'>;

export async function addCleaningRow(input: CleaningRowInput): Promise<string | null> {
  const { data, error } = await supabase.from('cleaning_rows').insert(input).select('id');
  if (error) return `行を足せませんでした：${error.message}`;
  if (!data || data.length === 0) return '行を足せませんでした（権限がない可能性があります）';
  return null;
}

export async function updateCleaningRow(id: string, patch: Partial<CleaningRowInput>): Promise<string | null> {
  const { data, error } = await supabase.from('cleaning_rows').update(patch).eq('id', id).select('id');
  if (error) return `行を直せませんでした：${error.message}`;
  if (!data || data.length === 0) return '行を直せませんでした（権限がない可能性があります）';
  return null;
}

export async function addCleaningNote(body: string, sortOrder: number): Promise<string | null> {
  const { data, error } = await supabase.from('cleaning_notes').insert({ kind: 'note', body, sort_order: sortOrder }).select('id');
  if (error) return `注意書きを足せませんでした：${error.message}`;
  if (!data || data.length === 0) return '注意書きを足せませんでした（権限がない可能性があります）';
  return null;
}

export async function updateCleaningNote(id: string, patch: Partial<Pick<CleaningNote, 'body' | 'sort_order' | 'active'>>): Promise<string | null> {
  const { data, error } = await supabase.from('cleaning_notes').update(patch).eq('id', id).select('id');
  if (error) return `注意書きを直せませんでした：${error.message}`;
  if (!data || data.length === 0) return '注意書きを直せませんでした（権限がない可能性があります）';
  return null;
}
