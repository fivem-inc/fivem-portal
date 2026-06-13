import { supabase } from './supabaseClient';

interface NotificationSetting {
  event_key: string;
  channel: string;
  enabled: boolean;
  recipient: string | null;
  subject: string | null;
  template: string | null;
}

let cache: NotificationSetting[] | null = null;
let cacheAt = 0;
const CACHE_TTL = 5 * 60 * 1000;

export function invalidateNotificationCache() {
  cache = null;
  cacheAt = 0;
}

async function getSettings(): Promise<NotificationSetting[]> {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL) return cache;
  const { data } = await supabase.from('notification_settings').select('*');
  cache = data ?? [];
  cacheAt = now;
  return cache;
}

export function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(.+?)\}\}/g, (_, key) => vars[key.trim()] ?? `{{${key.trim()}}}`);
}

export async function shouldSend(eventKey: string, channel: string): Promise<boolean> {
  const settings = await getSettings();
  const s = settings.find(s => s.event_key === eventKey && s.channel === channel);
  return s?.enabled ?? false;
}

export async function getNotificationRecipient(eventKey: string, channel: string): Promise<string | null> {
  const settings = await getSettings();
  const s = settings.find(s => s.event_key === eventKey && s.channel === channel);
  return s?.recipient ?? null;
}

// profilesテーブルからメールアドレスを取得する
export async function getUserEmail(userId: string): Promise<string | null> {
  const { data } = await supabase.from('profiles').select('email').eq('id', userId).single();
  return (data as { email?: string } | null)?.email ?? null;
}

// recipient フィールドを解析して宛先キーの配列を返す（新旧両形式対応）
function parseRecipientKeys(recipient: string | null): string[] {
  if (!recipient) return ['applicant'];
  try {
    const p = JSON.parse(recipient);
    if (Array.isArray(p.recipients)) return p.recipients;
  } catch { /* 旧形式: plain string */ }
  return [recipient];
}

// 宛先キー（'applicant'/'leader'/'manager'/'approver'）をもとにメールアドレスを解決して送信する
export async function dispatchEmail(
  eventKey: string,
  vars: Record<string, string>,
  emails: { applicant?: string; leader?: string; manager?: string; approver?: string }
): Promise<void> {
  const settings = await getSettings();
  const s = settings.find(s => s.event_key === eventKey && s.channel === 'email');
  if (!s?.enabled || !s.template) return;
  const keys = parseRecipientKeys(s.recipient);
  const text = applyTemplate(s.template, vars);
  const subject = s.subject ? applyTemplate(s.subject, vars) : eventKey;
  for (const key of keys) {
    const to = emails[key as keyof typeof emails];
    if (!to) continue;
    const { error } = await supabase.functions.invoke('send-email', { body: { to, subject, text } });
    if (error) console.error('[dispatchEmail] 送信失敗', { key, error });
  }
}

// 宛先キーをもとにuser_idを解決してサイト通知を送信する
export async function dispatchSiteNotification(
  eventKey: string,
  vars: Record<string, string>,
  userIds: { applicant?: string; leader?: string; manager?: string; approver?: string },
  insertFn: (userId: string, message: string, subject?: string) => Promise<void>
): Promise<void> {
  const settings = await getSettings();
  const s = settings.find(s => s.event_key === eventKey && s.channel === 'site');
  if (!s?.enabled || !s.template) return;
  const keys = parseRecipientKeys(s.recipient);
  const message = applyTemplate(s.template, vars);
  const subject = s.subject ? applyTemplate(s.subject, vars) : undefined;
  const seen = new Set<string>();
  for (const key of keys) {
    const userId = userIds[key as keyof typeof userIds];
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    await insertFn(userId, message, subject);
  }
}

export async function getNotificationTemplate(
  eventKey: string,
  channel: string,
  vars: Record<string, string>
): Promise<{ template: string; subject: string } | null> {
  const settings = await getSettings();
  const s = settings.find(s => s.event_key === eventKey && s.channel === channel);
  if (!s || !s.enabled || !s.template) return null;
  return {
    template: applyTemplate(s.template, vars),
    subject: s.subject ? applyTemplate(s.subject, vars) : '',
  };
}
