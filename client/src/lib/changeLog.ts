// 「受理済みの変更」（管理画面・2026-10-26 ユーザー確定・計画 docs/計画-経理向け変わった申請の一覧.md）の読み方。
// 記録は DB の application_change_log（トリガーが書く）。読むのは admin_change_log(給与期間の初日)。
// 🚨 このファイルは supabase を読まない（判定と文字だけ）
import { APPLICATION_KIND_LABEL, statusLabel, type ApplicationKind } from './applicationStatus';
import { isOvertimeType, typeLabelFor } from './overtimeTypes';
import { SHIFT_TYPE_INFO, type ShiftAppType } from './shiftReportTypes';
import { calcPayPeriodStartJst, formatMin, payPeriodCloseCutoff, toJstDateStr } from './breakCalc';
import type { PayrollCheckKind } from './payrollCheckMark';

type J = Record<string, unknown>;
export interface ChangeLogRow {
  id: string; at: string; kind: ApplicationKind; record_id: string; applicant_id: string | null;
  op: 'insert' | 'update' | 'delete'; event: string; old_status: string | null; new_status: string | null;
  accepted_before: boolean; accepted_after: boolean; target_dates: string[]; periods: string[];
  before: J | null; after: J | null; actor_id: string | null; actor_via: 'user' | 'edge' | 'system'; reason: string | null;
  applicant_name: string | null; employee_no: string | null; actor_name: string | null; actor_role: string | null; actor_is_admin_role: boolean | null;
}
export interface CheckMark { id: string; period_start: string; kind: PayrollCheckKind; upto: string; row_count: number | null; marked_at: string; marked_by_name: string | null }
export interface ChangeLogData { since: string | null; count: number; truncated: boolean; rows: ChangeLogRow[]; closed: ChangeLogRow[]; marks: CheckMark[]; errors: number }

/** 同じ申請を同じ人が続けて直した行（例：申請の行と時間帯の行）を1つにまとめたもの */
export interface ChangeItem {
  key: string; kind: ApplicationKind; record_id: string; at: string; firstAt: string;
  applicant_id: string | null; applicant_name: string; employee_no: string | null;
  events: string[]; old_status: string | null; new_status: string | null;
  accepted_before: boolean; accepted_after: boolean; target_dates: string[];
  before: J | null; after: J | null; actor: string; reason: string | null; rebuilt: boolean; approxWindow: string | null;
  rows: ChangeLogRow[];
}

const MERGE_MS = 3 * 60 * 1000;
/** 作り直しの札と時刻の幅を外した理由（札は画面の別の印で出す） */
const cleanReason = (v: string | null): string | null => (v ?? '').replace('【バックアップから作り直し】', '').replace(/（時刻は .* のどこか）/, '').trim() || null;
const REBUILT = '【バックアップから作り直し】';

export function actorLabel(r: Pick<ChangeLogRow, 'actor_id' | 'applicant_id' | 'actor_name' | 'actor_is_admin_role' | 'reason'>): string {
  if (!r.actor_id) return (r.reason ?? '').startsWith(REBUILT) ? '不明' : '自動';
  if (r.actor_is_admin_role) return '管理者（共用）';
  if (r.actor_id === r.applicant_id) return '本人';
  return r.actor_name || '不明';
}

