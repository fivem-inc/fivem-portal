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

// ───────── 圏外でも開ける（2026-10-21 電波 段5・docs/計画-電波が弱いとき.md の 6.・2体でレビュー） ─────────
// 🚨 止める版（キルスイッチ）：OFFLINE_SHELL を false にして push すると、次に開いたときから
//    ①fetch の処理そのものを登録しない（すべて今までどおり素通し）②画面の保存（shell・assets）を消す。
//    通知・アイコンの保存（fivem-icons-v1）は触らない。sw.js は毎回サイトに確かめる配り方なので、すぐ切り替わる
const OFFLINE_SHELL = true;
const SHELL_CACHE = 'fivem-shell-v1';   // index.html の写しと、版ごとの部品の一覧（今・1つ前）
const ASSET_CACHE = 'fivem-assets-v1';  // /assets/ の部品（名前に版の印がある・中身は変わらない）
const SHELL_KEY = '/index.html';
const NAV_TIMEOUT_MS = 6000;            // これより遅ければ写しで開く（通信は続け、届いたら写しを新しくする）
const PRECACHE_TIMEOUT_MS = 15000;      // 入れ替えの準備はこれ以上待たない（準備で止まると止める版も配れなくなる）

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/** 保存してよいトップページの応答か。🚨 転送・別のサイト・HTML でないものは保存しない */
function isGoodHtml(res) {
  return !!res && res.ok && res.status === 200 && res.type === 'basic' && !res.redirected
    && (res.headers.get('content-type') || '').includes('text/html');
}
/**
 * 保存してよい部品の応答か。
 * 🚨 無いファイルを読むと Vercel は index.html を「成功（200）」で返す（しかも1年保存してよいの印つき）。
 *    これを JS として保存すると、通信があっても毎回画面が壊れる。種類（Content-Type）を必ず確かめる
 */
function isGoodAsset(res, pathname) {
  if (!res || !res.ok || res.status !== 200 || res.type !== 'basic' || res.redirected) return false;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html')) return false;
  if (pathname.endsWith('.js') || pathname.endsWith('.mjs')) return ct.includes('javascript');
  if (pathname.endsWith('.css')) return ct.includes('css');
  return true;
}

async function putShell(res) {
  try { const c = await caches.open(SHELL_CACHE); await c.put(SHELL_KEY, res); } catch { /* 容量などで保存できなくても開くのは止めない */ }
}

/** 版ごとの部品の一覧（sw-assets.json）を読み、今の版と1つ前の版に無い部品を消す。版が同じなら何もしない */
async function refreshAssetList() {
  const res = await fetch('/sw-assets.json', { cache: 'no-store' });
  if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return;
  const next = await res.json();
  if (!next || typeof next.buildId !== 'string' || !Array.isArray(next.assets)) return;
  const meta = await caches.open(SHELL_CACHE);
  const curRes = await meta.match('/__sw-assets-cur');
  const cur = curRes ? await curRes.json().catch(() => null) : null;
  if (cur && cur.buildId === next.buildId) return;
  await meta.put('/__sw-assets-prev', new Response(JSON.stringify(cur || { buildId: '', assets: [] })));
  await meta.put('/__sw-assets-cur', new Response(JSON.stringify(next)));
  const keep = new Set([...next.assets, ...((cur && Array.isArray(cur.assets)) ? cur.assets : [])]);
  const cache = await caches.open(ASSET_CACHE);
  for (const k of await cache.keys()) {
    try { if (!keep.has(new URL(k.url).pathname)) await cache.delete(k); } catch { /* 1件消せなくても続ける */ }
  }
}

/** 入れ替えの準備：トップページの写しと、そこで読む部品を保存しておく（端末にあればほぼ通信しない） */
async function precacheShell() {
  const res = await fetch(SHELL_KEY, { cache: 'no-cache' });
  if (!isGoodHtml(res)) return;
  const html = await res.clone().text();
  await putShell(res);
  const paths = [...new Set((html.match(/\/assets\/[A-Za-z0-9._-]+/g) || []))];
  const cache = await caches.open(ASSET_CACHE);
  for (const p of paths) {
    try {
      if (await cache.match(p)) continue;
      const r = await fetch(p);
      if (isGoodAsset(r, p)) await cache.put(p, r);
    } catch { /* 1件取れなくても続ける */ }
  }
  await refreshAssetList().catch(() => {});
}

/** ページを開く：まず通信。圏外・時間切れのときだけ写しで開く */
async function handleNavigate(event) {
  const req = event.request;
  const net = fetch(req).then((res) => {
    if (isGoodHtml(res)) {
      const copy = res.clone();
      return putShell(copy).then(() => refreshAssetList().catch(() => {})).then(() => res);
    }
    return res;
  });
  // 写しで開いたあとも通信は続け、届いたら写しを新しくする（次に開いたときは最新）
  event.waitUntil(net.then(() => {}, () => {}));
  const first = await Promise.race([
    net.then((r) => ({ r }), (e) => ({ e })),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), NAV_TIMEOUT_MS)),
  ]);
  if (first !== 'timeout' && first.r) return first.r;
  let cached = null;
  try { cached = await (await caches.open(SHELL_CACHE)).match(SHELL_KEY); } catch { cached = null; }
  if (cached) return cached;
  return net; // 写しが無ければ今までどおり（通信を待つ・失敗ならブラウザのエラー）
}

/** 部品：保存があれば保存から。無ければ通信し、本物の部品だけ保存 */
async function handleAsset(req, pathname) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(pathname);
  if (hit) return hit;
  const res = await fetch(req);
  if (isGoodAsset(res, pathname)) cache.put(pathname, res.clone()).catch(() => {});
  return res;
}

if (OFFLINE_SHELL) {
  self.addEventListener('fetch', (event) => {
    const req = event.request;
    // 横取りするのは「同じサイトの GET のページを開く（パスに . が無い）」と「/assets/ の部品」だけ。
    // Supabase（別のサイト）・version.json・sw.js・sw-assets.json・manifest・faq-widget.html・POST・Range は今までどおり
    if (req.method !== 'GET' || req.headers.has('range')) return;
    let url;
    try { url = new URL(req.url); } catch { return; }
    if (url.origin !== self.location.origin) return;
    if (req.mode === 'navigate') {
      if (url.pathname.includes('.')) return;
      event.respondWith(handleNavigate(event).catch(() => fetch(req)));
      return;
    }
    if (url.pathname.startsWith('/assets/')) {
      event.respondWith(handleAsset(req, url.pathname).catch(() => fetch(req)));
    }
  });
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // 🚨 保存に失敗しても、入れ替え（通知の仕組みそのもの）は止めない。準備は時間の上限つきで、失敗しても必ず先へ進む
  event.waitUntil(Promise.all([
    caches.open(ICON_CACHE).then((c) => c.add(ICON_PATH)).catch(() => {}),
    OFFLINE_SHELL ? withTimeout(precacheShell(), PRECACHE_TIMEOUT_MS).catch(() => {}) : Promise.resolve(),
  ]));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    // 止める版：画面の保存だけ消す（アイコンの保存は残す）
    OFFLINE_SHELL ? Promise.resolve() : Promise.all([caches.delete(SHELL_CACHE), caches.delete(ASSET_CACHE)]).catch(() => {}),
  ]));
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
