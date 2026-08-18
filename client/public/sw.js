const CACHE_NAME = 'fivem-portal-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: '新しい通知', body: event.data.text() };
  }

  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'fivem-notification',
    data: { url: data.url || '/' },
    requireInteraction: false,
  };

  event.waitUntil(
    self.registration.showNotification(data.title || '連絡板', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          // 🚨 未制御のタブ（起動直後・iPhoneのPWAでよく起きる）だと navigate は失敗する。
          //    失敗を捨てて focus だけしていたため「押しても前の画面が出るだけ」になっていた。
          //    その場合は新しく開き直す（2026-08-18 修正）
          return client.navigate(url)
            .then(c => (c || client).focus())
            .catch(() => self.clients.openWindow(url));
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    })
  );
});
