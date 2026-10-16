import { supabase } from '../lib/supabaseClient';
import { getDeviceId } from '../lib/deviceInfo';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string;

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function requestPushPermission(): Promise<'granted' | 'denied' | 'unsupported'> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'unsupported';
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    return (await saveSubscription(subscription)) ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

/**
 * ブラウザの通知の登録を DB に保存する（通知をオンにしたとき・強制ログアウトのあと入り直したときに作り直す）。
 * 🚨 失敗を黙って成功にしない（2026-10-16 レビュー：保存できていないのに「オン」と出ていた）
 */
export async function saveSubscription(subscription: PushSubscription): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { endpoint } = subscription;
  const { p256dh, auth } = subscription.toJSON().keys as { p256dh: string; auth: string };
  const { error } = await supabase.from('push_subscriptions').upsert(
    // device_id：どの端末の登録か（管理者が端末を強制ログアウトしたとき、その端末の通知も止めるため・2026-10-16）
    { user_id: user.id, endpoint, p256dh, auth, device_id: getDeviceId() },
    { onConflict: 'user_id,endpoint' }
  );
  if (error) { console.error('通知の登録を保存できませんでした:', error.message); return false; }
  return true;
}

export async function unsubscribePush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    await supabase
      .from('push_subscriptions')
      .delete()
      .eq('user_id', user.id)
      .eq('endpoint', subscription.endpoint);
  }

  await subscription.unsubscribe();
}

export async function getPushPermissionStatus(): Promise<NotificationPermission | 'unsupported'> {
  if (!('Notification' in window)) return 'unsupported';
  const perm = Notification.permission;
  // 「OFFにする」を押すと購読(push_subscription)は消えるが、ブラウザの通知許可は
  // granted のまま残る（許可の取り消しはユーザーがブラウザ設定でしか行えない）。
  // そのため permission だけで判定すると、OFFにしても更新でONに戻って見える。
  // 実際に購読しているかどうか（PushManager の購読の有無）で ON/OFF を判定する。
  if (perm === 'granted' && 'serviceWorker' in navigator && 'PushManager' in window) {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      return sub ? 'granted' : 'default'; // 購読が無ければ OFF(default) 扱い
    } catch {
      return 'granted'; // 判定できないときは従来通り granted
    }
  }
  return perm;
}
