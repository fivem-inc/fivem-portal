const CACHE_NAME = 'fivem-portal-v1';

// 通知のアイコンを端末に保存しておく（2026-10-20）。
// 🚨 前は通知が届くたびにサイトから読み込んでいた（配り方は「毎回サイトに確かめる」）。電波が弱いとき・省電力のとき・
//    グループの投稿が続いて前の通知を置き換えるときに読み込みが間に合わず、Android が代わりにサイト名の頭文字「F」を出していた。
//    保存した画像を data: の形にして渡すので、通知のたびに通信しない。保存が無ければ今までどおりサイトから読む
const ICON_CACHE = 'fivem-icons-v1';
const ICON_PATH = '/icon-192.png';
let iconDataUrl = null;

async function iconSrc() {
  if (iconDataUrl) return iconDataUrl;
  try {
    const cache = await caches.open(ICON_CACHE);
    const res = await cache.match(ICON_PATH);
    if (!res) {
      // 保存が無ければ、今回は今までどおり URL を渡し、裏で保存しておく（次の通知から効く）。
      // 🚨 ここで取りに行って待たない。電波が弱いと通知そのものが遅れる
      cache.add(ICON_PATH).catch(() => {});
      return ICON_PATH;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    iconDataUrl = 'data:image/png;base64,' + btoa(bin);
    return iconDataUrl;
  } catch {
    return ICON_PATH;
  }
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // 🚨 保存に失敗しても、入れ替え（通知の仕組みそのもの）は止めない
  event.waitUntil(caches.open(ICON_CACHE).then((c) => c.add(ICON_PATH)).catch(() => {}));
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

  event.waitUntil(
    iconSrc().then((icon) => self.registration.showNotification(data.title || '連絡板', {
      body: data.body || '',
      icon,
      badge: icon,
      tag: data.tag || 'fivem-notification',
      data: { url: data.url || '/' },
      requireInteraction: false,
    }))
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
