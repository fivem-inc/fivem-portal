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

// 開いている画面に「このページへ移って」と頼む。画面が返事をしたら true（2026-10-20）。
// 🚨 前は client.navigate で画面をまるごと読み直していた。電波が弱いと読み直しに失敗し、使えていた画面まで消えていた。
//    画面の側（hooks/useOfflinePrep）が受け取ってアプリの中で移る＝通信なしで移れる。
//    返事が無い（古い版の画面・止まっている）ときは false → 今までどおり navigate で読み直す
function askClientToNavigate(client, url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => finish(e.data === 'ok');
      client.postMessage({ type: 'fivem-navigate', url }, [ch.port2]);
    } catch {
      finish(false);
    }
    setTimeout(() => finish(false), 1500);
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          // 🚨 先に前面に出す（前面に出すのは、押した直後しか許されないため）。そのあと画面の中で移ってもらう
          return Promise.resolve(client.focus()).catch(() => client)
            .then(() => askClientToNavigate(client, url))
            .then((moved) => {
              if (moved) return;
              // 🚨 未制御のタブ（起動直後・iPhoneのPWAでよく起きる）だと navigate は失敗する。
              //    失敗を捨てて focus だけしていたため「押しても前の画面が出るだけ」になっていた。
              //    その場合は新しく開き直す（2026-08-18 修正）
              return client.navigate(url)
                .then(c => (c || client).focus())
                .catch(() => self.clients.openWindow(url));
            });
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    })
  );
});
