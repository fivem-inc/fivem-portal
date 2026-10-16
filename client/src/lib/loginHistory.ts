// ログインの記録（2026-10-16 ユーザー確定）。決めたことは supabase/migrations/20261016181404_login_history.sql の冒頭
//
// ・画面が開いたとき（ログイン中）に1回、この端末の情報を record_session_device に送る。
//   同じログインなら上書き。初めて見たログインのときだけ DB が「ログイン」を1行残す（時刻は本当にログインした時刻）
// ・自分でログアウトする直前に recordLogout（hooks/useAuth の handleLogout から）
// 🚨 どちらも失敗してもログイン・ログアウトそのものは止めない（記録は補助）。待つのは最大1.5秒
// 🚨 onAuthStateChange の中で supabase を await すると固まることがある（supabase-js の既知の動き）ので、setTimeout で外に出す

import { supabase } from './supabaseClient';
import { currentDevice, getDeviceId } from './deviceInfo';
import { readIdleLogoutSetting } from './idleLogout';
import { saveSubscription } from '../utils/pushNotification';

const sentSessions = new Set<string>();

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p, new Promise<null>(res => setTimeout(() => res(null), ms))]);

/** JWT の中のログインの番号（session_id）。読めなければ null */
function sessionIdOf(accessToken: string | undefined): string | null {
  if (!accessToken) return null;
  try {
    const part = accessToken.split('.')[1];
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.session_id === 'string' ? json.session_id : null;
  } catch {
    return null;
  }
}

/** この端末の通知の登録（あれば）。サービスワーカーが無い・応答しないときは null */
async function currentPushSubscription(): Promise<PushSubscription | null> {
  try {
    if (!('serviceWorker' in navigator)) return null;
    const reg = await withTimeout(navigator.serviceWorker.getRegistration(), 1500);
    if (!reg || !('pushManager' in reg)) return null;
    return (await withTimeout(reg.pushManager.getSubscription(), 1500)) ?? null;
  } catch {
    return null;
  }
}

async function sendDevice(accessToken: string | undefined): Promise<void> {
  const sid = sessionIdOf(accessToken);
  if (!sid || sentSessions.has(sid)) return;
  sentSessions.add(sid);
  const dev = currentDevice();
  const sub = await currentPushSubscription();
  const { data, error } = await supabase.rpc('record_session_device', {
    p_device_id: getDeviceId(),
    p_device_kind: dev.kind,
    p_device_label: dev.label,
    p_shared: readIdleLogoutSetting() === 'on',
    p_endpoint: sub?.endpoint ?? null,
  });
  if (error) {
    console.error('ログインの記録に失敗:', error.message);
    sentSessions.delete(sid); // 次に開いたときにもう一度
    return;
  }
  // ブラウザには通知の登録があるのに DB に無い（強制ログアウトで消えた など）→ 作り直す。
  // 🚨 しないと画面は「通知オン」のまま1通も届かない（2026-10-16 レビュー）。許可は付いたままなので本人には聞かない
  if (sub && (data as { push_missing?: boolean } | null)?.push_missing) {
    await saveSubscription(sub);
  }
}

/** 起動時に1回呼ぶ（main.tsx） */
export function installLoginHistory(): void {
  supabase.auth.onAuthStateChange((event, session) => {
    if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session) {
      const token = session.access_token;
      setTimeout(() => { void sendDevice(token); }, 0);
    }
  });
}

/** 自分でログアウトする直前に呼ぶ。失敗してもログアウトは続ける */
export async function recordLogout(reason: 'logout' | 'idle_logout'): Promise<void> {
  try {
    const res = await withTimeout(Promise.resolve(supabase.rpc('record_logout', { p_reason: reason })), 1500);
    if (res && res.error) console.error('ログアウトの記録に失敗:', res.error.message);
  } catch (e) {
    console.error('ログアウトの記録に失敗:', e);
  }
}
