import { supabase } from '../lib/supabaseClient';

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

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return 'denied';

    const { endpoint } = subscription;
    const { p256dh, auth } = subscription.toJSON().keys as { p256dh: string; auth: string };

    await supabase.from('push_subscriptions').upsert(
      { user_id: user.id, endpoint, p256dh, auth },
      { onConflict: 'user_id,endpoint' }
    );

    return 'granted';
  } catch {
    return 'denied';
  }
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
