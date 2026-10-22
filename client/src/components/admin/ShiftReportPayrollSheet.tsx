import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { calcPayPeriodStartJst, payPeriodEnd, todayJstStr, formatMin } from '../../lib/breakCalc';
import type { CalendarKind } from '../../lib/breakCalc';
import { resolveNormalShift, normalShiftTimeText, type PatternRow } from '../../lib/overtimeShift';
import { CALENDAR_CELL_STYLE } from '../../hooks/useCompanyCalendar';
import { parseSegments, formatSegs, formatSegsFromRecord, segMinutes, calcSegsBreak, shiftReportDiff, summarizeShiftDiffs } from '../../lib/shiftCalc';
import { compareEmployeeNo } from '../../lib/employeeNo';
import { SHIFT_TYPE_INFO, type ShiftAppType } from '../../lib/shiftReportTypes';
import { payrollPeriodOptions, periodDays, readAllRows, sheetHm, type PersonSheet, type SheetDay, type SheetEntry } from '../../lib/payrollSheet';
import PayrollSheetView from './PayrollSheetView';

/**
 * 勤務変更の［表で見る］（2026-10-21 ユーザー確定・残業の表と同じ形）。見た目は PayrollSheetView（残業と共用）。
 * ・合計は通常シフトとの差の合計（勤務変更の一覧の「差分」・個人のまとめと同じ summarizeShiftDiffs。ユーザー確定 案A）。欠勤は日数で別に
 * ・受理済みは普通に。確認待ち（pending・resubmitted）は灰色で合計に入れない。差し戻し・取消は出さない
 * ・報告がある日の通常シフトは報告の「変更前」、無い日は登録シフト（resolveNormalShift）
 * 🚨 読めなかったときに「休み」や 0:00 と出さない
 */

interface Rep {
  id: string; applicant_id: string; work_date: string; status: string; pay_period_start: string;
  application_type: string; application_types: string[] | null; reason: string | null;
  original_segments: unknown; original_start: string | null; original_end: string | null; original_outing_start: string | null; original_outing_end: string | null; original_location: string | null;
  actual_segments: unknown; actual_start: string | null; actual_end: string | null; actual_outing_start: string | null; actual_outing_end: string | null; actual_location: string | null;
  labor_minutes: number | null; confirmed_by: string | null; created_at: string;
}
interface Staff { id: string; name: string; employee_no: string | null; is_active: boolean; employment_type: string | null; hire_date: string | null; retire_date: string | null }
interface Loaded { staff: Staff[]; reps: Rep[]; patterns: PatternRow[]; calendar: Record<string, CalendarKind>; names: Record<string, string> }

const PENDING = ['pending', 'resubmitted'];