/** 行をまとめる（並びは古い順で渡す） */
export function mergeRows(rows: ChangeLogRow[]): ChangeItem[] {
  const out: ChangeItem[] = [];
  const last = new Map<string, ChangeItem>();
  for (const r of rows) {
    const prev = last.get(r.record_id);
    const t = new Date(r.at).getTime();
    if (prev && t - new Date(prev.at).getTime() <= MERGE_MS && prev.rows[prev.rows.length - 1].actor_id === r.actor_id && r.op !== 'insert') {
      prev.rows.push(r);
      prev.at = r.at;
      if (r.event !== 'time_changed' || prev.events.every(e => e === 'time_changed')) {
        if (!prev.events.includes(r.event)) prev.events.push(r.event);
      }
      prev.new_status = r.new_status ?? prev.new_status;
      prev.accepted_after = r.accepted_after;
      prev.after = { ...(prev.after ?? {}), ...(r.after ?? {}) };
      // 作った行（前が無い）は前を足さない。直した行は、時間帯の前をあとの行から補う
      if (r.before && prev.before) prev.before = { ...r.before, ...prev.before };
      prev.target_dates = [...new Set([...prev.target_dates, ...r.target_dates])].sort();
      const rr = cleanReason(r.reason);
      if (rr && !prev.reason) prev.reason = rr;
      continue;
    }
    const rebuilt = (r.reason ?? '').startsWith(REBUILT);
    const m = rebuilt ? (r.reason ?? '').match(/時刻は (\S+) 〜 (\S+) のどこか/) : null;
    const item: ChangeItem = {
      key: r.id, kind: r.kind, record_id: r.record_id, at: r.at, firstAt: r.at,
      applicant_id: r.applicant_id, applicant_name: r.applicant_name || '不明', employee_no: r.employee_no,
      events: [r.event], old_status: r.old_status, new_status: r.new_status,
      accepted_before: r.accepted_before, accepted_after: r.accepted_after, target_dates: [...r.target_dates],
      before: r.before, after: r.after, actor: actorLabel(r),
      reason: cleanReason(r.reason),
      rebuilt, approxWindow: m ? `${jstAt(m[1])}〜${jstAt(m[2])}` : null, rows: [r],
    };
    out.push(item);
    last.set(r.record_id, item);
  }
  return out;
}

/** 給与の数字にかかわるか（受理済みの前か後か・勤怠カレンダーは常に） */
export const isPayrollRelevant = (it: ChangeItem): boolean => it.kind === 'attendance' || it.accepted_before || it.accepted_after;

/** 締め（支給月の17日）を過ぎてからの変更か。対象日の期のうち、いちばん早い期で見る */
export function isAfterClose(it: ChangeItem): boolean {
  const day = toJstDateStr(new Date(it.at));
  return it.target_dates.some(d => day > payPeriodCloseCutoff(calcPayPeriodStartJst(d)));
}

export const jstAt = (iso: string): string =>
  new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
export const mdDow = (d: string): string => {
  const [y, m, dd] = d.slice(0, 10).split('-').map(Number);
  return `${m}/${dd}（${DOW[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]}）`;
};
export function datesText(dates: string[]): string {
  if (!dates.length) return '';
  return dates.length === 1 ? mdDow(dates[0]) : `${mdDow(dates[0])} ほか${dates.length - 1}日`;
}

const EVENT_LABEL: Record<string, string> = {
  created: '新しく出した', accepted: '受理', pre_accepted: '事前受理', reported: '実績を報告', step: '受理（途中の段）',
  returned: '差し戻し', resubmitted: '再提出', cancelled: '取消', deleted: '削除', edited: '内容を変更',
  time_changed: '時刻を変更', status: '状態の変更',
};
export function eventText(it: ChangeItem): string {
  const evs = it.events.filter(e => !(e === 'time_changed' && it.events.length > 1));
  return evs.map(e => (e === 'created' && it.accepted_after ? '受理済みで出した' : EVENT_LABEL[e] ?? e)).join('・');
}

