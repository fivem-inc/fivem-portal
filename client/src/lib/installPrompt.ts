// 「ホーム画面にアプリを追加」の案内のための部品（2026-09-27・ユーザー確定）
//
// Android・PC の Chrome / Edge は、条件がそろうと beforeinstallprompt という合図を**ページを開いた直後に1回だけ**出す。
// それを受け取って取っておき、カードの［ホーム画面に追加］を押したときに prompt() で端末の「インストールしますか」を出す。
// 🚨 合図は1回しか来ないので、画面の部品ではなく main.tsx から最初に読み込む（部品が出る前に来ることがある）。
// iPhone（Safari）はこの合図が無いので、手順を文字で案内する（App.tsx の PushEnableBanner）。

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(fn => fn());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // 🚨 既定のミニ案内（ブラウザが勝手に出す帯）は止め、こちらのカードから出す
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => { deferred = null; notify(); });
}

/** Android・PC で「ホーム画面に追加」を今すぐ出せるか */
export function canPromptInstall(): boolean { return deferred !== null; }

export function subscribeInstall(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 端末の「インストールしますか」を出す。合図は1回きりなので、出したら捨てる */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const ev = deferred;
  if (!ev) return 'unavailable';
  deferred = null;
  notify();
  await ev.prompt();
  const choice = await ev.userChoice;
  return choice.outcome;
}

/** アイコンから開いている（アプリとして追加済み）か */
export function isStandaloneApp(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

/**
 * iPhone でどこから開いているか。
 *   'safari' … 共有ボタンから追加できる
 *   'other'  … LINE・Facebook・Instagram などのアプリの中、または Safari 以外のブラウザ（Safari で開き直してもらう）
 *   null     … iPhone ではない
 */
export function iosBrowserKind(ua: string = navigator.userAgent): 'safari' | 'other' | null {
  if (!/iP(hone|ad|od)/.test(ua)) return null;
  if (/Line\/|FBAN|FBAV|Instagram|CriOS|FxiOS|EdgiOS|GSA\//.test(ua)) return 'other';
  return /Safari\//.test(ua) ? 'safari' : 'other';
}