const ShiftReportPayrollSheet: React.FC<{
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
    const [staffRes, repRes, patRes, calRes] = await Promise.all([
      readAllRows<Staff>((a, b) => supabase.from('profiles').select('id, name, employee_no, is_active, employment_type, hire_date, retire_date').order('id').range(a, b)),
      readAllRows<Rep>((a, b) => supabase.from('shift_reports')
        .select('id, applicant_id, work_date, status, pay_period_start, application_type, application_types, reason, original_segments, original_start, original_end, original_outing_start, original_outing_end, original_location, actual_segments, actual_start, actual_end, actual_outing_start, actual_outing_end, actual_location, labor_minutes, confirmed_by, created_at')
        .eq('pay_period_start', period).order('id').range(a, b)),
      readAllRows<PatternRow>((a, b) => supabase.from('weekly_shift_patterns').select('*').order('id').range(a, b)),
      readAllRows<{ date: string; kind: CalendarKind }>((a, b) => supabase.from('company_calendar').select('date, kind').gte('date', period).lte('date', end).order('date').range(a, b)),
    ]);
    const errs = [
      staffRes.error && 'スタッフ：' + staffRes.error, repRes.error && '報告：' + repRes.error,
      patRes.error && '通常シフト：' + patRes.error, calRes.error && '会社カレンダー：' + calRes.error,
    ].filter(Boolean);
    if (errs.length) { setLoadErr('読み込めませんでした（' + errs.join('／') + '）。通信環境の良い場所で、もう一度開いてください。'); setData(null); setLoading(false); return; }
    const calendar: Record<string, CalendarKind> = {};
    calRes.rows.forEach(c => { calendar[c.date] = c.kind; });
    setData({ staff: staffRes.rows, reps: repRes.rows, patterns: patRes.rows, calendar, names: Object.fromEntries(staffRes.rows.map(s => [s.id, s.name])) });
    setLoading(false);
  }, [period, end]);
  useEffect(() => { load(); }, [load]);

  // 表に出す人：在籍のパートさん（通常シフトがある人）＋この期に勤務変更を出した人。従業員番号の順（番号の無い人は最後）
  const people = useMemo(() => {
    if (!data) return [];
    const withReps = new Set(data.reps.map(r => r.applicant_id));
    const withPattern = new Set(data.patterns.map(p => p.user_id));
    return data.staff
      .filter(s => withReps.has(s.id) || (s.is_active && s.employment_type === 'パート' && withPattern.has(s.id) && (!s.hire_date || s.hire_date <= end) && (!s.retire_date || s.retire_date >= period)))
      .sort((a, b) => compareEmployeeNo(a.employee_no, a.name, b.employee_no, b.name));
  }, [data, period, end]);
  useEffect(() => { if (people.length && (!personId || !people.some(p => p.id === personId))) setPersonId(people[0].id); }, [people, personId]);
  const person = people.find(p => p.id === personId) ?? null;

  // 1人分の表（1人ずつ・並べて見る・Excel が同じものを使う・2026-10-22）
  const sheetFor = useCallback((id: string): PersonSheet | null => {
    const person = people.find(p => p.id === id);
    if (!data || !person) return null;
    const reps = data.reps.filter(r => r.applicant_id === person.id && r.status !== 'returned' && r.status !== 'cancelled');
    const sum = summarizeShiftDiffs(reps);
    const pats = data.patterns.filter(p => p.user_id === person.id);
    const days: SheetDay[] = periodDays(period).map(d => {
      const employed = (!person.hire_date || d >= person.hire_date) && (!person.retire_date || d <= person.retire_date);
      const dayReps = reps.filter(r => r.work_date === d).sort((a, b) => a.created_at.localeCompare(b.created_at));
      const cal = data.calendar[d] ?? null;
      // 報告がある日は報告の「変更前」（差分はこれで計算されている）。休日出勤などで変更前が空なら「休み」
      const withOrig = dayReps.find(r => parseSegments(r.original_segments, r.original_start, r.original_end, r.original_outing_start, r.original_outing_end).length > 0);
      let nsLines: string[] = []; let laborText = '-';
      if (withOrig) {
        const segs = parseSegments(withOrig.original_segments, withOrig.original_start, withOrig.original_end, withOrig.original_outing_start, withOrig.original_outing_end, withOrig.original_location);
        nsLines = formatSegs(segs).split(' / ');
        const brk = calcSegsBreak(segs);
        laborText = `${formatMin(Math.max(0, segMinutes(segs) - brk))}(${formatMin(brk)})`;
      } else if (dayReps.length === 0 && employed) {
        const ns = resolveNormalShift(pats, d, cal);
        const t = normalShiftTimeText(ns);
        if (t) { nsLines = t.split(' / '); laborText = `${formatMin(ns.labor_minutes)}(${formatMin(ns.break_minutes)})`; }
      }
      const entries: SheetEntry[] = dayReps.map((r): SheetEntry => {
        const pend = PENDING.includes(r.status);
        const types = (r.application_types?.length ? r.application_types : [r.application_type]) as ShiftAppType[];
        const typeText = types.map(t => SHIFT_TYPE_INFO[t]?.label ?? t).join('・');
        const reason = [typeText, r.reason?.trim()].filter(Boolean).join('：');
        const absent = types.includes('absence');
        const diff = shiftReportDiff(r).diff;
        const sign = pend ? '（確認待ち）'
          : r.confirmed_by ? (r.confirmed_by === r.applicant_id ? '自己受理' : (data.names[r.confirmed_by] || '不明')) : '';
        return {
          key: r.id,
          reason,
          sign,
          actual: absent ? '欠勤' : formatSegsFromRecord(r.actual_segments, r.actual_start, r.actual_end, r.actual_outing_start, r.actual_outing_end, r.actual_location),
          time: diff == null ? '' : pend ? `（${sheetHm(diff)}）` : sheetHm(diff),
          muted: pend,
          strike: false,
          timeColor: !pend && diff != null && diff < 0 ? '#c62828' : undefined,
          minutes: pend ? null : diff,
        };
      });
      return {
        date: d,
        nsLines,
        offLabel: !employed && dayReps.length === 0 ? '—' : cal === 'closed_all' ? CALENDAR_CELL_STYLE.closed_all.short : '休み',
        laborText,
        entries,
      };
    });
    return {
      total: sum.total,
      totalNote: '通常シフトとの差の合計です。確認待ちは合計に入っていません',
      plannedText: sum.planned !== sum.total
        ? `見込み ${sheetHm(sum.planned)}（確定 ${sheetHm(sum.total)}・確認待ち ${sheetHm(sum.planned - sum.total)}）`
        : null,
      absenceDays: sum.absenceDays,
      pendingText: sum.pendingCount > 0 ? `確認待ちが${sum.pendingCount}件あります。受理されると合計に入ります。` : null,
      emptyText: reps.length === 0 ? 'この期間の勤務変更の報告はありません' : null,
      days,
    };
  }, [data, people, period]);

  return (
    <PayrollSheetView isDarkMode={isDarkMode} onBack={onBack}
      periodOptions={periodOptions} period={period} onPeriod={setPeriod}
      loading={loading || !data} loadErr={loadErr} onReload={load}
      people={people} personId={person?.id ?? null} onPerson={setPersonId}
      kindLabel="勤務変更" sheetFor={sheetFor} />
  );
};

export default ShiftReportPayrollSheet;
