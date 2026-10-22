import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { calcPayPeriodStartJst, payPeriodEnd, todayJstStr, formatMin, minToTime } from '../../lib/breakCalc';
import type { CalendarKind } from '../../lib/breakCalc';
import { resolveNormalShift, normalShiftTimeText, type PatternRow, type NormalShiftSnapshot } from '../../lib/overtimeShift';
import { CALENDAR_CELL_STYLE } from '../../hooks/useCompanyCalendar';
import { computeBalance, duplicateChoseiChecker, type BalanceRow } from '../../lib/overtimeBalance';
import { overtimeApprovedLines, SELF_APPROVED_TEXT } from '../../lib/overtimeApproved';
import { plannedBreakdownRows } from '../../lib/overtimeBalance';
import { compareEmployeeNo } from '../../lib/employeeNo';
import { isOvertimeType, typeLabelFor } from '../../lib/overtimeTypes';
import { payrollPeriodOptions, periodDays, readAllRows, sheetHm, sheetMd, type PersonSheet, type SheetDay, type SheetEntry } from '../../lib/payrollSheet';
import PayrollSheetView from './PayrollSheetView';

/**
 * 残業の［表で見る］（2026-10-21 ユーザー確定・docs/計画-残業の表で見る.md）。見た目は PayrollSheetView（勤務変更と共用）。
 * ・合計は行の足し算ではなく computeBalance（残業の画面・部門集計と同じ数字）。行の時間数はその内訳
 * ・受理済み（confirmed）は普通に。確認待ち（requested・reported）・実績報告待ち（request_confirmed）は灰色で合計に入れない。
 *   差し戻し・取消は出さない
 * ・休暇から自動で作られた行（leave_auto）も出す（合計に入っているため）。同じ日の手で出した調整休は「休暇の側で計上」
 * ・申請がある日の通常シフトは申請に控えたもの（差分はこれで計算されている）。無い日は残業の画面と同じ決まり（resolveNormalShift）
 * 🚨 読めなかったときに「休み」や 0:00 と出さない（給与に効く表で嘘をつかない）
 */

type Status = BalanceRow['status'];
interface Seg { phase: 'planned' | 'actual'; seg_no: number; start_min: number; end_min: number }
interface Rep {
  id: string; applicant_id: string; reviewer_id: string | null; work_date: string; entry_type: string; status: Status;
  pay_period_start: string; normal_shift: NormalShiftSnapshot | null; diff_minutes: number | null; reason: string | null;
  application_types: string[] | null; confirmed_by: string | null; confirmed_at: string | null; request_confirmed_at: string | null;
  late_situation: string | null; early_situation: string | null; created_at: string | null;
  segments: Seg[] | null; hist: { change_kind: string | null }[] | null;
}
interface DayCheck { id: string; user_id: string; work_date: string; shift_snapshot: NormalShiftSnapshot | null }
interface Staff { id: string; name: string; employee_no: string | null; is_active: boolean; hire_date: string | null; retire_date: string | null }
interface Loaded {
  staff: Staff[]; reps: Rep[]; checks: DayCheck[]; patterns: PatternRow[];
  calendar: Record<string, CalendarKind>; furikae: Map<string, string>; names: Record<string, string>;
}

