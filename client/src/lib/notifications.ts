import { supabase } from './supabaseClient';

export async function insertNotification(userId: string, message: string, subMessage?: string, sourceType?: string, referenceId?: string, eventKey?: string) {
  try {
    await supabase.from('notifications').insert({ user_id: userId, message, sub_message: subMessage ?? null, source_type: sourceType ?? null, reference_id: referenceId ?? null, event_key: eventKey ?? null });
  } catch (e) {
    console.error('通知挿入エラー:', e);
  }
}
