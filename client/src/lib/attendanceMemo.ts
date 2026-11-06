// 勤怠カレンダーの予定の「上長だけのメモ」（2026-11-05・migration 20261105184311）
// ・attendance_exceptions.notes … スタッフへの連絡（ご本人に表示されます）
// ・attendance_exception_memos.memo … 🔒 上長だけのメモ（スタッフには表示されません）。
//   読み書きできるのは勤怠カレンダーを入力できる方（attendance_input）と管理者だけ（DB の RLS）。ほかの方には0件で返る
// 🚨 ご本人は attendance_exceptions の自分の行を全部の列ごと読めるので、上長だけの文を notes に入れない
import { supabase } from './supabaseClient';

/** 欄の名前（ユーザー確定 案1）。画面の文はここ1か所 */
// 2026-11-06 ユーザー確定：見出しと「どこに出るか」の1行（ご本人の画面は「上長からの連絡：」のまま＝言葉がつながる）
export const NOTES_LABEL = 'ご本人への連絡';
export const NOTES_SUB = '本人の勤務変更の一覧に表示';
export const MEMO_LABEL = '🔒 上長のメモ';
export const MEMO_SUB = '上長が見る勤怠カレンダーにだけ表示';
export const MEMO_HINT = 'どちらも通知は届きません。迷ったら「上長のメモ」へ';
export const NOTES_WARN = '⚠️ この欄はご本人に表示されます。ほかの方の事情は「上長のメモ」へ';

/** よく使う理由（これまでの備考で多かったもの・人の名前が入らないもの）。押すと「最後に押した欄」に入る */
export const MEMO_TEMPLATES = [
  '私用', '私用で午前のみ', '私用で午後のみ', '体調不良', '短期',
  '就職活動のため', '学業のため', 'スタッフ増員のため',
] as const;
/** 上長だけのメモ向けの定型（押すと上長だけのメモに入る・◯◯は書き換えてもらう） */
export const MEMO_ONLY_TEMPLATE = '◯◯先生の休みの代わり';

/** ご本人あての欄に、ほかの方の事情らしい言葉が入っているか（止めない・黄色の1行を出すだけ） */
export const looksLikeOthers = (text: string): boolean =>
  /先生|さん|有休|有給|調整休|休み|不在|代わり|代理/.test(text);

/** 予定の id → 上長だけのメモ。読めない方（RLS）・失敗のときは空 */
export const fetchMemos = async (ids: string[]): Promise<{ map: Record<string, string>; error: boolean }> => {
  const map: Record<string, string> = {};
  if (ids.length === 0) return { map, error: false };
  let error = false;
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error: err } = await supabase.from('attendance_exception_memos')
      .select('exception_id, memo').in('exception_id', ids.slice(i, i + 200));
    if (err) { console.error('[attendance memo] 読み込み失敗:', err); error = true; continue; }
    for (const r of (data ?? []) as { exception_id: string; memo: string }[]) map[r.exception_id] = r.memo;
  }
  return { map, error };
};

/** 予定にメモを付ける（空なら何もしない）。🚨 error を返すので呼ぶ側で必ず見る */
export const saveMemos = async (exceptionIds: string[], memo: string): Promise<{ error: string | null }> => {
  const m = memo.trim();
  if (!m || exceptionIds.length === 0) return { error: null };
  const { data, error } = await supabase.from('attendance_exception_memos')
    .insert(exceptionIds.map(id => ({ exception_id: id, memo: m }))).select('exception_id');
  if (error) return { error: error.message };
  if ((data ?? []).length !== exceptionIds.length) return { error: '一部のメモを保存できませんでした' };
  return { error: null };
};

/** 最近ご自分が使った文（ご本人への連絡・上長だけのメモの両方・新しい順・重ならない・10件まで）。失敗は空 */
export const fetchRecentPhrases = async (userId: string): Promise<string[]> => {
  if (!userId) return [];
  const [a, b] = await Promise.all([
    supabase.from('attendance_exceptions').select('notes, created_at').eq('created_by', userId)
      .not('notes', 'is', null).order('created_at', { ascending: false }).limit(40),
    supabase.from('attendance_exception_memos').select('memo, created_at').eq('created_by', userId)
      .order('created_at', { ascending: false }).limit(40),
  ]);
  const rows: { t: string; at: string }[] = [
    ...((a.data ?? []) as { notes: string | null; created_at: string }[]).map(r => ({ t: (r.notes ?? '').trim(), at: r.created_at })),
    ...((b.data ?? []) as { memo: string; created_at: string }[]).map(r => ({ t: (r.memo ?? '').trim(), at: r.created_at })),
  ];
  rows.sort((x, y) => (x.at < y.at ? 1 : -1));
  const fixed = new Set<string>([...MEMO_TEMPLATES, MEMO_ONLY_TEMPLATE]);
  const out: string[] = [];
  for (const r of rows) {
    if (!r.t || fixed.has(r.t) || out.includes(r.t)) continue;
    out.push(r.t);
    if (out.length >= 10) break;
  }
  return out;
};
