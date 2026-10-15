// 出張報告から作る申請の下書き（「出張の申請がまだの日」・2026-10-14 ユーザー確定・計画は docs/計画-出張報告から申請.md）
// 🚨 どの日が「まだ」かは DB の my_trip_pending_days だけで決める（出張報告の組み合わせ・泊まり・申請済み・定時の記録・締めた期間）。
//    画面で数え直さない（出張報告の画面・残業申請・勤務変更の3か所が同じ答えを使う）
import { supabase } from './supabaseClient';
import { useAppDateSetting } from './overtimeUnify';
import { calcPayPeriodStartJst, payPeriodCloseCutoff } from './breakCalc';

/**
 * 機能を出す日（app_settings trip_apply_start・2026-10-16）。この日から「まだの日」の一覧・下書きの案内・画面の説明が出る。
 * 🚨 一覧は DB の my_trip_pending_days も同じ値を見る（日付を変えるときは設定だけ直す・deploy 不要）
 */
export const useTripApplyStart = (): string | null => useAppDateSetting('trip_apply_start');

export interface TripPendingDay {
  work_date: string;
  /** パートの方は勤務変更、それ以外は残業申請 */
  form: 'overtime' | 'shift_report';
  /** 泊まりがけのときの初めと終わり（1日なら work_date と同じ） */
  span_start: string;
  span_end: string;
  location: string;
  /** 行き先リストの行（自分で書いた行き先は null） */
  location_option_id: string | null;
  /** その日の到着・終了の報告の時刻（無ければ null） */
  arrive_at: string | null;
  finish_at: string | null;
}

export async function loadMyTripPendingDays(): Promise<{ days: TripPendingDay[]; error: string | null }> {
  const { data, error } = await supabase.rpc('my_trip_pending_days');
  if (error) return { days: [], error: error.message };
  return { days: (data ?? []) as TripPendingDay[], error: null };
}

/** その日の申請を開くページ（?trip=日付 で、その日の下書きを開く） */
export function tripFormHref(day: Pick<TripPendingDay, 'work_date' | 'form'>): string {
  return `${day.form === 'shift_report' ? '/shift-report' : '/overtime'}?trip=${day.work_date}`;
}

export function tripFormName(form: TripPendingDay['form']): string {
  return form === 'shift_report' ? '勤務変更' : '残業申請';
}

/**
 * 出張報告を送ったあとの1行（2026-10-14 ユーザー確定 案2）。
 * 🚨 到着のときは「今すぐ申請する」を付けない（帰りの時刻が決まっていないため）
 */
export function tripDraftNote(type: '到着' | '終了', day: TripPendingDay): { type: '到着' | '終了'; note: string; action?: { label: string; href: string } } {
  const name = tripFormName(day.form);
  if (type === '到着') return { type, note: `本日の${name}の下書きを作成しました。出張の終了後に申請してください。` };
  return {
    type,
    note: `本日の${name}の下書きを作成しました。時刻を入力して申請してください。`,
    action: { label: '今すぐ申請する →', href: tripFormHref(day) },
  };
}

/** "M/D（曜）"（ほかの画面と同じ形） */
export function tripDayLabel(date: string, withDow = true): string {
  const [y, m, d] = date.split('-').map(Number);
  const w = ['日', '月', '火', '水', '木', '金', '土'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return withDow ? `${m}/${d}（${w}）` : `${m}/${d}`;
}

/** その日の申請の締め切り（支給月の17日・勤務変更の未報告の一覧と同じ）を "M/D（曜）" で */
export function tripDeadlineLabel(date: string): string {
  return tripDayLabel(payPeriodCloseCutoff(calcPayPeriodStartJst(date)));
}

/** 報告の時刻 "H:MM"（日本時間） */
export function tripTimeText(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${jst.getUTCHours()}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
}

/** 「到着 9:42／終了 16:18」。泊まりの途中の日は「泊まりの間（報告なし）」 */
export function tripTimesText(day: TripPendingDay): string {
  const mid = day.span_start !== day.span_end && day.work_date !== day.span_start && day.work_date !== day.span_end;
  if (mid) return '泊まりの間（報告なし）';
  const a = day.arrive_at ? `到着 ${tripTimeText(day.arrive_at)}` : (day.work_date === day.span_start ? '到着の報告なし' : '');
  const f = day.finish_at ? `終了 ${tripTimeText(day.finish_at)}` : (day.work_date === day.span_end ? '終了の報告なし' : '');
  return [a, f].filter(Boolean).join('／');
}
