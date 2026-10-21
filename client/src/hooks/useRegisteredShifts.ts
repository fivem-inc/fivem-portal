import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { PatternRow } from '../lib/overtimeShift';
import type { CalendarKind } from '../lib/breakCalc';
import { registeredShiftFor, type RegisteredShift } from '../lib/shiftRegistered';

/**
 * 勤務変更の報告の一覧で、人と日付ごとの登録シフトを引く（2026-10-21 ユーザー確定 案A の③・受理する人の画面）。
 * 一覧に出ている人の曜日ごとのシフトと、日付の範囲の会社カレンダーを1回ずつ読む。
 * 🚨 読めない（権限・通信）ときは null を返す＝知らせを出さない（間違った知らせを出さない側に倒す）
 */
export function useRegisteredShifts(rows: { applicant_id: string; work_date: string }[]): (applicantId: string, date: string) => RegisteredShift | null {
  const ids = useMemo(() => [...new Set(rows.map(r => r.applicant_id))].sort(), [rows]);
  const dates = useMemo(() => rows.map(r => r.work_date).sort(), [rows]);
  const from = dates[0] ?? '', to = dates[dates.length - 1] ?? '';
  const idsKey = ids.join(',');
  const [data, setData] = useState<{ pats: Map<string, PatternRow[]>; cal: Record<string, CalendarKind> } | null>(null);
  useEffect(() => {
    if (!idsKey || !from) { setData(null); return; }
    let alive = true;
    (async () => {
      const idList = idsKey.split(',');
      const [patRes, calRes] = await Promise.all([
        supabase.from('weekly_shift_patterns').select('id, user_id, day_kind, start_time, end_time, start_time2, end_time2, location, break_minutes, labor_minutes, valid_from, valid_to').in('user_id', idList).limit(5000),
        supabase.from('company_calendar').select('date, kind').gte('date', from).lte('date', to).limit(2000),
      ]);
      if (!alive) return;
      if (patRes.error || calRes.error) { setData(null); return; }
      const pats = new Map<string, PatternRow[]>();
      ((patRes.data ?? []) as PatternRow[]).forEach(p => { const l = pats.get(p.user_id) ?? []; l.push(p); pats.set(p.user_id, l); });
      const cal: Record<string, CalendarKind> = {};
      ((calRes.data ?? []) as { date: string; kind: CalendarKind }[]).forEach(c => { cal[c.date] = c.kind; });
      setData({ pats, cal });
    })();
    return () => { alive = false; };
  }, [idsKey, from, to]);
  return (applicantId: string, date: string) => {
    if (!data) return null;
    const p = data.pats.get(applicantId);
    if (!p || p.length === 0) return null;   // 登録シフトが無い人（読めない人も）は比べない
    return registeredShiftFor(p, date, data.cal[date] ?? null);
  };
}