const ATT_TYPE: Record<string, string> = {
  absent: '欠勤', early_end: '早退', early_leave: '早退', holiday_work: '休日出勤', late: '遅刻', late_start: '遅出',
  location_change: '勤務地変更', time_change: '時間変更',
};
/** 何の申請か（種類の名前） */
export function itemTypeText(it: ChangeItem): string {
  const r = (it.after ?? it.before ?? {}) as J;
  if (it.kind === 'overtime') {
    const ts = (Array.isArray(r.application_types) ? r.application_types : []).filter((t): t is string => typeof t === 'string').filter(isOvertimeType);
    return ts.map(t => typeLabelFor(t, r as never)).join('・') || '残業';
  }
  if (it.kind === 'shift') {
    const ts = (Array.isArray(r.application_types) && r.application_types.length ? r.application_types : [r.application_type]) as ShiftAppType[];
    return ts.map(t => SHIFT_TYPE_INFO[t]?.label ?? String(t ?? '')).filter(Boolean).join('＋') || '勤務変更';
  }
  if (it.kind === 'leave') {
    const t = String(r.leave_type === 'その他' ? (r.leave_type_other || 'その他') : (r.leave_type ?? '休暇'));
    // 時間外調整休の印（残業の時間から引く・2026-10-20）。印だけ変わったときに前と後が同じ言葉にならないように
    return r.chosei_sub_type === 'zangyou' ? `${t}（残業から引く）` : t;
  }
  if (it.kind === 'attendance') return ATT_TYPE[String(r.type)] ?? String(r.type ?? '勤怠カレンダー');
  return '交通費';
}

const hm = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
const signed = (min: number) => `${min < 0 ? '−' : '+'}${formatMin(min)}`;
type Seg = { phase: string; seg_no: number; start_min: number; end_min: number };
function segText(v: unknown): string {
  const segs = (Array.isArray(v) ? v : []) as Seg[];
  const actual = segs.some(s => s.phase === 'actual');
  const use = actual ? segs.filter(s => s.phase === 'actual') : segs;
  const t = use.map(s => `${hm(s.start_min)}〜${hm(s.end_min)}`).join('・');
  return t ? `${actual ? '実績' : '予定'} ${t}` : 'なし';
}
const t5 = (v: unknown) => (typeof v === 'string' ? v.slice(0, 5) : '');
const yen = (v: unknown) => {
  const items = Array.isArray(v) ? (v as J[]) : [];
  return items.reduce((a, x) => a + (Number(String(x.amount ?? '').replace(/[^\d]/g, '')) || 0), 0);
};

/** 給与の数字への影響（残業の時間数の差）。受理済みの前後だけを数える */
export function overtimeMinutesDelta(it: ChangeItem): number | null {
  if (it.kind !== 'overtime') return null;
  const b = it.accepted_before && typeof it.before?.diff_minutes === 'number' ? (it.before.diff_minutes as number) : 0;
  const a = it.accepted_after && typeof it.after?.diff_minutes === 'number' ? (it.after.diff_minutes as number) : 0;
  if (!it.accepted_before && !it.accepted_after) return null;
  return a - b;
}

