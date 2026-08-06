import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { CalendarKind } from '../lib/breakCalc';

/**
 * 会社カレンダー（休館日・出勤日）を日付をキーにして返す。
 *
 * 管理画面「残業・時間管理 → 会社カレンダー」で登録した内容を、
 * 各画面のカレンダーや申請フォームで共通に使うためのもの。
 * 同じ取得処理を画面ごとに書くと必ず食い違うので、ここに集約している。
 *
 * 取得できないとき（通信失敗など）は空で返す。
 * 休館日の表示は「あれば親切」なものなので、取れなくても画面は普通に使える。
 */
export const useCompanyCalendar = (fromDate?: string, toDate?: string) => {
  const [kinds, setKinds] = useState<Record<string, CalendarKind>>({});

  useEffect(() => {
    let alive = true;
    let q = supabase.from('company_calendar').select('date, kind');
    if (fromDate) q = q.gte('date', fromDate);
    if (toDate) q = q.lte('date', toDate);
    q.then(({ data }) => {
      if (!alive || !data) return;
      const map: Record<string, CalendarKind> = {};
      (data as { date: string; kind: CalendarKind }[]).forEach(r => { map[r.date] = r.kind; });
      setKinds(map);
    }, () => {});
    return () => { alive = false; };
  }, [fromDate, toDate]);

  return kinds;
};

/** カレンダーのセルに敷く色。休館日＝グレー、出勤日＝薄い黄色。
 *  既存の丸印（欠勤・遅刻など6色）とぶつからないよう、色ではなく「面」で区別する。
 *  ライト/ダーク共通の固定色（暗い背景でも文字が読めるトーンを選んでいる） */
export const CALENDAR_CELL_STYLE: Record<CalendarKind, { bg: string; text: string; short: string }> = {
  closed_all:                { bg: '#e0e0e0', text: '#4a4a46', short: '休館' },
  work_on_closed:            { bg: '#fff3cd', text: '#7a4a06', short: '出勤' },
  work_on_closed_encouraged: { bg: '#d4edda', text: '#1b5e34', short: '有休' },
};

/** 申請フォームで出す注意書きの文言。「止めない。気づかせる」ためのもの */
export const CALENDAR_NOTICE: Record<CalendarKind, string> = {
  closed_all: 'この日は全社員休みです',
  work_on_closed: 'この日は休館日（社員出勤日）です',
  work_on_closed_encouraged: 'この日は休館日（社員出勤日・有休奨励日）です',
};
