// 有休奨励日の「対象外の方（役員など）」（2026-10-19・計画 docs/計画-有休奨励日の申請止め.md）
// ・この人たちは、年間カレンダーの奨励日でも有給休暇・時間外調整休を止めない（DB の encouragement_block_message が読む）
// ・経理が回答の受付を作るとき、最初からチェックを外しておく
// 🚨 書けるのは管理者だけ（app_settings の決まり）
import { supabase } from './supabaseClient';

export const ENC_EXEMPT_KEY = 'encouragement_exempt';

export async function loadEncouragementExempt(): Promise<string[] | null> {
  const { data, error } = await supabase.from('app_settings').select('value').eq('key', ENC_EXEMPT_KEY).maybeSingle();
  if (error) return null;
  const ids = (data?.value as { user_ids?: unknown } | null)?.user_ids;
  return Array.isArray(ids) ? ids.map(String) : [];
}

export async function saveEncouragementExempt(ids: string[]): Promise<string | null> {
  const { data, error } = await supabase.from('app_settings')
    .upsert({ key: ENC_EXEMPT_KEY, value: { user_ids: ids }, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    .select('key');
  if (error) return error.message;
  if (!data || data.length === 0) return '保存できませんでした（権限を確かめてください）';
  return null;
}
