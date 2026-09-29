// 残業の1件フォーム（OvertimePage.tsx）の画面の中にあった計算を、表入力・まとめて申請と共用するために移したもの（2026-09-29）。
// 計画：docs/計画-残業のまとめて申請.md の「作る順番」1
//
// 🚨 ここは画面の状態を持たない・supabase を読まない（node で検算できるようにしておくため）。
// 🚨 移したときに**動きは1つも変えていない**。1件フォームはここを呼ぶだけ。直すときはここだけを直す。

import { calcTotalBreak, calcLaborMinutes, timeToMin } from './breakCalc';
import type { WorkSegment } from './breakCalc';
import type { NormalShiftSnapshot } from './overtimeShift';
import { embeddedRole } from './roleAttrs';
import type { EmbeddedRoleRow } from './roleAttrs';

// ────────────────────────────────────────────
// 勤務地
// ────────────────────────────────────────────

/** 「その他」を選んだときは自由入力欄の値を使う（勤務地・振替元の校で共通） */
export function effectiveOtherLocation(selected: string, custom: string): string {
  return selected === 'その他' ? custom.trim() : selected;
}

/**
 * 保存されている勤務地（DB の location・下書き）から、勤務地の選択の値を決める。
 * 「A→B」は「移動あり」／登録済みの校はその校／それ以外（自由入力）は「その他」／空は空
 */
export function storedLocationChoice(stored: string, workplaces: string[]): string {
  if (stored.includes('→')) return '移動あり';
  if (stored) return workplaces.includes(stored) ? stored : 'その他';
  return '';
}

/** 保存されている勤務地が登録済みの校でない自由入力なら、その文字（「その他」の欄に入れる）。それ以外は空 */
export function storedLocationCustom(stored: string, workplaces: string[]): string {
  return stored && !stored.includes('→') && !workplaces.includes(stored) ? stored : '';
}

/** 「A→B」の移動元と移動先。移動でなければ両方空 */
export function splitMoveLocation(stored: string): { start: string; end: string } {
  if (!stored.includes('→')) return { start: '', end: '' };
  const [start, end] = stored.split('→');
  return { start, end: end ?? '' };
}

/**
 * 申請の依頼（シフト調整）の「入る時間と校」から入れる勤務地。
 * 校が時間帯で変わるとき（午前は本校・午後は西陣校）は「最初の校→移る先の校」（勤務地は「A→B」の1組しか持てない。3か所以上は最初の2校）
 * 🚨 1件フォームの「依頼から申請」と表入力で同じもの（2026-09-29）
 */
export function requestSegmentsLocation(segs: { location?: string | null }[]): string {
  const locs = segs.map(s => (s.location ?? '').trim()).filter(Boolean);
  const first = locs[0] ?? '';
  const moveTo = locs.find(l => l !== first) ?? '';
  return moveTo ? `${first}→${moveTo}` : first;
}

// ────────────────────────────────────────────
// 打刻ズレ（残業ではありません・打刻が遅れただけ）
// ────────────────────────────────────────────

/** 打刻が遅くなった理由の実効値（「その他」は自由入力欄の値）。1件フォームと表入力で同じもの（2026-09-29） */
export function effectiveClockReasonOf(reason: string, other: string): string {
  return reason === 'その他' ? other.trim() : reason;
}

// ────────────────────────────────────────────
// 振替休日の振替元
// ────────────────────────────────────────────

/** 振替元の勤務時間（自動休憩・労働）。🚨 休憩は自動（手修正は無い）。時刻が片方でも空なら時間なし */
export function furikaeOriginCalc(start: string, end: string): {
  segs: WorkSegment[]; breakMin: number; laborMin: number; hasTime: boolean;
} {
  const st = timeToMin(start);
  let en = timeToMin(end);
  if (st == null || en == null) return { segs: [], breakMin: calcTotalBreak([]), laborMin: 0, hasTime: false };
  if (en <= st) en += 1440;
  const segs = [{ startMin: st, endMin: en }];
  const breakMin = calcTotalBreak(segs);
  return { segs, breakMin, laborMin: calcLaborMinutes(segs, breakMin), hasTime: true };
}

/**
 * 振替元の日を選んだときに入れる初期値（その日のシフトの校・時刻）。
 * 🚨 シフトが休みの日（時刻が無い）は時刻を入れない（null＝そのまま本人が入れる）
 */
