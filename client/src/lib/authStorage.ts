// 端末に保存されているログイン（Supabase の合言葉）を読むだけの小さな道具（2026-10-20・電波 段1）。
//
// 🚨 なぜ要るか：電波が弱い所でアプリを開くと、合言葉（約1時間で切れる）の取り直しが通らず、
//    getSession が「合言葉なし」を返す（失敗・時間切れ）。前はそれを「ログインしていない」と扱い、
//    ログイン画面を出していた（本人は「ログアウトされた」と思う・電波が戻っても戻らない）。
//    端末にはまだ合言葉が残っているので、それを見て「通信のせいで確かめられなかっただけ」と見分ける。
// 🚨 本当にログインが無効になったとき（取り消し・退職の停止）は、Supabase の部品が端末の合言葉を消して
//    SIGNED_OUT を出す。そのときは readStoredAuthUser が null を返すので、今までどおりログイン画面になる。
// 🚨 ここで読むのは「誰か」だけ。データの読み書きは今までどおり合言葉が通らなければ DB 側（RLS）で断られる。
import type { AuthUser } from '../types';

function storageKey(): string | null {
  try {
    const url = import.meta.env.VITE_SUPABASE_URL as string;
    // supabase-js の既定（sb-<ホスト名の先頭>-auth-token）と同じ。lib/supabaseClient で storageKey を変えたらここも直す
    return `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
  } catch {
    return null;
  }
}

/** 端末に保存されているログインの「人」。無ければ null */
export function readStoredAuthUser(): AuthUser | null {
  const key = storageKey();
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as { refresh_token?: string; user?: AuthUser } | null;
    // 取り直しに使う refresh_token が無いものは、ログインとして扱わない
    if (!v || typeof v.refresh_token !== 'string' || !v.refresh_token || !v.user || typeof v.user.id !== 'string') return null;
    return v.user;
  } catch {
    return null;
  }
}
