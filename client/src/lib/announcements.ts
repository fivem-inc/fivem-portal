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
}

const SELECT_COLS =
  'id, title, body, active, created_at, created_by, starts_at, ends_at, notify_on_create_push, notify_on_create_email, remind_in_app, remind_push, remind_email, remind_days_before, remind_frequency';

// 今まさに表示すべきお知らせ（active かつ 表示期間内）を新しい順で取得（ホームのバナー用）。
// 期間フィルタは NULL を通す（starts_at/ends_at が未設定の既存お知らせも表示継続）。
export const fetchActiveAnnouncements = async (): Promise<Announcement[]> => {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('announcements')
    .select(SELECT_COLS)
    .eq('active', true)
    .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
    .or(`ends_at.is.null,ends_at.gte.${nowIso}`)
    .order('created_at', { ascending: false });
  if (error || !data) return [];
  return data as Announcement[];
};

// 全お知らせを新しい順で取得（管理画面の履歴一覧用）
export const fetchAllAnnouncements = async (): Promise<Announcement[]> => {
  const { data, error } = await supabase
    .from('announcements')
    .select(SELECT_COLS)
    .order('created_at', { ascending: false });
  if (error || !data) return [];
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
}

// 作成した行（id含む）を返す。作成時通知（announcement-notify）で id を使うため。
export const createAnnouncement = async (input: AnnouncementInput, createdBy: string | null) => {
  return supabase.from('announcements').insert({ ...input, created_by: createdBy }).select('id').single();
};

export const updateAnnouncement = async (id: string, input: AnnouncementInput) => {
  return supabase
    .from('announcements')
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', id);
};

export const setAnnouncementActive = async (id: string, active: boolean) => {
  return supabase.from('announcements').update({ active, updated_at: new Date().toISOString() }).eq('id', id);
};

export const deleteAnnouncement = async (id: string) => {
  return supabase.from('announcements').delete().eq('id', id);
};
