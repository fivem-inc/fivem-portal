// 勤務変更報告の休憩・実労働の計算。ShiftReportPage（申請）と管理者修正モーダルで共通に使い、
// 計算エンジンの二重化（申請と修正でズレる事故）を防ぐ。
// ※残業(overtime)の breakCalc とは休憩ルールが異なるため別物。

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// 拘束時間帯（出勤〜退勤）から自動休憩を算出する。ShiftReportPage の従来ルールと同一。
export function calcShiftBreakMinutes(start: string, end: string): number {
  const s = toMin(start), d = toMin(end) - s;
  if (d <= 0)               return 0;
  if (d < 255)              return 0;
  if (s >= 780 && d <= 345) return 0;
  if (s >= 780 && d <= 375) return 15;
  if (d <= 390)             return 30;
  if (d <= 525)             return 45;
  return 60;
}

// ───────── 勤務した時間帯（最大3つ・残業ページと同じ考え方） ─────────
// 「9:00〜12:00 と 14:00〜18:00 に働いた」を素直に表す。間の空きが外出・中抜けになる。
// DBには jsonb（original_segments / actual_segments）で持ち、
// 最初の開始と最後の終了は従来の original_start/end 列にも入れて互換を保つ。
// location は時間帯ごとの勤務校。校をまたぐ日（午前は四条本校・午後は西陣校 など）に使う。
// 勤怠カレンダーの休日出勤（attendance_exceptions.work_segments）と同じ持ち方に揃えている
export type Seg = { start: string; end: string; location?: string };
export const MAX_SEGS = 3;

/**
 * DBの値から勤務時間帯の配列を作る。
 * 古い報告（segments が無い）は「開始〜終了」から外出を抜いて時間帯に分ける。
 * 例）9:00〜18:00・外出 14:00〜15:00 → [9:00〜14:00, 15:00〜18:00]
 * こうすることで、古い報告も新しい報告も同じ書き方で表示できる。
 */
export function parseSegments(
  segments: unknown,
  legacyStart?: string | null,
  legacyEnd?: string | null,
  legacyOutStart?: string | null,
  legacyOutEnd?: string | null,
  legacyLocation?: string | null,
): Seg[] {
  if (Array.isArray(segments)) {
    return (segments as Seg[])
      .filter(s => s && typeof s.start === 'string' && typeof s.end === 'string')
      .map(s => ({ start: s.start.slice(0, 5), end: s.end.slice(0, 5), location: s.location || undefined }))
      .filter(s => s.start && s.end)
      .slice(0, MAX_SEGS);
  }
  if (!legacyStart || !legacyEnd) return [];
  // 古い報告は勤務地を1つしか持たないので、復元した時間帯すべてに同じ校を入れる
  const loc = legacyLocation || undefined;
  const s = legacyStart.slice(0, 5), e = legacyEnd.slice(0, 5);
  if (legacyOutStart && legacyOutEnd) {
    const os = legacyOutStart.slice(0, 5), oe = legacyOutEnd.slice(0, 5);
    if (toMin(oe) > toMin(os)) {
      // ① 勤務時間の中にある＝ふつうの中抜け。前後2つの時間帯に分ける
      if (toMin(os) > toMin(s) && toMin(oe) < toMin(e)) {
        return [{ start: s, end: os, location: loc }, { start: oe, end: e, location: loc }];
      }
      // ② 勤務時間より後ろ／前にある＝「外出」欄を2つ目の勤務時間として使っていた報告。
      // 🚨 そのまま捨てると画面から時間が消えるため、2つ目の時間帯として残す。
      // 実際に本番に3件あった（例：勤務 10:55〜11:35／外出欄 15:30〜19:00）。
      // 旧計算ではこれを「働いていない時間」として引くため実労働が0分になっていた。
      // 表示は正しく直るが、保存済みの休憩・実労働の数字は当時のままなので注意
      if (toMin(os) >= toMin(e)) return [{ start: s, end: e, location: loc }, { start: os, end: oe, location: loc }];
      if (toMin(oe) <= toMin(s)) return [{ start: os, end: oe, location: loc }, { start: s, end: e, location: loc }];
    }
  }
  return [{ start: s, end: e, location: loc }];
}

/** 勤務時間帯の合計（分）。休憩は含まない */
export function segMinutes(segs: Seg[]): number {
  return segs.reduce((sum, s) => sum + (s.start && s.end ? Math.max(0, toMin(s.end) - toMin(s.start)) : 0), 0);
}

/**
 * 休憩の合計。
 * 🚨 時間帯ごとにルールを当てて合算する（残業ページ breakCalc の calcTotalBreak と同じ考え方）。
 * 最初〜最後の拘束時間で判定すると、中抜けの長い日に休憩を引きすぎる。
 * （中抜けの間に昼食＝休憩を取っているのに、さらに休憩を引くことになるため）
 * 例）9:00〜12:00 と 17:00〜19:00 → 3時間分0分 ＋ 2時間分0分 ＝ 0分
 *     中抜けなしの 9:00〜18:00 は従来どおり60分で、結果は変わらない
 */
export function calcSegsBreak(segs: Seg[]): number {
  return segs.reduce((sum, s) => sum + (s.start && s.end ? calcShiftBreakMinutes(s.start, s.end) : 0), 0);
}

/** 最初の開始（従来の start 列に入れる値） */
export const segFirstStart = (segs: Seg[]): string => segs[0]?.start ?? '';
/** 最後の終了（従来の end 列に入れる値） */
export const segLastEnd = (segs: Seg[]): string => segs[segs.length - 1]?.end ?? '';

/** 校を重複なくつないだ表示用の文字列。例）'四条本校→西陣校'（従来の勤務地の列に入れる値） */
export const joinSegLocations = (segs: Seg[]): string =>
  [...new Set(segs.map(s => s.location).filter((v): v is string => !!v))].join('→');

/**
 * 勤務時間帯を並べた文字列を作る。
 * 例）"9:00〜12:00［四条本校］/ 14:00〜18:00［西陣校］"
 * 時刻は 9:00 の形（時は0埋めしない・分は2桁）。Googleカレンダーの書き方と揃えている。
 * 校が1つしかないときは［］を出さない（勤務地は別欄に出ているため）。
 */
export function formatSegs(segs: Seg[]): string {
  const fmt = (v: string) => { const [h, m] = v.slice(0, 5).split(':'); return `${Number(h)}:${m}`; };
  const rows = segs.filter(s => s.start && s.end);
  const multiLoc = new Set(rows.map(s => s.location).filter(Boolean)).size > 1;
  return rows.map(s => `${fmt(s.start)}〜${fmt(s.end)}${multiLoc && s.location ? `［${s.location}］` : ''}`).join(' / ');
}

/** DBの値から直接「9:00〜12:00 / 14:00〜18:00」を作る（表示用のまとめ） */
export function formatSegsFromRecord(
  segments: unknown,
  legacyStart?: string | null,
  legacyEnd?: string | null,
  legacyOutStart?: string | null,
  legacyOutEnd?: string | null,
  legacyLocation?: string | null,
): string {
  return formatSegs(parseSegments(segments, legacyStart, legacyEnd, legacyOutStart, legacyOutEnd, legacyLocation));
}