export function furikaeOriginPrefill(ns: NormalShiftSnapshot, workplaces: string[]): {
  location: string; locationCustom: string; start: string | null; end: string | null;
} {
  const loc = ns.location ?? '';
  const other = !!loc && !workplaces.includes(loc);
  const hasTime = !!(ns.start_time && ns.end_time);
  return {
    location: other ? 'その他' : loc,
    locationCustom: other ? loc : '',
    start: hasTime ? (ns.start_time as string).slice(0, 5) : null,
    end: hasTime ? (ns.end_time as string).slice(0, 5) : null,
  };
}

// ────────────────────────────────────────────
// 申請先・通知
// ────────────────────────────────────────────

/** 申請先の候補がマネージャー（立場）か。欠勤の申請先はマネージャー以上に限る（申請先の選択肢の絞り込みと同じ見方） */
export function isManagerReviewer(row: unknown): boolean {
  return embeddedRole(row as EmbeddedRoleRow<{ acts_as?: string | null }>)?.acts_as === 'manager';
}

/**
 * 申請先（上長）に「申請が届きました」のベル・メールを送るか。
 * ・自己受理は確認者のキューに入らない ・残業なしの実績報告（差分0）はその場で確定する
 * ・打刻ズレは確認なしで確定する（2026-09-29：1件フォームで申請先の値が残っていて空振りのベルが飛んでいた）
 * 🚨 1件フォームと表入力（まとめて申請）の両方がここを呼ぶ。条件を画面に書き写さない
 */
export function shouldNotifyReviewer(a: {
  isSelfReview: boolean; isPureZero: boolean; clockOnly: boolean; reviewerId: string | null | undefined;
}): boolean {
  return !a.isSelfReview && !a.isPureZero && !a.clockOnly && !!a.reviewerId;
}

/**
 * ベル・メールに出す申請の呼び名。
 * 🚨 差し戻しの再提出は「再提出」、取り消して出し直した修正は「修正の再申請」（受理者が同じ日の申請がまた来たと思わないように）
 */
export function reviewerPhaseLabel(a: { isResubmit: boolean; phase: 'planned' | 'actual'; isModifiedReapply: boolean }): string {
  if (a.isResubmit) return '再提出';
  if (a.phase === 'actual') return '実績報告';
  return a.isModifiedReapply ? '修正の再申請' : '事前申請';
}

/** 修正の記録（履歴）に残す一行。種別を変えた再提出は記録に残す（受理者が「何が変わったか」を追う手掛かり） */
export function editHistorySummary(a: {
  isReportPhase: boolean; isPureZero: boolean; changedAxes: string[];
  typeSwitched: 'toTime' | 'toFullDay' | null;
}): string {
  if (a.isReportPhase) {
    if (a.isPureZero) return '残業なし（通常どおり）で報告';
    return a.changedAxes.length > 0 ? `実績報告（変更あり：${a.changedAxes.join('・')}）` : '実績報告（予定どおり）';
  }
  if (a.typeSwitched === 'toTime') return '再提出（終日 → 時間の申請に変更）';
  if (a.typeSwitched === 'toFullDay') return '再提出（時間の申請 → 終日に変更）';
  return '再提出';
}

// ────────────────────────────────────────────
// 締め後の許可の依頼
// ────────────────────────────────────────────

/** 依頼の送信に失敗したときの文（DB が返すエラー名を日本語にする） */
export function grantRequestErrorMessage(dbMessage: string): string {
  const msg = dbMessage || '';
  if (msg.includes('NOT_LOCKED')) return 'まだ締め切り前の日が含まれています。締め切りを過ぎた日のみ選択してください';
  if (msg.includes('PAYOUT_PASSED')) return '給与データが確定済みの日が含まれています。管理者にご相談ください';
  if (msg.includes('ALREADY_GRANTED')) return '既に許可されている日が含まれています';
  if (msg.includes('DUPLICATE_REQUEST')) return '既に依頼中の日が含まれています';
  return '依頼の送信に失敗しました';
}

/** 複数の対象日を「7/18・7/19」のように短く整形（4件以上は「7/18・7/19 他N件」に省略）。1件フォームから移した（2026-09-29） */
export function formatGrantDates(dates: string[]): string {
  const sorted = [...dates].sort();
  const short = (d: string) => `${parseInt(d.slice(5, 7))}/${parseInt(d.slice(8, 10))}`;
  if (sorted.length <= 3) return sorted.map(short).join('・');
  return `${sorted.slice(0, 2).map(short).join('・')} 他${sorted.length - 2}件`;
}
