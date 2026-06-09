import React, { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import type { AuthUser } from '../types';

interface Props {
  user?: AuthUser;
  roleTitle?: string;
  isAdmin?: boolean;
}

interface LeaveEvent {
  id: string;
  user_id: string;
  name: string;
  leave_type: string;
  leave_type_other: string | null;
  dates: string[];
  status: string;
}

const LEAVE_TYPE_COLOR: Record<string, { bg: string; text: string }> = {
  '有給休暇':             { bg: '#d5f5e3', text: '#1e8449' },
  'バースデー休暇（有給）': { bg: '#d5f5e3', text: '#1e8449' },
  '調整休':              { bg: '#f4ecf7', text: '#7d3c98' },
  '慶弔休暇':            { bg: '#fdedec', text: '#c0392b' },
  'その他':              { bg: '#e8f4fd', text: '#1a5276' },
};
const PENDING_COLOR = { bg: '#fef9e7', text: '#b7770d', border: '#f39c12' };

const LEAVE_TYPE_SHORT: Record<string, string> = {
  '有給休暇':             '有給',
  'バースデー休暇（有給）': 'BD休暇',
  '慶弔休暇':            '慶弔休',
  '調整休':              '調整休',
  'その他':              'その他',
};

const STATUS_LABEL: Record<string, string> = {
  pending:          '申請中',
  step2_pending:    '申請中',
  manager_approved: '受理',
  admin_approved:   '受理',
  approved:         '受理',
};

function getEventColor(ev: LeaveEvent) {
  if (ev.status === 'pending' || ev.status === 'step2_pending') return PENDING_COLOR;
  return LEAVE_TYPE_COLOR[ev.leave_type] || LEAVE_TYPE_COLOR['その他'];
}

function fmt(y: number, m: number, d: number) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function shortType(ev: LeaveEvent) {
  if (ev.leave_type === 'その他') return ev.leave_type_other || 'その他';
  return LEAVE_TYPE_SHORT[ev.leave_type] || ev.leave_type;
}

const WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'];
function dow(dateStr: string) {
  return WEEKDAYS[(new Date(dateStr).getDay() + 6) % 7];
}

// ===== PC用カレンダー =====
const PcCalendar: React.FC<{
  year: number; month: number;
  eventsByDate: Record<string, LeaveEvent[]>;
  isDark: boolean;
}> = ({ year, month, eventsByDate, isDark }) => {
  const bg = isDark ? '#343a40' : '#fff';
  const border = isDark ? '#495057' : '#f0f0f0';
  const textColor = isDark ? '#fff' : '#333';
  const subColor = isDark ? '#adb5bd' : '#888';

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
  const cells: { date: string | null; day: number | null; dow: number }[] = [];
  for (let i = 0; i < firstDow; i++) cells.push({ date: null, day: null, dow: i });
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: fmt(year, month, d), day: d, dow: (firstDow + d - 1) % 7 });
  }
  while (cells.length % 7 !== 0) cells.push({ date: null, day: null, dow: cells.length % 7 });

  const today = new Date();
  const todayStr = fmt(today.getFullYear(), today.getMonth(), today.getDate());
  const rows: typeof cells[] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
      <thead>
        <tr>
          {WEEKDAYS.map((w, i) => (
            <th key={w} style={{
              padding: '6px 0', fontSize: 12,
              color: i === 5 ? '#4a90d9' : i === 6 ? '#e74c3c' : subColor,
              borderBottom: `2px solid ${border}`, fontWeight: 'normal',
            }}>{w}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri}>
            {row.map((cell, ci) => {
              const isSat = ci === 5, isSun = ci === 6;
              const isToday = cell.date === todayStr;
              const events = cell.date ? (eventsByDate[cell.date] || []) : [];
              return (
                <td key={ci} style={{
                  border: `1px solid ${border}`, verticalAlign: 'top',
                  minHeight: 80, padding: 4,
                  background: cell.date ? bg : isDark ? '#2a2f35' : '#fafafa',
                }}>
                  {cell.day !== null && (
                    <>
                      <div style={{ marginBottom: 2 }}>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: 22, height: 22, borderRadius: '50%', fontSize: 12, fontWeight: 'bold',
                          background: isToday ? '#4a90d9' : 'transparent',
                          color: isToday ? '#fff' : isSat ? '#4a90d9' : isSun ? '#e74c3c' : textColor,
                        }}>{cell.day}</span>
                      </div>
                      {events.map(ev => {
                        const c = getEventColor(ev);
                        const isPending = ev.status === 'pending' || ev.status === 'step2_pending';
                        return (
                          <div key={ev.id + cell.date}
                            title={`${ev.name}｜${shortType(ev)}｜${STATUS_LABEL[ev.status] || ev.status}`}
                            style={{
                              fontSize: 11, borderRadius: 4, padding: '2px 4px', marginBottom: 2,
                              background: c.bg, color: c.text,
                              border: isPending ? `1px dashed ${'border' in c ? c.border : c.text}` : 'none',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                            {ev.name}
                          </div>
                        );
                      })}
                    </>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

// ===== スマホ用カレンダー =====
const SpCalendar: React.FC<{
  year: number; month: number;
  eventsByDate: Record<string, LeaveEvent[]>;
  isDark: boolean;
}> = ({ year, month, eventsByDate, isDark }) => {
  const today = new Date();
  const todayStr = fmt(today.getFullYear(), today.getMonth(), today.getDate());
  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const dateRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const bg = isDark ? '#343a40' : '#fff';
  const textColor = isDark ? '#fff' : '#333';
  const subColor = isDark ? '#adb5bd' : '#888';
  const sectionBg = isDark ? '#2a2f35' : '#f8f9ff';
  const border = isDark ? '#495057' : '#e0e7ff';

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
  const cells: { date: string | null; day: number | null; dow: number }[] = [];
  for (let i = 0; i < firstDow; i++) cells.push({ date: null, day: null, dow: i });
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: fmt(year, month, d), day: d, dow: (firstDow + d - 1) % 7 });
  }
  while (cells.length % 7 !== 0) cells.push({ date: null, day: null, dow: cells.length % 7 });
  const rows: typeof cells[] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));

  const daysWithEvents = Object.keys(eventsByDate)
    .filter(d => d.startsWith(`${year}-${String(month + 1).padStart(2, '0')}-`))
    .sort();

  const handleSelectDate = (date: string) => {
    setSelectedDate(date);
    setTimeout(() => {
      const el = dateRefs.current[date];
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  return (
    <div>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
        <thead>
          <tr>
            {WEEKDAYS.map((w, i) => (
              <th key={w} style={{
                textAlign: 'center', fontSize: 11, padding: '4px 0',
                color: i === 5 ? '#4a90d9' : i === 6 ? '#e74c3c' : subColor,
                fontWeight: 'normal',
              }}>{w}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => {
                const isSat = ci === 5, isSun = ci === 6;
                const isToday = cell.date === todayStr;
                const isSelected = cell.date === selectedDate;
                const events = cell.date ? (eventsByDate[cell.date] || []) : [];
                const hasPending = events.some(e => e.status === 'pending' || e.status === 'step2_pending');
                return (
                  <td key={ci} style={{ textAlign: 'center', padding: '3px 1px', cursor: cell.date ? 'pointer' : 'default' }}
                    onClick={() => cell.date && handleSelectDate(cell.date)}>
                    <div style={{
                      display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
                      width: 30, borderRadius: 6,
                      background: isSelected ? '#4a90d9' : isToday ? (isDark ? '#2c3e50' : '#e8f4fd') : 'transparent',
                      padding: '2px 0',
                    }}>
                      <span style={{
                        fontSize: 13, fontWeight: isToday ? 'bold' : 'normal',
                        color: isSelected ? '#fff' : isSat ? '#4a90d9' : isSun ? '#e74c3c' : cell.day ? textColor : (isDark ? '#555' : '#ccc'),
                      }}>{cell.day ?? ''}</span>
                      {events.length > 0 && (
                        <div style={{
                          width: 6, height: 6, borderRadius: '50%', marginTop: 1,
                          background: isSelected ? '#fff' : hasPending ? '#f39c12' : '#27ae60',
                        }} />
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {daysWithEvents.length === 0 ? (
        <div style={{ textAlign: 'center', color: subColor, fontSize: 13, padding: '24px 0' }}>
          この月の休暇申請はありません
        </div>
      ) : (
        daysWithEvents.map(dateStr => {
          const d = parseInt(dateStr.split('-')[2]);
          const isSelected = dateStr === selectedDate;
          const events = eventsByDate[dateStr] || [];
          return (
            <div key={dateStr} ref={el => { dateRefs.current[dateStr] = el; }} style={{ marginBottom: 12 }}>
              <div style={{
                fontSize: 13, fontWeight: 'bold', padding: '6px 10px',
                background: isSelected ? '#4a90d9' : sectionBg,
                color: isSelected ? '#fff' : textColor,
                borderRadius: 8, marginBottom: 6,
                borderLeft: isSelected ? 'none' : `3px solid ${border}`,
              }}>
                {month + 1}月{d}日（{dow(dateStr)}）
              </div>
              {events.map(ev => {
                const c = getEventColor(ev);
                const isPending = ev.status === 'pending' || ev.status === 'step2_pending';
                return (
                  <div key={ev.id} style={{
                    background: bg, borderRadius: 8, padding: '10px 12px', marginBottom: 6,
                    borderLeft: `4px solid ${c.text}`,
                    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 'bold', color: textColor }}>{ev.name}</div>
                      <div style={{ fontSize: 12, color: subColor, marginTop: 2 }}>{shortType(ev)}</div>
                    </div>
                    <div style={{
                      fontSize: 11, padding: '3px 8px', borderRadius: 10,
                      background: isPending ? '#fef9e7' : '#d5f5e3',
                      color: isPending ? '#b7770d' : '#1e8449',
                      whiteSpace: 'nowrap',
                      border: isPending ? '1px dashed #f39c12' : 'none',
                    }}>
                      {STATUS_LABEL[ev.status] || ev.status}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })
      )}
    </div>
  );
};

// ===== メインコンポーネント =====
const CalendarPage: React.FC<Props> = ({ roleTitle, isAdmin }) => {
  const isDark = useDarkMode();
  const bg = isDark ? '#343a40' : '#fff';
  const textColor = isDark ? '#fff' : '#333';
  const subColor = isDark ? '#adb5bd' : '#888';
  const borderColor = isDark ? '#495057' : '#eee';

  const defaultGroup = (isAdmin || roleTitle === '社長') ? 'all' : 'mine';
  const CALENDAR_GROUPS = ['こども', '大人', '管理部'];

  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [groupMode, setGroupMode] = useState<string>(defaultGroup);
  const [events, setEvents] = useState<LeaveEvent[]>([]);
  const [loading, setLoading] = useState(false);

  // 直近6ヶ月の日数サマリー
  const [monthSummary, setMonthSummary] = useState<{ year: number; month: number; days: number }[]>([]);

  const [isMobile, setIsMobile] = useState(window.innerWidth < 600);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 600);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // グループ対象ユーザーIDを取得する共通関数
  const getTargetUserIds = useCallback(async (allUserIds: string[]): Promise<string[]> => {
    if (groupMode === 'all') return allUserIds;
    const { data: groupProfiles } = await supabase
      .from('profiles').select('id')
      .overlaps('group_names', [groupMode])
      .in('id', allUserIds);
    const ids = new Set((groupProfiles || []).map((p: { id: string }) => p.id));
    return allUserIds.filter(id => ids.has(id));
  }, [groupMode]);

  // 直近6ヶ月のサマリー取得
  const fetchSummary = useCallback(async () => {
    const months: { year: number; month: number; days: number }[] = [];
    const startM = new Date(today.getFullYear(), today.getMonth(), 1);
    const endM = new Date(today.getFullYear(), today.getMonth() + 5, 1);
    const rangeStart = `${startM.getFullYear()}-${String(startM.getMonth() + 1).padStart(2, '0')}-01`;
    const endDate = new Date(endM.getFullYear(), endM.getMonth() + 1, 0);
    const rangeEnd = `${endM.getFullYear()}-${String(endM.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;

    const { data: leaves } = await supabase
      .from('leave_requests')
      .select('user_id, leave_dates, start_date, end_date, status')
      .not('status', 'in', '("rejected")')
      .or(`and(start_date.lte.${rangeEnd},end_date.gte.${rangeStart})`);

    if (!leaves) {
      for (let i = 0; i < 6; i++) {
        const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
        months.push({ year: d.getFullYear(), month: d.getMonth(), days: 0 });
      }
      setMonthSummary(months);
      return;
    }

    const allUserIds = [...new Set(leaves.map((l: { user_id: string }) => l.user_id))] as string[];
    const targetIds = new Set(await getTargetUserIds(allUserIds));

    for (let i = 0; i < 6; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
      const y = d.getFullYear(), m = d.getMonth();
      const mStart = `${y}-${String(m + 1).padStart(2, '0')}-01`;
      const mEndDate = new Date(y, m + 1, 0);
      const mEnd = `${y}-${String(m + 1).padStart(2, '0')}-${String(mEndDate.getDate()).padStart(2, '0')}`;

      let dayCount = 0;
      for (const l of leaves) {
        if (!targetIds.has(l.user_id)) continue;
        let dates: string[] = [];
        try { if (l.leave_dates) dates = JSON.parse(l.leave_dates); } catch {}
        if (dates.length === 0 && l.start_date) {
          const s = new Date(l.start_date), e = new Date(l.end_date || l.start_date);
          for (const dd = new Date(s); dd <= e; dd.setDate(dd.getDate() + 1)) {
            dates.push(dd.toISOString().split('T')[0]);
          }
        }
        dayCount += dates.filter(dt => dt >= mStart && dt <= mEnd).length;
      }
      months.push({ year: y, month: m, days: dayCount });
    }
    setMonthSummary(months);
  }, [groupMode, getTargetUserIds]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  // 当月イベント取得
  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const startStr = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      const endDate = new Date(year, month + 1, 0);
      const endStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;

      const { data: leaves } = await supabase
        .from('leave_requests')
        .select('id, user_id, leave_type, leave_type_other, leave_dates, start_date, end_date, status')
        .not('status', 'in', '("rejected")')
        .or(`and(start_date.lte.${endStr},end_date.gte.${startStr})`);

      if (!leaves || leaves.length === 0) { setEvents([]); return; }

      let userIds = [...new Set(leaves.map((l: { user_id: string }) => l.user_id))] as string[];
      userIds = await getTargetUserIds(userIds);

      const { data: profiles } = await supabase
        .from('profiles').select('id, name').in('id', userIds);
      const profileMap: Record<string, string> = {};
      (profiles || []).forEach((p: { id: string; name: string }) => { profileMap[p.id] = p.name; });

      const result: LeaveEvent[] = [];
      for (const l of leaves) {
        if (!userIds.includes(l.user_id)) continue;
        const name = profileMap[l.user_id] || '不明';
        let dates: string[] = [];
        try { if (l.leave_dates) dates = JSON.parse(l.leave_dates); } catch {}
        if (dates.length === 0 && l.start_date) {
          const s = new Date(l.start_date), e = new Date(l.end_date || l.start_date);
          for (const d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
            dates.push(d.toISOString().split('T')[0]);
          }
        }
        dates = dates.filter(d => d >= startStr && d <= endStr);
        if (dates.length > 0) {
          result.push({ id: l.id, user_id: l.user_id, name, leave_type: l.leave_type, leave_type_other: l.leave_type_other, dates, status: l.status });
        }
      }
      setEvents(result);
    } finally {
      setLoading(false);
    }
  }, [year, month, groupMode, getTargetUserIds]);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);

  const eventsByDate: Record<string, LeaveEvent[]> = {};
  for (const ev of events) {
    for (const d of ev.dates) {
      if (!eventsByDate[d]) eventsByDate[d] = [];
      eventsByDate[d].push(ev);
    }
  }

  // 月リスト（日付ごとに1行）
  const monthListRows: { date: string; ev: LeaveEvent }[] = [];
  const sortedDates = Object.keys(eventsByDate).sort();
  for (const date of sortedDates) {
    for (const ev of eventsByDate[date]) {
      monthListRows.push({ date, ev });
    }
  }

  const prevMonth = () => { if (month === 0) { setYear(y => y - 1); setMonth(11); } else setMonth(m => m - 1); };
  const nextMonth = () => { if (month === 11) { setYear(y => y + 1); setMonth(0); } else setMonth(m => m + 1); };

  const btnStyle = { background: isDark ? '#495057' : '#f0f4ff', border: 'none', borderRadius: 8, width: 32, height: 32, fontSize: 16, cursor: 'pointer', color: '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, padding: 0 } as const;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>

      {/* ===== 直近6ヶ月サマリー ===== */}
      <div style={{ background: bg, borderRadius: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.08)', padding: isMobile ? 14 : 20, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 'bold', color: subColor, marginBottom: 12 }}>直近6ヶ月の休暇日数</div>
        <div style={{ display: 'flex', gap: isMobile ? 6 : 12, flexWrap: 'wrap' }}>
          {monthSummary.map(({ year: y, month: m, days }) => {
            const isCurrentView = y === year && m === month;
            return (
              <button
                key={`${y}-${m}`}
                onClick={() => { setYear(y); setMonth(m); }}
                style={{
                  flex: 1, minWidth: isMobile ? 44 : 70,
                  padding: isMobile ? '8px 4px' : '10px 8px',
                  borderRadius: 10, border: isCurrentView ? '2px solid #4a90d9' : `1px solid ${borderColor}`,
                  background: isCurrentView ? (isDark ? '#1a3a5c' : '#e8f4fd') : (isDark ? '#2a2f35' : '#f8f9ff'),
                  cursor: 'pointer', textAlign: 'center',
                }}
              >
                <div style={{ fontSize: isMobile ? 11 : 12, color: subColor, marginBottom: 4 }}>{m + 1}月</div>
                <div style={{ fontSize: isMobile ? 18 : 22, fontWeight: 'bold', color: isCurrentView ? '#4a90d9' : textColor }}>{days}</div>
                <div style={{ fontSize: 10, color: subColor }}>日</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ===== カレンダー ===== */}
      <div style={{ background: bg, borderRadius: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.08)', padding: isMobile ? 16 : 20, marginBottom: 16 }}>
        {/* ヘッダー */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={prevMonth} style={btnStyle}>‹</button>
            <span style={{ fontSize: isMobile ? 15 : 18, fontWeight: 'bold', color: textColor, minWidth: 110, textAlign: 'center' }}>{year}年 {month + 1}月</span>
            <button onClick={nextMonth} style={btnStyle}>›</button>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {loading && <span style={{ fontSize: 12, color: subColor }}>読み込み中...</span>}
            <select
              value={groupMode}
              onChange={e => setGroupMode(e.target.value)}
              style={{ padding: '6px 10px', border: `2px solid #4a90d9`, borderRadius: 8, fontSize: 13, color: '#4a90d9', background: isDark ? '#495057' : '#f0f4ff', cursor: 'pointer' }}
            >
              <option value="all">全チーム</option>
              {CALENDAR_GROUPS.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
        </div>

        {/* 凡例 */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16, fontSize: 12, color: subColor }}>
          {[
            { label: '有給（受理）', bg: '#d5f5e3', border: undefined },
            { label: '調整休（受理）', bg: '#f4ecf7', border: undefined },
            { label: '慶弔・その他', bg: '#fdedec', border: undefined },
            { label: '申請中', bg: '#fef9e7', border: '#f39c12' },
          ].map(({ label, bg: cbg, border }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 12, height: 12, borderRadius: 3, background: cbg, border: border ? `1px dashed ${border}` : 'none' }} />
              {label}
            </div>
          ))}
        </div>

        {/* カレンダー本体 */}
        {isMobile ? (
          <SpCalendar year={year} month={month} eventsByDate={eventsByDate} isDark={isDark} />
        ) : (
          <PcCalendar year={year} month={month} eventsByDate={eventsByDate} isDark={isDark} />
        )}
      </div>

      {/* ===== 月別リスト ===== */}
      <div style={{ background: bg, borderRadius: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.08)', padding: isMobile ? 14 : 20 }}>
        <div style={{ fontSize: 14, fontWeight: 'bold', color: textColor, marginBottom: 12 }}>
          {year}年 {month + 1}月 の休暇一覧
        </div>
        {monthListRows.length === 0 ? (
          <div style={{ textAlign: 'center', color: subColor, fontSize: 13, padding: '16px 0' }}>
            この月の休暇申請はありません
          </div>
        ) : (
          <div>
            {/* ヘッダー行 */}
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '80px 1fr 60px 50px' : '100px 1fr 80px 60px', gap: 8, padding: '6px 8px', fontSize: 11, color: subColor, borderBottom: `1px solid ${borderColor}`, marginBottom: 4 }}>
              <span>日付</span><span>名前</span><span>種別</span><span style={{ textAlign: 'right' }}>状態</span>
            </div>
            {monthListRows.map(({ date, ev }, i) => {
              const d = parseInt(date.split('-')[2]);
              const isPending = ev.status === 'pending' || ev.status === 'step2_pending';
              const c = getEventColor(ev);
              return (
                <div key={`${ev.id}-${date}-${i}`} style={{
                  display: 'grid',
                  gridTemplateColumns: isMobile ? '80px 1fr 60px 50px' : '100px 1fr 80px 60px',
                  gap: 8, padding: '7px 8px', fontSize: isMobile ? 13 : 14,
                  borderBottom: `1px solid ${borderColor}`,
                  alignItems: 'center',
                }}>
                  <span style={{ color: subColor, fontSize: isMobile ? 12 : 13 }}>
                    {month + 1}/{d}（{dow(date)}）
                  </span>
                  <span style={{ fontWeight: 'bold', color: textColor }}>{ev.name}</span>
                  <span style={{
                    fontSize: 11, padding: '2px 6px', borderRadius: 4,
                    background: c.bg, color: c.text,
                    border: isPending ? `1px dashed ${'border' in c ? c.border : c.text}` : 'none',
                    textAlign: 'center',
                  }}>{shortType(ev)}</span>
                  <span style={{
                    fontSize: 11, textAlign: 'right',
                    color: isPending ? '#b7770d' : '#1e8449', fontWeight: 'bold',
                  }}>
                    {STATUS_LABEL[ev.status] || ev.status}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
};

export default CalendarPage;
