import { supabase } from './supabaseClient';

export async function insertNotification(userId: string, message: string, subMessage?: string, sourceType?: string) {
  try {
    await supabase.from('notifications').insert({ user_id: userId, message, sub_message: subMessage ?? null, source_type: sourceType ?? null });
  } catch (e) {
    console.error('通知挿入エラー:', e);
  }
}