/** 前 → 後 の中身（変わったところだけ） */
export function changeLines(it: ChangeItem): string[] {
  const b = (it.before ?? {}) as J, a = (it.after ?? {}) as J;
  const out: string[] = [];
  const changed = (k: string) => it.before && it.after && JSON.stringify(b[k] ?? null) !== JSON.stringify(a[k] ?? null);
  if (it.old_status !== it.new_status && it.old_status && it.new_status) {
    out.push(`状態　${statusLabel(it.kind, it.old_status)} → ${statusLabel(it.kind, it.new_status)}`);
  }
  if (it.kind === 'overtime') {
    if (changed('work_date')) out.push(`日付　${mdDow(String(b.work_date))} → ${mdDow(String(a.work_date))}`);
    if (changed('application_types')) out.push(`種類　${itemTypeText({ ...it, after: b })} → ${itemTypeText(it)}`);
    if ('segments' in a || 'segments' in b) {
      if (it.before && 'segments' in b && JSON.stringify(b.segments) !== JSON.stringify(a.segments)) out.push(`時刻　${segText(b.segments)} → ${segText(a.segments)}`);
      else if (!it.before || !('segments' in b)) out.push(`時刻　${segText(a.segments)}`);
    }
    if (changed('diff_minutes')) out.push(`時間数　${signed(Number(b.diff_minutes ?? 0))} → ${signed(Number(a.diff_minutes ?? 0))}`);
    else if (!it.before && typeof a.diff_minutes === 'number') out.push(`時間数　${signed(a.diff_minutes)}`);
    if (changed('location')) out.push(`勤務地　${b.location ?? '—'} → ${a.location ?? '—'}`);
    if (changed('furikae_origin_date')) out.push(`振替元　${b.furikae_origin_date ? mdDow(String(b.furikae_origin_date)) : '—'} → ${a.furikae_origin_date ? mdDow(String(a.furikae_origin_date)) : '—'}`);
    if (changed('furikae_origin_start') || changed('furikae_origin_end')) out.push(`振替元の時刻　${t5(b.furikae_origin_start)}〜${t5(b.furikae_origin_end)} → ${t5(a.furikae_origin_start)}〜${t5(a.furikae_origin_end)}`);
  } else if (it.kind === 'leave') {
    if (changed('leave_type') || changed('leave_type_other') || changed('chosei_sub_type')) out.push(`種類　${itemTypeText({ ...it, after: b })} → ${itemTypeText(it)}`);
    if (changed('leave_dates') || changed('start_date') || changed('end_date')) out.push(`日付　${datesText(datesOfLeave(b))} → ${datesText(datesOfLeave(a))}`);
  } else if (it.kind === 'shift') {
    if (changed('work_date')) out.push(`日付　${mdDow(String(b.work_date))} → ${mdDow(String(a.work_date))}`);
    if (changed('actual_start') || changed('actual_end') || !it.before) out.push(`変更後　${it.before ? `${t5(b.actual_start)}〜${t5(b.actual_end)} → ` : ''}${t5(a.actual_start)}〜${t5(a.actual_end)}`);
    if (changed('original_start') || changed('original_end')) out.push(`変更前　${t5(b.original_start)}〜${t5(b.original_end)} → ${t5(a.original_start)}〜${t5(a.original_end)}`);
    if (changed('labor_minutes')) out.push(`労働時間　${hm(Number(b.labor_minutes ?? 0))} → ${hm(Number(a.labor_minutes ?? 0))}`);
  } else if (it.kind === 'expense') {
    const yb = yen(b.expenses_data), ya = yen(a.expenses_data);
    if (it.before && it.after && yb !== ya) out.push(`金額　${yb.toLocaleString()}円 → ${ya.toLocaleString()}円`);
    else out.push(`金額　${(it.after ? ya : yb).toLocaleString()}円`);
  } else if (it.kind === 'attendance') {
    if (changed('date')) out.push(`日付　${mdDow(String(b.date))} → ${mdDow(String(a.date))}`);
    if (changed('type')) out.push(`種類　${ATT_TYPE[String(b.type)] ?? b.type} → ${ATT_TYPE[String(a.type)] ?? a.type}`);
    if (changed('actual_time') || (!it.before && a.actual_time)) out.push(`時刻　${it.before ? `${t5(b.actual_time) || '—'} → ` : ''}${t5(a.actual_time) || '—'}`);
    if (changed('location')) out.push(`勤務地　${b.location ?? '—'} → ${a.location ?? '—'}`);
  }
  return out;
}

function datesOfLeave(r: J): string[] {
  const ld = r.leave_dates;
  if (typeof ld === 'string' && ld.startsWith('[')) {
    try { const a = JSON.parse(ld); if (Array.isArray(a) && a.length) return a.map(String); } catch { /* 下へ */ }
  }
  return r.start_date ? [String(r.start_date)] : [];
}

export const kindLabel = (k: ApplicationKind) => APPLICATION_KIND_LABEL[k];

/** 一覧の2行目（何の申請か）。残業は種類に「残業」が入るので「残業申請（…）」にする */
export function itemHeadText(it: ChangeItem): string {
  const t = itemTypeText(it);
  if (it.kind === 'expense') return '交通費';
  if (it.kind === 'overtime') return `残業申請（${t}）`;
  return `${APPLICATION_KIND_LABEL[it.kind]}・${t}`;
}
