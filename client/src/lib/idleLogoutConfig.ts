// 共有パソコンの自動ログアウト：管理者の設定を app_settings から読む・書く（2026-09-14）
// 決めたこと・写しの理由は lib/idleLogout.ts の冒頭を見ること。
// 🚨 supabase を読むのはこのファイルだけ。計算・判定は lib/idleLogout.ts（supabase を読まない側）

import { supabase } from './supabaseClient';
import {
  DEFAULT_IDLE_CONFIG, IDLE_CONFIG_SETTING_KEY, normalizeIdleConfig, writeCachedIdleConfig,
  type IdleLogoutConfig,
} from './idleLogout';

/**
 * 本物の設定を読む。読めたら端末の写しも更新する。
 * 🚨 読めなかったとき（未ログイン・通信不良）は null を返す。呼ぶ側は写しのまま動く
 *    （既定値で上書きすると、管理者が伸ばした時間が一時的に1分へ戻る）
 */
export async function loadIdleConfig(): Promise<IdleLogoutConfig | null> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', IDLE_CONFIG_SETTING_KEY)
    .maybeSingle();
  if (error) return null;
  // 行が無い＝まだ一度も保存していない＝既定値
  const cfg = normalizeIdleConfig(data?.value ?? DEFAULT_IDLE_CONFIG);
  writeCachedIdleConfig(cfg);
  return cfg;
}

/** 管理者が保存する。失敗したら理由の文字列を返す（成功は null）。写しも更新する */
export async function saveIdleConfig(cfg: IdleLogoutConfig): Promise<string | null> {
  const value = normalizeIdleConfig(cfg);
  // 🚨 upsert は 0件でもエラーにならない。select で件数を見る
  const { data, error } = await supabase
    .from('app_settings')
    .upsert({ key: IDLE_CONFIG_SETTING_KEY, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    .select('key');
  if (error) return error.message;
  if (!data || data.length === 0) return '保存できませんでした（権限がない可能性があります）';
  writeCachedIdleConfig(value);
  return null;
}
