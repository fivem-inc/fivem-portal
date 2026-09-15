// ③ 勉強会の読み書き（2026-09-15）。計算と表示は lib/studySessions.ts（supabase を読まない側）。
// 🚨 書き込みは study_sessions_save（DB の関数）だけ。版・参加者の表に画面から直接書かない
// 🚨 参加者の名前は在籍中の人に絞らずに読む（退職した人の名前が空にならないように）

import { supabase } from './supabaseClient';
import type { RosterDayKind } from './shiftRoster';
import type { StudyVersion } from './studySessions';

export interface StudyStaff {
  id: string;
  name: string;
  is_active: boolean;
  employment_type: string | null;
  role_title: string;
}

export interface StudyAck {
  version_id: string;
  issue_key: string;
  acked_by: string;
  acked_at: string;
}

export interface StudyData {
  versions: StudyVersion[];
  acks: StudyAck[];
  staff: StudyStaff[];
  floors: Record<string, string[]>;
  showSelf: boolean;
}

interface VersionRow extends Omit<StudyVersion, 'members'> {
  study_session_members: { user_id: string; sort_order: number }[] | null;
}

/** sinceDate に効いている版と、それより先の版 */
export async function loadStudyData(sinceDate: string): Promise<{ data: StudyData | null; error: string | null }> {
  const [verRes, ackRes, staffRes, floorRes, setRes] = await Promise.all([
    supabase.from('study_session_versions')
      .select('id, session_id, day_kind, start_time, duration_minutes, location, floor, memo, valid_from, valid_to, study_session_members(user_id, sort_order)')
      .or(`valid_to.is.null,valid_to.gte.${sinceDate}`)
      .order('valid_from'),
    supabase.from('study_session_acks').select('version_id, issue_key, acked_by, acked_at'),
    supabase.from('profiles').select('id, name, is_active, employment_type, role_title').order('name'),
    supabase.from('master_options').select('category, value, sort_order').like('category', 'floor_%').order('sort_order'),
    supabase.from('app_settings').select('value').eq('key', 'study_sessions_show_self').maybeSingle(),
  ]);
  const failed = [
    verRes.error && '勉強会', ackRes.error && '確認の記録', staffRes.error && 'スタッフ',
    floorRes.error && '階の一覧', setRes.error && '本人に見せる設定',
  ].filter(Boolean);
  if (failed.length > 0) return { data: null, error: `${failed.join('・')}を読み込めませんでした。画面を開き直してください` };

  const versions: StudyVersion[] = ((verRes.data ?? []) as VersionRow[]).map(r => ({
    id: r.id, session_id: r.session_id, day_kind: r.day_kind as RosterDayKind, start_time: r.start_time,
    duration_minutes: r.duration_minutes, location: r.location, floor: r.floor, memo: r.memo,
    valid_from: r.valid_from, valid_to: r.valid_to,
    members: [...(r.study_session_members ?? [])].sort((a, b) => a.sort_order - b.sort_order).map(m => m.user_id),
  }));
  const floors: Record<string, string[]> = {};
  for (const f of (floorRes.data ?? []) as { category: string; value: string }[]) {
    const school = f.category.slice('floor_'.length);
    floors[school] = [...(floors[school] ?? []), f.value];
  }
  return {
    data: {
      versions,
      acks: (ackRes.data ?? []) as StudyAck[],
      staff: (staffRes.data ?? []) as StudyStaff[],
      floors,
      showSelf: setRes.data?.value === true,
    },
    error: null,
  };
}

export async function loadStudyToken(): Promise<{ token: string | null; error: string | null }> {
  const { data, error } = await supabase.rpc('study_sessions_token');
  if (error) return { token: null, error: error.message };
  return { token: (data as string) ?? '', error: null };
}

export interface StudySavePayload {
  action: 'upsert' | 'end';
  session_id: string | null;
  apply_from: string;
  confirm_past: boolean;
  base_token: string;
  day_kind?: RosterDayKind;
  start?: string;
  duration_minutes?: number;
  location?: string | null;
  floor?: string | null;
  memo?: string | null;
  members?: string[];
}

export interface StudySaveResult {
  ok: boolean;
  reason: 'past_confirm' | 'stale' | null;
  session_id: string | null;
  changed: boolean;
  deleted_future: { valid_from: string; day_kind: string; start: string }[];
}

export async function saveStudy(payload: StudySavePayload): Promise<{ result: StudySaveResult | null; error: string | null }> {
  const { data, error } = await supabase.rpc('study_sessions_save', { p_payload: payload });
  if (error) return { result: null, error: error.message };
  const r = data as Partial<StudySaveResult> | null;
  if (!r || typeof r.ok !== 'boolean') return { result: null, error: '保存の結果を確かめられませんでした' };
  return {
    result: {
      ok: r.ok, reason: (r.reason ?? null) as StudySaveResult['reason'], session_id: r.session_id ?? null,
      changed: !!r.changed, deleted_future: r.deleted_future ?? [],
    },
    error: null,
  };
}

/** ⚠️ 印を「確認した」にする。🚨 件数を見る（権限で弾かれても error にならないため） */
export async function ackStudyIssue(versionId: string, issueKey: string): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return 'ログインし直してください';
  const { data, error } = await supabase.from('study_session_acks')
    .insert({ version_id: versionId, issue_key: issueKey, acked_by: user.id }).select('id');
  if (error) return error.code === '23505' ? null : `確認を残せませんでした：${error.message}`;
  if (!data || data.length === 0) return '確認を残せませんでした（権限がない可能性があります）';
  return null;
}

/** 本人に見せる切り替え（管理者だけ）。🚨 upsert は 0件でもエラーにならないので件数を見る */
export async function setStudyShowSelf(on: boolean): Promise<string | null> {
  const { data, error } = await supabase.from('app_settings')
    .upsert({ key: 'study_sessions_show_self', value: on, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    .select('key');
  if (error) return `切り替えられませんでした：${error.message}`;
  if (!data || data.length === 0) return '切り替えられませんでした（管理者だけが切り替えられます）';
  return null;
}

export interface MyStudyRow {
  session_id: string;
  day_kind: RosterDayKind;
  start_time: string;
  duration_minutes: number;
  location: string | null;
  floor: string | null;
  memo: string | null;
  valid_from: string;
  valid_to: string | null;
  member_names: string[];
}

/** 本人の勉強会（切り替えがオフなら空が返る） */
export async function loadMyStudySessions(date: string): Promise<{ rows: MyStudyRow[]; error: string | null }> {
  const { data, error } = await supabase.rpc('my_study_sessions', { p_date: date });
  if (error) return { rows: [], error: '勉強会を読み込めませんでした' };
  return { rows: (data ?? []) as MyStudyRow[], error: null };
}
