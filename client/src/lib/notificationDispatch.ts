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

// 設定行が無いときの既定値を指定できる版。
// shouldSend() は fail-closed（行が無ければ送らない）だが、それだと seed 漏れやRLS失敗のときに
// 静かに無通知になる。差し戻しのように「届かないと業務が止まる」通知は fallback=true で使う。
export async function shouldSendWithDefault(eventKey: string, channel: string, fallback: boolean): Promise<boolean> {
  const settings = await getSettings();
  const s = settings.find(s => s.event_key === eventKey && s.channel === channel);
  return s ? s.enabled : fallback;
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

// 氏名は profiles.name を正とする。
// ⚠️ user.user_metadata.name を使わないこと。ユーザー作成時は full_name というキーで
//    入れているため name が undefined になる人がいて、通知の申請者名が空になる。
//    管理画面で名前を変えても user_metadata 側は更新されない（更新処理は存在しない）。
export async function getUserName(userId: string): Promise<string> {
  const { data } = await supabase.from('profiles').select('name').eq('id', userId).single();
  return (data as { name?: string } | null)?.name ?? '';
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
export type RecipientMap = {
  applicant?: string | string[];
  leader?: string | string[];
  manager?: string | string[];
  approver?: string | string[];
  president?: string | string[];
};

// 宛先マップの値（string | string[] | undefined）を配列に正規化
const toList = (v: string | string[] | undefined): string[] =>
  Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []);

// 宛先キー → profiles.role_title
const ROLE_BY_RECIPIENT_KEY: Record<string, string> = {
  leader:    'リーダー',
  manager:   'マネージャー',
  president: '社長',
};
// グループ絞り込みを無視して常に届く役職の既定値（管理画面の「絞り込みの対象外にする役職」で上書き可）
const DEFAULT_ORG_WIDE_ROLES = ['社長', '管理者'];

// 宛先に選ばれた役職（リーダー・マネージャー・社長）を、申請者の所属チームで絞り込んで解決する。
// 「取り消し時」のように本人＋上長の両方へ送るイベントで使う。
//
// 🚨 group_names には所属チーム（こども/大人/管理部）と配信用グループ（正社員・契約社員 等）が
//    混在している。そのまま突き合わせると管理職は全員「正社員・契約社員」を持つため、
//    「同グループのみ」が実質「全員」になる。必ず master_options の shift_report_group と
//    照合して所属チームだけを取り出すこと（2026-08-04 に Edge Function 4本で踏んだ不具合）
// ・絞り込みの既定は「同グループのみ」。「絞り込みの対象外にする役職」はチームに関係なく全員が対象
// ・申請者本人は必ず除外する（本人宛は applicant として別途送るため）
export async function resolveRoleRecipients(
  applicantId: string,
  eventKey: string,
  channel: 'site' | 'email',
): Promise<{ ids: RecipientMap; emails: RecipientMap }> {
  const recipient = await getNotificationRecipient(eventKey, channel);
  const roleKeys = parseRecipientKeys(recipient).filter(k => ROLE_BY_RECIPIENT_KEY[k]);
  if (roleKeys.length === 0) return { ids: {}, emails: {} };

  let groupFilter = 'same';
  let orgWide = DEFAULT_ORG_WIDE_ROLES;
  try {
    const p = JSON.parse(recipient ?? '{}');
    if (p.groupFilter) groupFilter = p.groupFilter;
    if (Array.isArray(p.orgWideRoles)) orgWide = p.orgWideRoles;
  } catch { /* 旧形式（プレーン文字列）は既定のまま */ }

  let teams: string[] = [];
  if (groupFilter === 'same') {
    const [{ data: prof }, { data: teamOpts }] = await Promise.all([
      supabase.from('profiles').select('group_names').eq('id', applicantId).single(),
      supabase.from('master_options').select('value').eq('category', 'shift_report_group'),
    ]);
    const raw = (prof as { group_names?: string[] } | null)?.group_names ?? [];
    const master = ((teamOpts ?? []) as { value: string }[]).map(t => t.value);
    // マスタが取れなかったときだけ全グループで判定する（誰にも届かないより安全側に倒す）
    teams = master.length > 0 ? raw.filter(g => master.includes(g)) : raw;
  }

  const ids: RecipientMap = {};
  const emails: RecipientMap = {};
  for (const key of roleKeys) {
    const role = ROLE_BY_RECIPIENT_KEY[key];
    let q = supabase.from('profiles').select('id, email').eq('role_title', role).eq('is_active', true);
    if (groupFilter === 'same' && !orgWide.includes(role) && teams.length > 0) {
      q = q.overlaps('group_names', teams);
    }
    const { data } = await q;
    const rows = ((data ?? []) as { id: string; email: string | null }[]).filter(r => r.id !== applicantId);
    ids[key as keyof RecipientMap] = rows.map(r => r.id);
    emails[key as keyof RecipientMap] = rows.map(r => r.email).filter((e): e is string => !!e);
  }
  return { ids, emails };
}

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
