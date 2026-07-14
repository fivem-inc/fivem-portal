import { supabase } from './supabaseClient';

// 社内お知らせ（管理者が全スタッフのホーム上部に出す連絡）。
// テーブルそのものが「いつ何を出したか」の履歴を兼ねる。
export interface Announcement {
  id: string;
  title: string;
  body: string;
  active: boolean;
  created_at: string;
  created_by: string | null;
}

// 表示中（active）のお知らせを新しい順で取得（ホームのバナー用）
export const fetchActiveAnnouncements = async (): Promise<Announcement[]> => {
  const { data, error } = await supabase
    .from('announcements')
    .select('id, title, body, active, created_at, created_by')
    .eq('active', true)
    .order('created_at', { ascending: false });
  if (error || !data) return [];
  return data as Announcement[];
};

// 全お知らせを新しい順で取得（管理画面の履歴一覧用）
export const fetchAllAnnouncements = async (): Promise<Announcement[]> => {
  const { data, error } = await supabase
    .from('announcements')
    .select('id, title, body, active, created_at, created_by')
    .order('created_at', { ascending: false });
  if (error || !data) return [];
  return data as Announcement[];
};

export const createAnnouncement = async (title: string, body: string, createdBy: string | null) => {
  return supabase.from('announcements').insert({ title, body, created_by: createdBy });
};

export const setAnnouncementActive = async (id: string, active: boolean) => {
  return supabase.from('announcements').update({ active, updated_at: new Date().toISOString() }).eq('id', id);
};

export const deleteAnnouncement = async (id: string) => {
  return supabase.from('announcements').delete().eq('id', id);
};