const OvertimePayrollSheet: React.FC<{
  isDarkMode: boolean;
  initialPeriod?: string;
  initialPerson?: string;
  onBack: () => void;
}> = ({ isDarkMode, initialPeriod, initialPerson, onBack }) => {
  const currentPeriod = calcPayPeriodStartJst(todayJstStr());
  const periodOptions = useMemo(() => payrollPeriodOptions(currentPeriod, initialPeriod), [currentPeriod, initialPeriod]);
  const [period, setPeriod] = useState(initialPeriod ?? currentPeriod);
  const [data, setData] = useState<Loaded | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [personId, setPersonId] = useState<string | null>(initialPerson ?? null);

  const end = payPeriodEnd(period);
  const load = useCallback(async () => {
    setLoading(true); setLoadErr('');
    const [staffRes, repRes, dcRes, patRes, calRes, furRes] = await Promise.all([
      readAllRows<Staff>((a, b) => supabase.from('profiles').select('id, name, employee_no, is_active, hire_date, retire_date').eq('employment_type', '正社員').order('id').range(a, b)),
      readAllRows<Rep>((a, b) => supabase.from('overtime_reports')
        .select('id, applicant_id, reviewer_id, work_date, entry_type, status, pay_period_start, normal_shift, diff_minutes, reason, application_types, confirmed_by, confirmed_at, request_confirmed_at, late_situation, early_situation, created_at, segments:overtime_report_segments(phase, seg_no, start_min, end_min), hist:overtime_report_history(change_kind)')
        .eq('pay_period_start', period).order('id').range(a, b)),
      readAllRows<DayCheck>((a, b) => supabase.from('overtime_day_checks').select('id, user_id, work_date, shift_snapshot').gte('work_date', period).lte('work_date', end).order('id').range(a, b)),
      readAllRows<PatternRow>((a, b) => supabase.from('weekly_shift_patterns').select('*').order('id').range(a, b)),
      readAllRows<{ date: string; kind: CalendarKind }>((a, b) => supabase.from('company_calendar').select('date, kind').gte('date', period).lte('date', end).order('date').range(a, b)),
      readAllRows<{ applicant_id: string; work_date: string; furikae_origin_date: string | null }>((a, b) => supabase.from('overtime_reports')
        .select('applicant_id, work_date, furikae_origin_date').eq('entry_type', 'manual').neq('status', 'cancelled')
        .contains('application_types', ['furikae_off']).gte('furikae_origin_date', period).lte('furikae_origin_date', end).order('id').range(a, b)),
    ]);
    const errs = [
      staffRes.error && 'スタッフ：' + staffRes.error, repRes.error && '申請：' + repRes.error, dcRes.error && '定時の記録：' + dcRes.error,
      patRes.error && '通常シフト：' + patRes.error, calRes.error && '会社カレンダー：' + calRes.error, furRes.error && '振替休日：' + furRes.error,
    ].filter(Boolean);
    if (errs.length) { setLoadErr('読み込めませんでした（' + errs.join('／') + '）。通信環境の良い場所で、もう一度開いてください。'); setData(null); setLoading(false); return; }
    const names: Record<string, string> = Object.fromEntries(staffRes.rows.map(s => [s.id, s.name]));
    const others = [...new Set(repRes.rows.flatMap(r => [r.reviewer_id, r.confirmed_by]).filter((x): x is string => !!x && !names[x]))];
    if (others.length) {
      const { data: p } = await supabase.from('profiles').select('id, name').in('id', others);
      ((p ?? []) as { id: string; name: string }[]).forEach(x => { names[x.id] = x.name; });
    }
    const calendar: Record<string, CalendarKind> = {};
    calRes.rows.forEach(c => { calendar[c.date] = c.kind; });
    const furikae = new Map<string, string>();
    furRes.rows.forEach(f => { if (f.furikae_origin_date) furikae.set(`${f.applicant_id}|${f.furikae_origin_date}`, f.work_date); });
    setData({ staff: staffRes.rows, reps: repRes.rows, checks: dcRes.rows, patterns: patRes.rows, calendar, furikae, names });
    setLoading(false);
  }, [period, end]);
  useEffect(() => { load(); }, [load]);

  // 表に出す人：在籍の正社員（通常シフトがある人）＋この期に申請がある人（途中で退職した人も）。従業員番号の順（番号の無い人は最後）
  const people = useMemo(() => {
    if (!data) return [];
    const withReps = new Set(data.reps.map(r => r.applicant_id));
    // 🚨 通常シフト（曜日パターン）が1つも無い在籍者は出さない（管理者・Q&A 用などの仕事用ではないアカウント）
    const withPattern = new Set(data.patterns.map(p => p.user_id));
    return data.staff
      .filter(s => withReps.has(s.id) || (s.is_active && withPattern.has(s.id) && (!s.hire_date || s.hire_date <= end) && (!s.retire_date || s.retire_date >= period)))
      .sort((a, b) => compareEmployeeNo(a.employee_no, a.name, b.employee_no, b.name));
  }, [data, period, end]);
  useEffect(() => { if (people.length && (!personId || !people.some(p => p.id === personId))) setPersonId(people[0].id); }, [people, personId]);
  const person = people.find(p => p.id === personId) ?? null;

  // 1人分の表（1人ずつ・並べて見る・Excel が同じものを使う・2026-10-22）
  const sheetFor = useCallback((id: string): PersonSheet | null => {
    const person = people.find(p => p.id === id);
    if (!data || !person) return null;
    const nameOf = (id: string) => data.names[id] || '不明';
    const reps = data.reps.filter(r => r.applicant_id === person.id && r.status !== 'returned' && r.status !== 'cancelled');
    const balance = computeBalance(data.reps.filter(r => r.applicant_id === person.id) as BalanceRow[], period);
    const isDup = duplicateChoseiChecker(reps.filter(r => r.status === 'confirmed'));
    const pats = data.patterns.filter(p => p.user_id === person.id);
    const checks = data.checks.filter(c => c.user_id === person.id);
    const pending = reps.filter(r => r.status !== 'confirmed').length;
    const days: SheetDay[] = periodDays(period).map(d => {
      const employed = (!person.hire_date || d >= person.hire_date) && (!person.retire_date || d <= person.retire_date);
      const dayReps = reps.filter(r => r.work_date === d)
        .sort((a, b) => (a.entry_type === b.entry_type ? String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) : a.entry_type === 'manual' ? -1 : 1));
      const dayChecks = checks.filter(c => c.work_date === d);
      const snap = dayReps.find(r => r.entry_type === 'manual' && r.normal_shift)?.normal_shift ?? dayChecks[0]?.shift_snapshot ?? null;
      const cal = data.calendar[d] ?? null;
      const ns = snap ?? (employed ? resolveNormalShift(pats, d, cal) : null);
      const nsText = ns ? normalShiftTimeText(ns) : '';
      const entries: SheetEntry[] = [
        ...dayReps.map((r): SheetEntry => {
          const pendingLabel = r.status === 'request_confirmed' ? '（実績報告待ち）' : r.status === 'confirmed' ? '' : '（確認待ち）';
          const dup = r.status === 'confirmed' && isDup(r);
          const segs = r.segments ?? [];
          const usePhase = segs.some(s => s.phase === 'actual') ? 'actual' : 'planned';
          const actual = segs.filter(s => s.phase === usePhase).sort((a, b) => a.seg_no - b.seg_no).map(s => `${minToTime(s.start_min)}〜${minToTime(s.end_min)}`).join(' / ');
          const typeText = (r.application_types ?? []).filter(isOvertimeType).map(t => typeLabelFor(t, r)).join('・');
          const sign = r.entry_type === 'leave_auto' ? '自動（休暇から）'
            : pendingLabel || overtimeApprovedLines(r, nameOf).map(l => (l.label === '確定' ? `確定：${l.name}` : l.name.replace(SELF_APPROVED_TEXT, '自己受理'))).join('／');
          const diff = r.diff_minutes ?? 0;
          return {
            key: r.id,
            reason: r.reason?.trim() || typeText || (r.entry_type === 'leave_auto' ? '休暇（自動）' : ''),
            sign: dup ? '（休暇の側で計上）' : sign,
            actual,
            time: r.status === 'confirmed' ? sheetHm(diff) : `（${sheetHm(diff)}）`,
            muted: r.status !== 'confirmed' || dup,
            strike: dup,
            timeColor: r.status === 'confirmed' && !dup && diff < 0 ? '#c62828' : undefined,
            minutes: r.status === 'confirmed' && !dup ? diff : null,
          };
        }),
        ...dayChecks.map((c): SheetEntry => ({ key: `dc-${c.id}`, reason: '定時', sign: '定時', actual: '', time: '0:00', muted: false, strike: false, minutes: 0 })),
      ];
      const furikaeTo = data.furikae.get(`${person.id}|${d}`);
      if (furikaeTo) entries.unshift({ key: `fk-${d}`, reason: `振替元（${sheetMd(furikaeTo)}の振替休日で計上）`, sign: '', actual: '', time: '', muted: true, strike: false });
      return {
        date: d,
        nsLines: nsText ? nsText.split(' / ') : [],
        offLabel: !employed && !snap ? '—' : cal === 'closed_all' ? CALENDAR_CELL_STYLE.closed_all.short : '休み',
        laborText: nsText && ns ? `${formatMin(ns.labor_minutes)}(${formatMin(ns.break_minutes)})` : '-',
        entries,
      };
    });
    return {
      total: balance.total,
      totalNote: '確認待ち・実績報告待ちは合計に入っていません',
      plannedText: balance.plannedDelta !== 0
        ? `見込み ${sheetHm(balance.plannedTotal)}（確定 ${sheetHm(balance.total)}${plannedBreakdownRows(balance).map(([l, m]) => `・${l} ${sheetHm(m)}`).join('')}）`
        : null,
      absenceDays: balance.absenceDays,
      pendingText: pending > 0 ? `確認待ち・実績報告待ちが${pending}件あります。受理され、実績が確定すると合計に入ります。` : null,
      emptyText: reps.length === 0 && checks.length === 0 ? 'この期間の残業・時間調整の申請はありません' : null,
      days,
    };
  }, [data, people, period]);

  return (
    <PayrollSheetView isDarkMode={isDarkMode} onBack={onBack}
      periodOptions={periodOptions} period={period} onPeriod={setPeriod}
      loading={loading || !data} loadErr={loadErr} onReload={load}
      people={people} personId={person?.id ?? null} onPerson={setPersonId}
      kindLabel="残業" sheetFor={sheetFor} />
  );
};

export default OvertimePayrollSheet;
