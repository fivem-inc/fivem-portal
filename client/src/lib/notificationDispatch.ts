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

// 宛先キーごとの実アドレス/ID。社長(president)など複数人になりうる宛先は配列も受け取る。
type RecipientMap = {
  applicant?: string | string[];
  leader?: string | string[];
  manager?: string | string[];
  approver?: string | string[];
  president?: string | string[];
};

// 宛先マップの値（string | string[] | undefined）を配列に正規化
const toList = (v: string | string[] | undefined): string[] =>
  Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []);

// 宛先キー（'applicant'/'leader'/'manager'/'approver'/'president'）をもとにメールアドレスを解決して送信する
export async function dispatchEmail(
  eventKey: string,
  vars: Record<string, string>,
  emails: RecipientMap
): Promise<void> {
  const settings = await getSettings();
  const s = settings.find(s => s.event_key === eventKey && s.channel === 'email');
  if (!s?.enabled || !s.template) return;
  const keys = parseRecipientKeys(s.recipient);
  const text = applyTemplate(s.template, vars);
  const subject = s.subject ? applyTemplate(s.subject, vars) : eventKey;
  const sent = new Set<string>();
  for (const key of keys) {
    for (const to of toList(emails[key as keyof RecipientMap])) {
      if (sent.has(to)) continue; // 同一アドレスへの二重送信を防ぐ
      sent.add(to);
      const { error } = await supabase.functions.invoke('send-email', { body: { to, subject, text } });
      if (error) console.error('[dispatchEmail] 送信失敗', { key, error });
    }
  }
}

// 宛先キーをもとにuser_idを解決してサイト通知を送信する
// sourceType/referenceId は省略可能（省略した場合は従来通りタップしても詳細画面に飛べない通知になる）
export async function dispatchSiteNotification(
  eventKey: string,
  vars: Record<string, string>,
  userIds: RecipientMap,
  insertFn: (userId: string, message: string, subject?: string, sourceType?: string, referenceId?: string, eventKey?: string) => Promise<void>,
  sourceType?: string,
  referenceId?: string
): Promise<void> {
  const settings = await getSettings();
  const s = settings.find(s => s.event_key === eventKey && s.channel === 'site');
  if (!s?.enabled || !s.template) return;
  const keys = parseRecipientKeys(s.recipient);
  const message = applyTemplate(s.template, vars);
  const subject = s.subject ? applyTemplate(s.subject, vars) : undefined;
  const seen = new Set<string>();
  for (const key of keys) {
    for (const userId of toList(userIds[key as keyof RecipientMap])) {
      if (seen.has(userId)) continue;
      seen.add(userId);
      // event_keyも通知本体に記録する（プッシュ通知パイプラインの判定に使う）
      await insertFn(userId, message, subject, sourceType, referenceId, eventKey);
    }
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

// 連絡板イベント用: 宛先が申請者/承認者などの固定ロールではなく実際のメッセージ受信者そのものなので専用関数にする
export async function dispatchBoardEmail(
  eventKey: 'board:notice' | 'board:dm_message' | 'board:group_message',
  vars: Record<string, string>,
  recipientUserIds: string[]
): Promise<void> {
  const tpl = await getNotificationTemplate(eventKey, 'email', vars);
  if (!tpl) return;
  await Promise.all(recipientUserIds.map(async userId => {
    const to = await getUserEmail(userId);
    if (!to) return;
    const { error } = await supabase.functions.invoke('send-email', { body: { to, subject: tpl.subject, text: tpl.template } });
    if (error) console.error('[dispatchBoardEmail] 送信失敗', { userId, error });
  }));
}
