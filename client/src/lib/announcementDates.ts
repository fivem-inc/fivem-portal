import type { Announcement } from './announcements';

// お知らせの日付まわりのユーティリティ。
// このアプリは日本国内運用なので、日付は常に JST（Asia/Tokyo, UTC+9）で解釈する。
// <input type="date"> は 'YYYY-MM-DD' を返し、new Date('YYYY-MM-DD') は UTC 0時
// （＝JST午前9時）と解釈されてしまうため、必ず +09:00 を明示して丸める。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// <input type="datetime-local"> の値 'YYYY-MM-DDTHH:mm'（時刻なしの旧 'YYYY-MM-DD' も許容）→ 表示開始 ISO。
// 時刻が無ければその日の JST 00:00:00 とみなす。空文字なら null。
export const dateInputToStartIso = (str: string): string | null => {
  if (!str) return null;
  const withTime = str.includes('T') ? `${str}:00` : `${str}T00:00:00`;
  const d = new Date(`${withTime}+09:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// datetime-local 値 → 表示終了 ISO。時刻が無ければその日の JST 23:59:59（終了日いっぱい表示）。空文字なら null。
export const dateInputToEndIso = (str: string): string | null => {
  if (!str) return null;
  const withTime = str.includes('T') ? `${str}:59` : `${str}T23:59:59`;
  const d = new Date(`${withTime}+09:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// ISO → <input type="datetime-local"> 用の 'YYYY-MM-DDTHH:mm'（JST基準）。null/不正なら空文字。
export const isoToDateInput = (iso: string | null): string => {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const j = new Date(t + JST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}T${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`;
};

// ISO → 'M/D HH:mm'（JST基準・履歴カードの期間表示用）。null なら空文字。
export const isoToShortDate = (iso: string | null): string => {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const j = new Date(t + JST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${j.getUTCMonth() + 1}/${j.getUTCDate()} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`;
};

// JST基準の「通し日番号」（1970-01-01 JST からの日数）。日付単位の比較に使う。
const jstDayNumber = (iso: string): number => {
  const j = new Date(new Date(iso).getTime() + JST_OFFSET_MS);
  return Math.floor(Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate()) / 86400000);
};

export type EffectiveStatus = 'stopped' | 'scheduled' | 'showing' | 'ended';

// active フラグと表示期間から、管理者に見せる「実効ステータス」を計算する。
// active=true でも期間外ならバナーには出ないため、生の active では足りない。
export const effectiveStatus = (a: Announcement, nowMs: number = Date.now()): EffectiveStatus => {
  if (!a.active) return 'stopped';
  if (a.starts_at && new Date(a.starts_at).getTime() > nowMs) return 'scheduled';
  if (a.ends_at && new Date(a.ends_at).getTime() < nowMs) return 'ended';
  return 'showing';
};

export const STATUS_LABEL: Record<EffectiveStatus, string> = {
  stopped: '停止中',
  scheduled: '表示予定',
  showing: '表示中',
  ended: '終了',
};

// アプリ内リマインド期間内か（＝終了日の remind_days_before 日前〜終了日、JST）。
// この期間は、一度✕で閉じた人にもバナーを再表示する。
export const isInRemindWindow = (a: Announcement, nowIso: string = new Date().toISOString()): boolean => {
  if (!a.remind_in_app || !a.ends_at) return false;
  const today = jstDayNumber(nowIso);
  const end = jstDayNumber(a.ends_at);
  return today >= end - a.remind_days_before && today <= end;
};
