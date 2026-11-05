import { supabase } from './supabaseClient';

// 社内お知らせ（管理者が全スタッフのホーム上部に出す連絡）。
// テーブルそのものが「いつ何を出したか」の履歴を兼ねる。
//
// 表示期間: starts_at（空=すぐ表示）〜 ends_at（空=無期限・手動停止まで）。
//   保存時、開始日は JST 00:00:00、終了日は JST 23:59:59 に丸める（丸め処理は呼び出し側）。
//   これにより「終了日いっぱい」表示され、期限日の朝に消えるオフバイワンを防ぐ。
// リマインド: 終了日の remind_days_before 日前になったら念押しする。
//   remind_in_app … アプリを開いたとき、一度閉じた人にもバナーを再表示（通知は鳴らない）
//   remind_push   … 通知をONにしている人のスマホにプッシュ通知（announcement-remind cron が送信）
//   remind_frequency … 'once'=期間中1回だけ / 'daily'=期間中は毎日
export type RemindFrequency = 'once' | 'daily';

export interface Announcement {
  id: string;
  title: string;
  body: string;
  active: boolean;
  created_at: string;
  created_by: string | null;
  starts_at: string | null;
  ends_at: string | null;
  notify_on_create_push: boolean;
  notify_on_create_email: boolean;
  remind_in_app: boolean;
  remind_push: boolean;
  remind_email: boolean;
  remind_days_before: number;
  remind_frequency: RemindFrequency;
  /** スマホの通知に件名そのものを出すか（false なら「社内お知らせが届いています」に伏せる） */
  push_show_title: boolean;
  /** 宛先（2026-11-05）：'all'＝全員（今までのお知らせ）／'list'＝宛先の表の人だけ（announcement_recipients） */
  audience?: 'all' | 'list';
  /** 押した宛先のボタン・個別に足した人（表示用の控え・判定は DB） */
  recipient_presets?: string[];
  recipient_extra_ids?: string[];
  /** 作成時の通知を送った時刻（全員あてのお知らせの、外すと届いていた人の数に使う） */
  notified_at?: string | null;
}

const SELECT_COLS =
  'id, title, body, active, created_at, created_by, starts_at, ends_at, notify_on_create_push, notify_on_create_email, remind_in_app, remind_push, remind_email, remind_days_before, remind_frequency, push_show_title, audience, recipient_presets, recipient_extra_ids, notified_at';

// 今まさに表示すべきお知らせ（active かつ 表示期間内・宛先に入っているもの）を新しい順で取得（ホームのバナー用）。
// 🚨 2026-11-05：DB の my_active_announcements で読む（宛先の判定 announcement_visible は DB の1か所。
//    管理画面の権限がある人は表を直接読むと宛先外のお知らせまで読めてしまうため）
export const fetchActiveAnnouncements = async (): Promise<Announcement[]> => {
  const { data, error } = await supabase.rpc('my_active_announcements');
  if (error || !data) return [];
  return data as Announcement[];
};

// 全お知らせを新しい順で取得（管理画面の履歴一覧用）
// 🚨 読めなかったときは null（空の配列にすると「まだお知らせはありません」と嘘をつく）
export const fetchAllAnnouncements = async (): Promise<Announcement[] | null> => {
  const { data, error } = await supabase
    .from('announcements')
    .select(SELECT_COLS)
    .order('created_at', { ascending: false });
  if (error || !data) return null;
  return data as Announcement[];
};

// 作成・編集フォームが渡す値（title/body 以外は任意設定）
export interface AnnouncementInput {
  title: string;
  body: string;
  starts_at: string | null;
  ends_at: string | null;
  notify_on_create_push: boolean;
  notify_on_create_email: boolean;
  remind_in_app: boolean;
  remind_push: boolean;
  remind_email: boolean;
  remind_days_before: number;
  remind_frequency: RemindFrequency;
  push_show_title: boolean;
}

// 作成した行（id含む）を返す。作成時通知（announcement-notify）で id を使うため。
// 🚨 2026-11-05：新しいお知らせは audience 'list'（宛先の表の人だけ）で作り、すぐ setAnnouncementRecipients で宛先を入れる。
//    宛先を入れる前は誰にも見えない（'all' で作ると、その一瞬だけ全員に見えるため）
export const createAnnouncement = async (input: AnnouncementInput, createdBy: string | null) => {
  return supabase.from('announcements').insert({ ...input, created_by: createdBy, audience: 'list' }).select('id').single();
};

export interface SetRecipientsResult { total: number; added_unnotified: number; removed: number; removed_notified: number }

/** 宛先を決める・直す（DB の announcement_set_recipients・在籍の人だけ残す・外した人のベルと送信待ちのスマホ通知を消す） */
export const setAnnouncementRecipients = async (id: string, userIds: string[], presets: string[], extraIds: string[]) => {
  return supabase.rpc('announcement_set_recipients', { p_id: id, p_user_ids: userIds, p_presets: presets, p_extra_ids: extraIds }) as unknown as Promise<{ data: SetRecipientsResult | null; error: { message: string } | null }>;
};

/** 宛先の今の人（外していない）と、作成時の通知を送ったか。読めなければ null */
export const fetchAnnouncementRecipients = async (id: string): Promise<{ user_id: string; notified_at: string | null }[] | null> => {
  const { data, error } = await supabase.from('announcement_recipients').select('user_id, notified_at').eq('announcement_id', id).is('removed_at', null);
  if (error || !data) return null;
  return data as { user_id: string; notified_at: string | null }[];
};

/** お知らせごとの宛先の人数（管理画面の一覧の札）。読めなければ空 */
export const fetchRecipientCounts = async (): Promise<Record<string, number>> => {
  const { data, error } = await supabase.from('announcement_recipients').select('announcement_id').is('removed_at', null).limit(5000);
  if (error || !data) return {};
  const out: Record<string, number> = {};
  for (const r of data as { announcement_id: string }[]) out[r.announcement_id] = (out[r.announcement_id] ?? 0) + 1;
  return out;
};

// 🚨 update / delete は権限で弾かれても error にならず「0件」で返る。.select('id') で件数を見る（lib/statusUpdate.ts）
export const updateAnnouncement = async (id: string, input: AnnouncementInput) => {
  return supabase
    .from('announcements')
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id');
};

export const setAnnouncementActive = async (id: string, active: boolean) => {
  return supabase.from('announcements').update({ active, updated_at: new Date().toISOString() }).eq('id', id).select('id');
};

export const deleteAnnouncement = async (id: string) => {
  return supabase.from('announcements').delete().eq('id', id).select('id');
};
