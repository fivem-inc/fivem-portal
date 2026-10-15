// 文字の大きさ（2026-10-15 ユーザー確定 A：標準／大きめ 1.15倍／特大 1.3倍・本人が右上のメニューで選ぶ・その端末だけ）
//
// 【しくみ】
//   スマホの画面の倍率（<meta name="viewport">）を変えて、アプリ全体を拡大する。
//   例：幅 360 のスマホで 1.3倍 → 「幅 277 の画面」として作り、1.3倍に広げて画面いっぱいに見せる。
//   文字・ボタン・余白が一緒に大きくなり、横にはみ出さない。
//
// 🚨 CSS の zoom は使わない。zoom にすると「画面の高さの◯割（90vh など・48か所）」が倍率ぶん大きくなって
//    窓が画面からはみ出し、getBoundingClientRect で位置を決める窓（ベル・右上のメニュー）もずれる。
//    viewport の倍率ならブラウザが画面ごと拡大するので、どちらも起きない。
// 🚨 パソコンのブラウザは viewport を見ないので効かない。パソコンでは選択肢を出さない（Ctrl ＋ ＋ を案内）。
// 🚨 端末に覚える（localStorage）。fivem_draft_* ではないのでログアウトでも消えない（ユーザー確定：ログインし直しても残る）。

export const TEXT_SCALES = [
  { value: 1, label: '標準' },
  { value: 1.15, label: '大きめ' },
  { value: 1.3, label: '特大' },
] as const;

const KEY = 'fivem_text_scale';
const DEFAULT_VIEWPORT = 'width=device-width, initial-scale=1.0, user-scalable=no';

export function getTextScale(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return TEXT_SCALES.some(s => s.value === n) ? n : 1;
  } catch {
    return 1;
  }
}

/** viewport の倍率が効く端末か（スマホ・タブレット）。パソコンでは false */
export function textScaleSupported(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

// 端末の画面の幅（向きに合わせる）。screen.width は iPhone では向きで変わらないので、向きを見て選ぶ
function deviceWidth(): number {
  const sw = window.screen.width;
  const sh = window.screen.height;
  let landscape = false;
  try { landscape = window.matchMedia('(orientation: landscape)').matches; } catch { /* 縦とみなす */ }
  return landscape ? Math.max(sw, sh) : Math.min(sw, sh);
}

export function applyTextScale(): void {
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  const s = textScaleSupported() ? getTextScale() : 1;
  // 🚨 印は index.css が見る（大きくしているときだけ body の「最低 320」を外す）
  if (s === 1) {
    delete document.documentElement.dataset.textScale;
    meta.setAttribute('content', DEFAULT_VIEWPORT);
    return;
  }
  document.documentElement.dataset.textScale = String(s);
  const w = Math.round(deviceWidth() / s);
  meta.setAttribute('content', `width=${w}, initial-scale=${s}, minimum-scale=${s}, maximum-scale=${s}, user-scalable=no`);
}

export function setTextScale(v: number): void {
  try {
    if (v === 1) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(v));
  } catch { /* 覚えられなくても、いまの画面には効かせる */ }
  applyTextScale();
}

/** 起動時に1回（画面を描く前）。向きが変わったら幅を計算し直す */
export function initTextScale(): void {
  applyTextScale();
  window.addEventListener('orientationchange', () => { setTimeout(applyTextScale, 300); });
}
