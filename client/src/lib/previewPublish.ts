// 役職プレビューで「パート」を見ているとき、まだ公開していない機能を「公開したらこう見える」で下見するスイッチ（2026-11-06）。
// ・いまは勤務変更の事前申請（shift_report_advance）だけ。管理者が役職プレビュー中のときだけ効く（useAuth）
// ・画面の中だけの下見。本当のパートの方の権限・DB は何も変わらない（管理者の操作はそのまま管理者として DB に届く）
// ・タブを閉じる・プレビューを終えると消える（sessionStorage）
import { useSyncExternalStore } from 'react';

const KEY = 'fivem_preview_publish_advance';
const EVENT = 'fivem-preview-publish-changed';

export const readPreviewAdvance = (): boolean => {
  try { return sessionStorage.getItem(KEY) === '1'; } catch { return false; }
};

export const setPreviewAdvance = (on: boolean): void => {
  try { if (on) sessionStorage.setItem(KEY, '1'); else sessionStorage.removeItem(KEY); } catch { /* 保存できなくても画面は動く */ }
  window.dispatchEvent(new Event(EVENT));
};

const subscribe = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
};

export const usePreviewAdvance = (): boolean => useSyncExternalStore(subscribe, readPreviewAdvance, () => false);

// ── 下見で「見る方」を選ぶ（2026-11-06 ユーザー確定 A）────────────────────
// 役職プレビュー「パート」で、実在のパートの方を1人選ぶと、勤務変更のページがその方の画面（その方の履歴・カード）になる。
// 🚨 見るだけ：選んでいる間は、DB・Edge Function への書き込みの要求を lib/writeWatch の watchedFetch がすべて止める（送信・既読・記録も）。
//    ボタンを隠すだけでは、管理者の権限で代わりに書き込めてしまうため
const PERSON_KEY = 'fivem_preview_person';
export type PreviewPerson = { id: string; name: string };

export const readPreviewPerson = (): PreviewPerson | null => {
  try {
    const raw = sessionStorage.getItem(PERSON_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PreviewPerson;
    return p && typeof p.id === 'string' ? p : null;
  } catch { return null; }
};

let personCacheRaw: string | null = null;
let personCache: PreviewPerson | null = null;
const readPersonSnapshot = (): PreviewPerson | null => {
  let raw: string | null = null;
  try { raw = sessionStorage.getItem(PERSON_KEY); } catch { raw = null; }
  if (raw !== personCacheRaw) { personCacheRaw = raw; personCache = readPreviewPerson(); }
  return personCache;
};

export const setPreviewPerson = (p: PreviewPerson | null): void => {
  try { if (p) sessionStorage.setItem(PERSON_KEY, JSON.stringify(p)); else sessionStorage.removeItem(PERSON_KEY); } catch { /* 保存できなくても画面は動く */ }
  window.dispatchEvent(new Event(EVENT));
};

export const usePreviewPerson = (): PreviewPerson | null => useSyncExternalStore(subscribe, readPersonSnapshot, () => null);

/** 下見の「見る方」を選んでいる間か（watchedFetch が書き込みを止めるのに使う） */
export const previewReadOnly = (): boolean => readPreviewPerson() !== null;
