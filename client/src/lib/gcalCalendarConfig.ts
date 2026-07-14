import { supabase } from './supabaseClient';

// 休暇/欠勤の書き込み先 Google カレンダーの切替（本番／テスト）。
// app_settings（key/value形式）に1レコード（jsonb）で保存し、gcal-sync がこれを読んで
// 使うシークレット（GCAL_CALENDAR_ID_PROD / GCAL_CALENDAR_ID）を切り替える。
export const GCAL_MODE_KEY = 'gcal_calendar_mode';

export type GcalMode = 'production' | 'test';

// 未設定・取得失敗時は 'test'（現行維持）。
export const fetchGcalMode = async (): Promise<GcalMode> => {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', GCAL_MODE_KEY)
    .maybeSingle();
  if (error || !data?.value || typeof data.value !== 'object') return 'test';
  return (data.value as { mode?: string }).mode === 'production' ? 'production' : 'test';
};

export const setGcalMode = async (mode: GcalMode) => {
  return supabase
    .from('app_settings')
    .upsert({ key: GCAL_MODE_KEY, value: { mode }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
};
