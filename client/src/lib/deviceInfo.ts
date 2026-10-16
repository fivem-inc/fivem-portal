// 端末の見分け（ログインの記録・強制ログアウト用・2026-10-16 ユーザー確定）
//
// ・端末番号：この端末（ブラウザ）だけの番号。初めて開いたときに作って端末に残す（fivem_device_id）。
//   🚨 ログアウトで localStorage を丸ごと消す処理（hooks/useAuth の handleLogout）でも残す。消えると同じ端末が別の端末に見える
// ・パソコン／スマホ／タブレット と ブラウザの名前は、ブラウザの名乗り（userAgent）から推し量る。あくまで目安
// 🚨 このファイルは supabase を読まない（読むのは lib/loginHistory.ts）

export const DEVICE_ID_KEY = 'fivem_device_id';

export type DeviceKind = 'pc' | 'phone' | 'tablet';

export function readDeviceId(): string | null {
  try {
    const v = localStorage.getItem(DEVICE_ID_KEY);
    return v && v.length >= 8 ? v : null;
  } catch {
    return null;
  }
}

export function writeDeviceId(v: string): void {
  try { localStorage.setItem(DEVICE_ID_KEY, v); } catch { /* 保存できない端末では毎回別の番号になるだけ */ }
}

/** 端末番号（無ければ作る） */
export function getDeviceId(): string {
  const cur = readDeviceId();
  if (cur) return cur;
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '')
    : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  writeDeviceId(id);
  return id;
}

/** ブラウザの名乗りから、パソコン・スマホ・タブレットと名前を推し量る（ua を渡せば管理画面で古いログインにも使える） */
export function describeUserAgent(ua: string, touchPoints = 0): { kind: DeviceKind; label: string } {
  const isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
  const isIPhone = /iPhone|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isAndroidPhone = isAndroid && /Mobile/.test(ua);
  const kind: DeviceKind = isIPhone || isAndroidPhone ? 'phone' : isIPad || isAndroid ? 'tablet' : 'pc';
  const os = isIPhone ? 'iPhone' : isIPad ? 'iPad' : isAndroid ? 'Android'
    : /Windows NT/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Line\//i.test(ua) ? 'LINE'
    : /Edg(e|A|iOS)?\//.test(ua) ? 'Edge'
    : /SamsungBrowser/.test(ua) ? 'Samsung'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : '';
  const kindName = kind === 'pc' ? 'パソコン' : kind === 'phone' ? 'スマホ' : 'タブレット';
  const label = `${kindName}${os ? `（${os}）` : ''}${browser ? `・${browser}` : ''}`;
  return { kind, label };
}

/** この端末 */
export function currentDevice(): { kind: DeviceKind; label: string } {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const tp = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0;
  const d = describeUserAgent(ua, tp);
  let standalone = false;
  try { standalone = window.matchMedia('(display-mode: standalone)').matches; } catch { /* 何もしない */ }
  return { kind: d.kind, label: standalone ? `${d.label}（ホーム画面のアプリ）` : d.label };
}

/** 画面に出す短い番号（例「PC-3F2A9C」・6文字＝全社の端末が数百台でも重なりにくい） */
export function deviceShortCode(deviceId: string | null | undefined, kind: string | null | undefined): string {
  if (!deviceId) return '';
  const p = kind === 'phone' ? 'SP' : kind === 'tablet' ? 'TB' : 'PC';
  return `${p}-${deviceId.slice(0, 6).toUpperCase()}`;
}
