// 設定（app_settings）を読む部品（2026-10-28・ログの量の見直し A・計画 docs/計画-ログの量を減らす-読み込みの見直し.md）。
// 前は画面を開くたびに、12個の設定を1つずつ別々に読んでいた（1日 約1,700件の API のログ）。
// ・同じ瞬間（同じ処理の流れ）に頼まれた鍵は、1回の問い合わせ（.in）にまとめる。最初の1回は、よく使う鍵（HOT_KEYS）も一緒に読む
// ・読めた値は、この画面の中だけで10分使い回す（🚨 端末には持たない＝アプリを開き直せば最新。レビューで決めた）
// ・自分が app_settings を書いたら（lib/writeWatch の 'admin'）、使い回しを捨てて読み直す（自分の操作はすぐ）
// ・ログインした人が変わったら捨てる。ログインしていないときは使い回さない（anon は読めない・退職者は読める鍵が少ない）
// ・「読めなかった」（ok:false）と「行が無い」（ok:true, found:false）を分けて返す。失敗は使い回さない
// 🚨 管理画面の設定の画面（値を直して保存する画面）は、これを通さず直接読む（別の管理者の変更を古い値で上書きしないため）
import { supabase } from './supabaseClient';
import { writtenSince } from './writeWatch';
import { timeoutSignal } from './netFailure';

export type AppSettingResult = { ok: true; found: boolean; value: unknown } | { ok: false; error: string };

/** 画面を開いたときにほぼ必ず読む鍵。最初の問い合わせで一緒に読む（読めない鍵は行が返らないだけ） */
const HOT_KEYS = [
  'idle_logout', 'overtime_unify_cutoff', 'overtime_unify_cleanup', 'trip_apply_start', 'push_banner_config', 'furikae_report_on',
  'gcal_calendar_mode', 'board_recipient_exclude_user_ids', 'board_notice_send_roles', 'board_notice_cc_user_ids', 'dm_default_send_permissions',
];
const FRESH_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 10_000;

type Entry = { at: number; found: boolean; value: unknown };
const cache = new Map<string, Entry>();
let cacheUser: string | null = null;
let hotLoaded = false;

let queued = new Map<string, ((r: AppSettingResult) => void)[]>();
let flushScheduled = false;

// ログインした人が変わった・ログアウトしたら捨てる
supabase.auth.onAuthStateChange((_ev, session) => {
  const uid = session?.user?.id ?? null;
  if (uid !== cacheUser) { cache.clear(); hotLoaded = false; cacheUser = uid; }
});

function freshEntry(key: string): Entry | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.at >= FRESH_MS || writtenSince(['admin'], e.at)) { cache.delete(key); return null; }
  return e;
}

async function flush(): Promise<void> {
  flushScheduled = false;
  const batch = queued;
  queued = new Map();
  // 🚨 途中で投げても、待っている全員に必ず返す（返さないと連絡板などが「読み込み中」のまま止まる）
  try {
    await flushBatch(batch);
  } catch (e) {
    const r: AppSettingResult = { ok: false, error: e instanceof Error ? e.message : String(e) };
    batch.forEach(rs => rs.forEach(res => res(r)));
  }
}

async function flushBatch(batch: Map<string, ((r: AppSettingResult) => void)[]>): Promise<void> {
  const { data: sess } = await supabase.auth.getSession();
  const uid = sess.session?.user?.id ?? null;
  if (uid !== cacheUser) { cache.clear(); hotLoaded = false; cacheUser = uid; }
  const keys = new Set(batch.keys());
  const withHot = !!uid && !hotLoaded;
  if (withHot) HOT_KEYS.forEach(k => { if (!freshEntry(k)) keys.add(k); });
  const at = Date.now();
  const { data, error } = await supabase.from('app_settings').select('key, value').in('key', [...keys]).abortSignal(timeoutSignal(TIMEOUT_MS));
  if (error) {
    const r: AppSettingResult = { ok: false, error: error.message };
    batch.forEach(rs => rs.forEach(res => res(r)));
    return;
  }
  // 読んでいる間にログインした人が変わったら、使い回しには入れない（前の人の結果を次の人の分にしない）
  const sameUser = !!uid && uid === cacheUser;
  if (withHot && sameUser) hotLoaded = true;
  const rows = new Map((data ?? []).map((x: { key: string; value: unknown }) => [x.key, x.value]));
  for (const k of keys) {
    const found = rows.has(k);
    // ログインしていないときは使い回さない（読めないだけで「行が無い」と覚えると、ログインしたあとも既定値で動く）
    if (sameUser) cache.set(k, { at, found, value: found ? rows.get(k) : null });
  }
  batch.forEach((rs, k) => {
    const r: AppSettingResult = { ok: true, found: rows.has(k), value: rows.has(k) ? rows.get(k) : null };
    rs.forEach(res => res(r));
  });
}

/** 設定を1つ読む（同じ瞬間の頼みは1回にまとめる・10分使い回す） */
export function getAppSetting(key: string): Promise<AppSettingResult> {
  const e = freshEntry(key);
  if (e) return Promise.resolve({ ok: true, found: e.found, value: e.value });
  return new Promise(resolve => {
    const list = queued.get(key) ?? [];
    list.push(resolve);
    queued.set(key, list);
    if (!flushScheduled) { flushScheduled = true; setTimeout(() => { void flush(); }, 0); }
  });
}

/** 保存したあとなどに、この画面の使い回しを捨てる（自分が書いたときは writeWatch でも捨てる。念のため） */
export function forgetAppSetting(key?: string): void {
  if (key) cache.delete(key); else cache.clear();
}
