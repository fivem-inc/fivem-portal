// 有休奨励日の休みを Google カレンダーに出す（2026-10-19・計画 docs/計画-有休奨励日のカレンダー.md）
// 作るのは共用の Edge Function gcal-sync の action 'sync_encouragement'（その日を今の記録と設定どおりにそろえる・差分だけ）。
// 🚨 回答・修正・設定の保存の「あと」に呼ぶ（状態を変えてから・今の記録から作る）。失敗しても回答や修正は止めない
//    （毎晩 3:50 に作り直すので、ここで落ちても翌朝にはそろう）
import { supabase } from './supabaseClient';

export type EncCalendarMode = 'off' | 'summary' | 'each';
export type EncCalendarType = '有休' | '調整休' | 'その他';
export interface EncCalendarSetting { mode: EncCalendarMode; types: EncCalendarType[]; names: boolean }

export const ENC_CAL_TYPES: EncCalendarType[] = ['有休', '調整休', 'その他'];
export const ENC_CAL_DEFAULT: EncCalendarSetting = { mode: 'summary', types: [...ENC_CAL_TYPES], names: true };
export const ENC_CAL_KEY = 'gcal_encouragement';

/** app_settings の値を読みやすい形に（無い・おかしいときは既定） */
export function normalizeEncCalendarSetting(v: unknown): EncCalendarSetting {
  const o = (v ?? {}) as Partial<EncCalendarSetting>;
  const mode: EncCalendarMode = o.mode === 'off' || o.mode === 'each' || o.mode === 'summary' ? o.mode : ENC_CAL_DEFAULT.mode;
  const types = Array.isArray(o.types) ? ENC_CAL_TYPES.filter(t => (o.types as string[]).includes(t)) : [...ENC_CAL_TYPES];
  return { mode, types, names: o.names !== false };
}

export interface EncSyncResult { ok: boolean; created: number; updated: number; deleted: number; days: number; error?: string }

/**
 * 奨励日の予定を作り直す。targetDate を渡すとその日だけ（在籍者なら呼べる）、渡さないとこれからの奨励日すべて（管理者だけ）
 * 🚨 functions.invoke は 4xx/5xx でも throw しない。error と success の両方を見る
 */
export async function syncEncouragementCalendar(targetDate?: string): Promise<EncSyncResult> {
  try {
    const { data, error } = await supabase.functions.invoke('gcal-sync', {
      body: { action: 'sync_encouragement', ...(targetDate ? { target_date: targetDate } : {}) },
    });
    const d = (data ?? {}) as { success?: boolean; created?: number; updated?: number; deleted?: number; days?: number; error?: string };
    if (error || !d.success) {
      const msg = d.error ?? (error instanceof Error ? error.message : '通信の状態を確かめてください');
      console.error('[gcal-sync] 有休奨励日の作り直し失敗:', msg);
      return { ok: false, created: 0, updated: 0, deleted: 0, days: 0, error: msg };
    }
    return { ok: true, created: d.created ?? 0, updated: d.updated ?? 0, deleted: d.deleted ?? 0, days: d.days ?? 0 };
  } catch (e) {
    console.error('[gcal-sync] 有休奨励日の作り直し失敗:', e);
    return { ok: false, created: 0, updated: 0, deleted: 0, days: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
