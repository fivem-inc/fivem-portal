import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { errorStyle, scrollToFirstError, ERROR_BORDER, errorBg } from '../lib/formHighlight';
import { useDarkMode } from '../hooks/useDarkMode';
import { DRAFT_KEYS, loadDraft, saveDraft, clearDraft } from '../lib/draftStorage';
import {
  absenceLabel, absenceColor, absenceEmoji, formatSegments, joinSegmentLocations, parseSegments, hhmm,
  type AttendanceType, type WorkSegment,
} from '../lib/attendanceTypes';
import { useCompanyCalendar, CALENDAR_CELL_STYLE } from '../hooks/useCompanyCalendar';
import type { CalendarKind } from '../lib/breakCalc';
import type { AuthUser } from '../types';
import HelpLinkButton from '../components/HelpLinkButton';

// 校の選択肢の末尾に出す「その他（自由入力）」。選ぶと自由入力欄が出る（残業・出張報告と同じ扱い）
const OTHER_LOCATION = 'その他';

// 勤怠入力シートの下書き（開いていた日付ごと・シート再表示で復元）
// ※ 項目を追加したら、読み出し側は必ず `??` で既定値を入れること。
//    リリース前に保存された古い下書きが復元されると undefined になり画面が落ちるため。
interface AbsenceDraft {
  // targetDates … この入力を登録する日（全種別で複数日を選べる）。
  // absentDates は「全欠勤だけ複数日だった」頃の古い下書き用。読み出し時に targetDates へ寄せる
  // userIds … 対象者（複数選べる）。userId は1人しか選べなかった頃の古い下書き用
  date: string; userIds: string[]; userId?: string; isAbsent: boolean; targetDates: string[]; absentDates?: string[];
  isLate: boolean; isLateStart: boolean; isEarlyLeave: boolean; isEarlyEnd: boolean;
  lateTime: string; earlyTime: string; notes: string;
  locations: Record<string, string>;
  locationCustoms?: Record<string, string>;
  isHolidayWork?: boolean;
  segments?: WorkSegment[];
  segmentCustoms?: string[];
  hasLocationMove?: boolean;
  isLocationChange?: boolean;
  originalLocation?: string;
  originalLocationCustom?: string;
  isTimeChange?: boolean;
}

/**
 * 登録済みの勤怠を入力シートの下書きに戻す（「取消してこの内容を利用して入力する」用）。
 * 校は保存時に「その他」が実際の校名へ解決されているので、登録リストに無い値は
 * 「その他（自由入力）」＋自由入力欄に振り分ける（交通費の toDraft と同じ考え方）。
 */
const absenceToDraft = (ab: AbsenceEvent, workplaces: string[]): AbsenceDraft => {
  // 校名 → [selectの値, 自由入力の値]
  const splitLoc = (loc: string | null): [string, string] => {
    const v = (loc ?? '').trim();
    if (!v) return ['', ''];
    return workplaces.includes(v) ? [v, ''] : [OTHER_LOCATION, v];
  };
  const [locSel, locCustom] = splitLoc(ab.location);
  const [origSel, origCustom] = splitLoc(ab.original_location);
  const segs = ab.work_segments;
  const segSplit = segs.map(s => splitLoc(s.location));
  const time = ab.actual_time ? ab.actual_time.slice(0, 5) : '';
  const isLateType = ab.type === 'late' || ab.type === 'late_start';
  const isEarlyType = ab.type === 'early_leave' || ab.type === 'early_end';

  return {
    date: ab.date,
    userIds: [ab.user_id],
    isAbsent: ab.type === 'absent',
    targetDates: [ab.date],
    isLate: ab.type === 'late',
    isLateStart: ab.type === 'late_start',
    isEarlyLeave: ab.type === 'early_leave',
    isEarlyEnd: ab.type === 'early_end',
    lateTime: isLateType ? time : '',
    earlyTime: isEarlyType ? time : '',
    notes: ab.notes ?? '',
    // 時間帯を持つ種別は「校（必須）」欄を使わないので、日付ごとの校は入れない
    locations: segs.length > 0 ? {} : (locSel ? { [ab.date]: locSel } : {}),
    locationCustoms: segs.length > 0 ? {} : (locCustom ? { [ab.date]: locCustom } : {}),
    isHolidayWork: ab.type === 'holiday_work',
    isLocationChange: ab.type === 'location_change',
    isTimeChange: ab.type === 'time_change',
    // <input type="time"> は 'HH:MM'（先頭0あり）でないと値が入らないので hhmm() は通さない
    segments: segs.length > 0
      ? segs.map((s, i) => ({ start: (s.start ?? '').slice(0, 5), end: (s.end ?? '').slice(0, 5), location: segSplit[i][0] }))
      : [{ start: '', end: '', location: '' }],
    segmentCustoms: segs.length > 0 ? segSplit.map(p => p[1]) : [''],
    // 遅刻・早退で時間帯がある＝「途中で別の校に移動する」を使って登録したもの
    hasLocationMove: segs.length > 0 && (isLateType || isEarlyType),
    originalLocation: origSel,
    originalLocationCustom: origCustom,
  };
};

const CalendarResultModal: React.FC<{ type: 'save' | 'delete'; onClose: () => void }> = ({ type, onClose }) => {
  useEffect(() => { const t = setTimeout(onClose, 3000); return () => clearTimeout(t); }, [onClose]);
  const isSave = type === 'save';
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: isSave ? '#f0fdf4' : '#fff5f5', border: `1.5px solid ${isSave ? '#b7e4cc' : '#f5b8bb'}`, borderRadius: 18, padding: '28px 24px', width: '100%', maxWidth: 300, textAlign: 'center', position: 'relative' }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 10, right: 10, background: isSave ? 'rgba(21,87,36,0.1)' : 'rgba(114,28,36,0.1)', border: 'none', color: isSave ? '#155724' : '#721c24', borderRadius: '50%', width: 26, height: 26, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: isSave ? '#d4edda' : '#f8d7da', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
          <span style={{ fontSize: 28, color: isSave ? '#28a745' : '#dc3545' }}>{isSave ? '✓' : '🚫'}</span>
        </div>
        <div style={{ fontSize: 16, fontWeight: 500, color: isSave ? '#155724' : '#721c24' }}>{isSave ? '登録しました' : '削除しました'}</div>
        <div style={{ fontSize: 11, color: isSave ? '#3a7d52' : '#a03030', marginTop: 6, opacity: .7 }}>✕ または画面タップで閉じる</div>
      </div>
    </div>
  );
};

interface Props {
  user?: AuthUser;
  roleTitle?: string;
  isAdmin?: boolean;
  isApprover?: boolean;
}

interface LeaveEvent {
  id: string;
  user_id: string;
  name: string;
  leave_type: string;
  leave_type_other: string | null;
  dates: string[];
  status: string;
  locations?: Record<string, string>; // 日付→校（leave_locations列。無い申請はundefined）
  purpose?: string | null; // 事由（一覧の理由表示は調整休のみ使用。他の休暇はプライバシー配慮で出さない）
  reason?: string | null;  // 備考（調整休の種類「振替休日／時間外調整休」の判定に使用）
}

interface AbsenceEvent {
  id: string;
  user_id: string;
  name: string;
  date: string;
  type: AttendanceType;
  actual_time: string | null;
  notes: string | null;
  location: string | null; // 校（過去データはnull）。移動がある場合は '四条本校→洛西口校'
  work_segments: WorkSegment[]; // 勤務時間帯。単一勤務・全欠勤・過去データは空配列
  original_location: string | null; // 勤務地変更の「変更前の校」
}

const LEAVE_TYPE_COLOR: Record<string, { bg: string; text: string }> = {
  '有給休暇':              { bg: '#d5f5e3', text: '#1e8449' },
  'バースデー休暇（有給）': { bg: '#d5f5e3', text: '#1e8449' },
  '調整休':               { bg: '#f4ecf7', text: '#7d3c98' },
  '慶弔休暇':             { bg: '#fdedec', text: '#c0392b' },
  'その他':               { bg: '#e8f4fd', text: '#1a5276' },
};
const PENDING_COLOR = { bg: '#fef9e7', text: '#b7770d', border: '#f39c12' };

const LEAVE_TYPE_SHORT: Record<string, string> = {
  '有給休暇':              '有給',
  'バースデー休暇（有給）': 'BD休暇',
  '慶弔休暇':             '慶弔休',
  '調整休':               '調整休',
  'その他':               'その他',
};

// 種別のラベル・配色は lib/attendanceTypes.ts に集約（管理画面と共用。片方だけ足すと画面が落ちるため）

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

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']; // 日曜始まり
function dow(dateStr: string) {
  return WEEKDAYS[new Date(dateStr).getDay()];
}

interface ProfileEntry {
  id: string;
  name: string;
  role_title: string;
  employment_type: string;
  group_names: string[];
}

const ROLE_ORDER = ['社長', '三役', 'マネージャー', 'リーダー'];
const PRIMARY_GROUPS = ['こども', '大人', '管理部'];
function primaryGroup(p: ProfileEntry): string {
  for (const g of PRIMARY_GROUPS) {
    if (p.group_names.includes(g)) return g;
  }
  return '管理部';
}

function employmentCategory(p: ProfileEntry): string {
  const et = p.employment_type || '';
  if (et.includes('正社員') || et.includes('契約社員')) return '社員';
  return 'パート';
}

function roleOrder(roleTitle: string): number {
  const idx = ROLE_ORDER.indexOf(roleTitle);
  return idx === -1 ? ROLE_ORDER.length : idx;
}

function buildProfileGroups(profiles: ProfileEntry[]) {
  const cats: Record<string, Record<string, ProfileEntry[]>> = {
    '社員': {}, 'パート': {},
  };
  for (const p of profiles) {
    const cat = employmentCategory(p);
    const grp = primaryGroup(p);
    if (!cats[cat][grp]) cats[cat][grp] = [];
    cats[cat][grp].push(p);
  }
  for (const cat of Object.values(cats)) {
    for (const grp of Object.values(cat)) {
      grp.sort((a, b) => roleOrder(a.role_title) - roleOrder(b.role_title) || a.name.localeCompare(b.name, 'ja'));
    }
  }
  return cats;
}

// ===== 対象者ボタン+縦リスト選択 =====
const StaffPicker: React.FC<{
  profiles: ProfileEntry[];
  grouped: Record<string, Record<string, ProfileEntry[]>>;
  // 複数選択。同じ校・同じ時間の人をまとめて登録できるようにするため
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onClear: () => void;
}> = ({ profiles, grouped, selectedIds, onToggle, onClear }) => {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const selectedProfiles = profiles.filter(p => selectedIds.has(p.id));
  const ACCENT = '#4a90d9';

  const activeMembers = activeKey
    ? (() => {
        const idx = activeKey.indexOf('|');
        const cat = activeKey.slice(0, idx);
        const grp = activeKey.slice(idx + 1);
        return grouped[cat]?.[grp] || [];
      })()
    : [];

  return (
    <div>
      {/* 選択済み表示（複数） */}
      {selectedProfiles.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '8px 10px', background: '#eaf4ff', border: `2px solid ${ACCENT}`, borderRadius: 8, marginBottom: 10 }}>
          {selectedProfiles.map(p => (
            <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: '#fff', border: `1px solid ${ACCENT}`, color: '#1a5fa8', borderRadius: 14, padding: '3px 9px', fontSize: 13, fontWeight: 'bold' }}>
              {p.name}
              <button type="button" onClick={() => onToggle(p.id)} title="この人を外す"
                style={{ background: 'none', border: 'none', color: '#1a5fa8', fontSize: 12, cursor: 'pointer', padding: 0, lineHeight: 1 }}>✕</button>
            </span>
          ))}
          {selectedProfiles.length > 1 && (
            <button type="button" onClick={() => { onClear(); setActiveKey(null); }}
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#6b7c8c', fontSize: 11.5, cursor: 'pointer' }}>すべて外す</button>
          )}
        </div>
      )}

      {/* 社員 / パート ボタン行（常に全表示） */}
      {(['社員', 'パート'] as const).map(cat => {
        const grps = PRIMARY_GROUPS.filter(g => grouped[cat]?.[g]?.length).concat(
          Object.keys(grouped[cat] || {}).filter(g => !PRIMARY_GROUPS.includes(g) && grouped[cat][g]?.length)
        );
        if (grps.length === 0) return null;
        return (
          <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 'bold', color: '#555', minWidth: 40, flexShrink: 0 }}>{cat}</span>
            {grps.map(grp => {
              const key = `${cat}|${grp}`;
              const isActive = activeKey === key;
              return (
                <button key={key} onClick={() => setActiveKey(prev => prev === key ? null : key)}
                  style={{ padding: '8px 16px', borderRadius: 8, fontSize: 14, cursor: 'pointer', fontWeight: 'bold', border: `2px solid ${isActive ? ACCENT : '#d0d0d0'}`, background: isActive ? ACCENT : '#f5f5f5', color: isActive ? '#fff' : '#444' }}>
                  {grp}
                </button>
              );
            })}
          </div>
        );
      })}

      {/* 名前リスト（グループの下に展開）。複数選べるよう、選んでも閉じない */}
      {activeKey && (
        <div style={{ marginTop: 4, border: '1px solid #d0d0d0', borderRadius: 8, overflow: 'hidden' }}>
          {activeMembers.map((p, i) => {
            const on = selectedIds.has(p.id);
            return (
              <div key={p.id} onClick={() => onToggle(p.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 14, background: on ? ACCENT : i % 2 === 0 ? '#fff' : '#fafafa', color: on ? '#fff' : '#222', fontWeight: on ? 'bold' : 'normal', borderBottom: '1px solid #ececec' }}>
                <span style={{ width: 14, flexShrink: 0 }}>{on ? '✓' : ''}</span>
                {p.name}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ===== 全欠勤用ミニカレンダー =====
const MultiDatePicker: React.FC<{
  selectedDates: Set<string>;
  onToggle: (date: string) => void;
}> = ({ selectedDates, onToggle }) => {
  // 開いた日付の月を最初に表示する（今日の月にすると、翌月の日をタップしたときに前月が開いてしまう）
  const firstSelected = [...selectedDates].sort()[0];
  const base = firstSelected ? new Date(firstSelected + 'T00:00:00') : new Date();
  const [calYear, setCalYear] = useState(base.getFullYear());
  const [calMonth, setCalMonth] = useState(base.getMonth());

  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const firstDow = new Date(calYear, calMonth, 1).getDay(); // 日曜=0始まり
  const cells: (string | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(fmt(calYear, calMonth, d));
  while (cells.length % 7 !== 0) cells.push(null);

  const rows: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));

  const prevM = () => { if (calMonth === 0) { setCalYear(y => y - 1); setCalMonth(11); } else setCalMonth(m => m - 1); };
  const nextM = () => { if (calMonth === 11) { setCalYear(y => y + 1); setCalMonth(0); } else setCalMonth(m => m + 1); };

  return (
    <div style={{ border: '1px solid #e0e0e0', borderRadius: 10, overflow: 'hidden', marginBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: '#f8f9fa' }}>
        <button onClick={prevM} style={{ background: 'none', border: 'none', fontSize: 16, cursor: 'pointer', color: '#555' }}>‹</button>
        <span style={{ fontSize: 13, fontWeight: 'bold', color: '#333' }}>{calYear}年 {calMonth + 1}月</span>
        <button onClick={nextM} style={{ background: 'none', border: 'none', fontSize: 16, cursor: 'pointer', color: '#555' }}>›</button>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {WEEKDAYS.map((w, i) => (
              <th key={w} style={{ fontSize: 11, padding: '4px 0', color: i === 0 ? '#e74c3c' : i === 6 ? '#4a90d9' : '#888', fontWeight: 'normal', textAlign: 'center' }}>{w}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((date, ci) => {
                const selected = date ? selectedDates.has(date) : false;
                const isSun = ci === 0, isSat = ci === 6;
                const day = date ? parseInt(date.slice(8)) : null;
                return (
                  <td key={ci} onClick={() => date && onToggle(date)}
                    style={{ textAlign: 'center', padding: '3px 1px', cursor: date ? 'pointer' : 'default' }}>
                    {day !== null && (
                      <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: '50%', background: selected ? '#dc3545' : 'transparent', color: selected ? '#fff' : isSat ? '#4a90d9' : isSun ? '#e74c3c' : '#333', fontSize: 13, fontWeight: selected ? 'bold' : 'normal' }}>
                        {day}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {/* 選択中の日付一覧は「校（必須）」の日付ごとの選択リストが兼ねるため、ここには出さない */}
    </div>
  );
};

/**
 * 同じ日に同居できない種別かを判定する（DBのトリガー enforce_attendance_exclusive と同じルール）。
 * まとめて登録するとき、すでに登録がある日を送信前に知らせるために使う。
 * ※ ルールを変えるときは supabase/migrations/20260737000000_add_time_change_to_attendance.sql の
 *    関数も必ず一緒に直す。画面とDBで判定がズレると「送信できたのに保存できない」事故になる。
 */
const conflictsWithExisting = (newType: string, existingType: string): boolean => {
  if (newType === existingType) return true;                                   // 同じ種別（ユニーク制約）
  if (newType === 'absent' || newType === 'holiday_work') return true;         // 単独種別はその日に他があれば不可
  if (existingType === 'absent' || existingType === 'holiday_work') return true;
  const both = (group: string[]) => group.includes(newType) && group.includes(existingType);
  if (both(['late', 'late_start'])) return true;                 // 出勤側は一方のみ
  if (both(['early_leave', 'early_end'])) return true;           // 退勤側は一方のみ
  if (both(['location_change', 'time_change'])) return true;     // 勤務時間帯を持つ種別は一方のみ
  return false;
};

// ===== 欠勤入力ボトムシート =====
const AbsenceInputSheet: React.FC<{
  date: string;
  profiles: ProfileEntry[];
  currentUserId: string;
  workplaces: string[];
  onClose: () => void;
  onSaved: () => void;
  onSaving: () => void;
}> = ({ date, profiles, currentUserId, workplaces, onClose, onSaved, onSaving }) => {
  // 入力中の下書きを端末に保存し、開いていた日付に戻ったとき復元する
  const [absDraft] = useState(() => {
    const d = loadDraft<AbsenceDraft>(DRAFT_KEYS.attendance);
    return d && d.date === date ? d : null;
  });
  // 対象者（複数）。同じ校・同じ時間の人はまとめて登録できる
  const [userIds, setUserIds] = useState<Set<string>>(() => new Set(absDraft?.userIds ?? (absDraft?.userId ? [absDraft.userId] : [])));
  // 校（必須）。日付ごとに選択できる（全欠勤の複数日は日別、遅刻・早退はその日1件）
  const [locations, setLocations] = useState<Record<string, string>>(absDraft?.locations ?? {});
  // 校で「その他」を選んだときの自由入力（日付ごと）
  const [locationCustoms, setLocationCustoms] = useState<Record<string, string>>(absDraft?.locationCustoms ?? {});
  const [bulkLocation, setBulkLocation] = useState('');
  const [isHolidayWork, setIsHolidayWork] = useState(absDraft?.isHolidayWork ?? false);
  // 勤務時間帯（休日出勤、または「途中で別の校に移動した」を選んだとき）。既定値は必ず `??` で入れる
  const [segments, setSegments] = useState<WorkSegment[]>(absDraft?.segments ?? [{ start: '', end: '', location: '' }]);
  const [segmentCustoms, setSegmentCustoms] = useState<string[]>(absDraft?.segmentCustoms ?? ['']);
  const [hasLocationMove, setHasLocationMove] = useState(absDraft?.hasLocationMove ?? false);
  // 勤務地変更（普段と違う校で勤務する）。「校（必須）」欄が変更後、こちらが変更前
  const [isLocationChange, setIsLocationChange] = useState(absDraft?.isLocationChange ?? false);
  const [originalLocation, setOriginalLocation] = useState(absDraft?.originalLocation ?? '');
  const [originalLocationCustom, setOriginalLocationCustom] = useState(absDraft?.originalLocationCustom ?? '');
  // 勤務時間変更（校は普段どおり・勤務時間だけ違う）。勤務地変更とは一方しか選べない
  const [isTimeChange, setIsTimeChange] = useState(absDraft?.isTimeChange ?? false);
  const [isAbsent, setIsAbsent] = useState(absDraft?.isAbsent ?? false);
  // 対象日（全種別共通）。同じ内容を選んだ日すべてに登録する。既定は開いた日の1日だけ
  const [targetDates, setTargetDates] = useState<Set<string>>(() => new Set(absDraft?.targetDates ?? absDraft?.absentDates ?? [date]));
  const [isLate, setIsLate] = useState(absDraft?.isLate ?? false);
  const [isLateStart, setIsLateStart] = useState(absDraft?.isLateStart ?? false);
  const [isEarlyLeave, setIsEarlyLeave] = useState(absDraft?.isEarlyLeave ?? false);
  const [isEarlyEnd, setIsEarlyEnd] = useState(absDraft?.isEarlyEnd ?? false);
  const [lateTime, setLateTime] = useState(absDraft?.lateTime ?? '');
  const [earlyTime, setEarlyTime] = useState(absDraft?.earlyTime ?? '');
  const _MINUTES_5 = Array.from({ length: 12 }, (_, i) => i * 5); void _MINUTES_5;
  const _HOURS_24 = Array.from({ length: 24 }, (_, i) => i); void _HOURS_24;
  const _timeH = (t: string) => t ? parseInt(t.split(':')[0], 10) : 8; void _timeH;
  const _timeM = (t: string) => t ? parseInt(t.split(':')[1], 10) : 0; void _timeM;
  const _toTimeStr = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; void _toTimeStr;
  const selStyle: React.CSSProperties = { padding: '4px 4px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14 };
  const [notes, setNotes] = useState(absDraft?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const savingRef = React.useRef(false);
  const confirmingRef = React.useRef(false);
  const [error, setError] = useState('');
  // 入力エラーの欄を薄赤にする（lib/formHighlight.ts の共通色）
  const [errFields, setErrFields] = useState<Set<string>>(new Set());
  const clearErr = (key: string) => setErrFields(prev => { if (!prev.has(key)) return prev; const n = new Set(prev); n.delete(key); return n; });
  const [confirming, setConfirming] = useState(false);
  // すでに登録があって、このままでは登録できない日（確認画面で赤く出し、外して登録できるようにする）
  const [conflicts, setConflicts] = useState<{ userId: string; name: string; date: string; label: string }[]>([]);
  const [checking, setChecking] = useState(false);
  // 複数日はGoogleカレンダーへの書き込みが件数ぶん走るので、進み具合を出す（無反応に見えるのを防ぐ）
  const [saveProgress, setSaveProgress] = useState({ done: 0, total: 0 });

  // 見出しの日付。対象日から開いた日を外すこともできるので、いちばん早い対象日を出す
  const headDate = [...targetDates].sort()[0] ?? date;
  const dateLabel = `${headDate.slice(5, 7)}月${headDate.slice(8, 10)}日（${dow(headDate)}）`
    + (targetDates.size > 1 ? ` 他${targetDates.size - 1}日` : '');
  const grouped = buildProfileGroups(profiles);

  // 入力中の下書きを自動保存
  useEffect(() => {
    saveDraft(DRAFT_KEYS.attendance, {
      date, userIds: [...userIds], isAbsent, targetDates: [...targetDates],
      isLate, isLateStart, isEarlyLeave, isEarlyEnd, lateTime, earlyTime, notes, locations,
      locationCustoms, isHolidayWork, segments, segmentCustoms, hasLocationMove,
      isLocationChange, originalLocation, originalLocationCustom, isTimeChange,
    });
  }, [date, userIds, isAbsent, targetDates, isLate, isLateStart, isEarlyLeave, isEarlyEnd, lateTime, earlyTime, notes, locations, locationCustoms, isHolidayWork, segments, segmentCustoms, hasLocationMove, isLocationChange, originalLocation, originalLocationCustom, isTimeChange]);

  // 種別が排他で押せないときの理由（グレーにするだけだと「なぜ押せないのか」が分からないため）
  const blockedReason = isHolidayWork
    ? '休日出勤のときは、実際に働いた時間の報告は「勤務変更」で行ってください。'
    : isAbsent ? '全欠勤のときは他の種別を選べません。' : '';

  const toggleHolidayWork = (checked: boolean) => {
    setIsHolidayWork(checked);
    if (checked) {
      setIsAbsent(false); setIsLate(false); setIsLateStart(false); setIsEarlyLeave(false); setIsEarlyEnd(false);
      setIsLocationChange(false); // 休みの日の出勤なので「普段の勤務地からの変更」にはならない
      setIsTimeChange(false);     // 同じ理由で「普段の勤務時間からの変更」にもならない
      setHasLocationMove(false);
    }
  };

  const toggleAbsent = (checked: boolean) => {
    if (isHolidayWork) return;
    setIsAbsent(checked);
    if (checked) { setIsLate(false); setIsLateStart(false); setIsEarlyLeave(false); setIsEarlyEnd(false); setIsLocationChange(false); setIsTimeChange(false); setHasLocationMove(false); }
  };

  // 勤務地変更は遅刻・早退と同時に選べる（洛西口校で勤務、しかも遅刻、はあり得るため）。
  // 校が変わると勤務時間も変わるので、選ぶと時間帯の入力が出る（下の useSegments）。
  // 勤務時間変更とは一方のみ（どちらも「実際に勤務する時間帯」を持つため、両方だと二重定義になる）
  const toggleLocationChange = (checked: boolean) => {
    if (isAbsent || isHolidayWork) return;
    setIsLocationChange(checked);
    if (checked) { setIsTimeChange(false); setHasLocationMove(false); } // 時間帯の入力自体が出るので、移動チェックは不要
  };

  // 勤務時間変更（校は普段どおり・時間だけ違う）。勤務地変更と同じく時間帯の入力が出る
  const toggleTimeChange = (checked: boolean) => {
    if (isAbsent || isHolidayWork) return;
    setIsTimeChange(checked);
    if (checked) { setIsLocationChange(false); setHasLocationMove(false); }
  };

  const toggleLate = (checked: boolean) => {
    if (isAbsent || isHolidayWork) return;
    setIsLate(checked);
    if (checked) setIsLateStart(false);
  };

  const toggleLateStart = (checked: boolean) => {
    if (isAbsent || isHolidayWork) return;
    setIsLateStart(checked);
    if (checked) setIsLate(false);
  };

  const toggleEarlyLeave = (checked: boolean) => {
    if (isAbsent || isHolidayWork) return;
    setIsEarlyLeave(checked);
    if (checked) setIsEarlyEnd(false);
  };

  const toggleEarlyEnd = (checked: boolean) => {
    if (isAbsent || isHolidayWork) return;
    setIsEarlyEnd(checked);
    if (checked) setIsEarlyLeave(false);
  };

  // 「途中で別の校に移動した」…既存の入力を消さないよう、いま選んでいる校と時刻を時間帯①に引き継ぐ
  const toggleLocationMove = (checked: boolean) => {
    setHasLocationMove(checked);
    if (checked && segments.every(s => !s.start && !s.end && !s.location)) {
      setSegments([
        { start: lateTime || '', end: '', location: locations[date] ?? '' },
        { start: '', end: earlyTime || '', location: '' },
      ]);
      setSegmentCustoms([locationCustoms[date] ?? '', '']);
    }
  };

  // 時間帯の編集（休日出勤・勤務地変更・勤務時間変更・校の移動で共用）
  const useSegments = isHolidayWork || isLocationChange || isTimeChange || hasLocationMove;
  const updateSegment = (i: number, patch: Partial<WorkSegment>) =>
    setSegments(prev => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const addSegment = () => {
    if (segments.length >= 3) return; // 午前・午後・夜で3つあれば実務上足りる（際限なく伸びるのを防ぐ）
    setSegments(prev => [...prev, { start: '', end: '', location: '' }]);
    setSegmentCustoms(prev => [...prev, '']);
  };
  const removeSegment = (i: number) => {
    setSegments(prev => prev.filter((_, idx) => idx !== i));
    setSegmentCustoms(prev => prev.filter((_, idx) => idx !== i));
  };
  /** 「その他」を選んだ時間帯は自由入力の値を実際の校名として使う */
  const effectiveSegments = (): WorkSegment[] => segments.map((s, i) => ({
    ...s,
    location: s.location === OTHER_LOCATION ? (segmentCustoms[i] ?? '').trim() : s.location,
  }));
  /** 日付ごとの校も同様に「その他」を解決する */
  const effectiveLocation = (d: string): string =>
    locations[d] === OTHER_LOCATION ? (locationCustoms[d] ?? '').trim() : (locations[d] ?? '');
  /** 勤務地変更の「変更前の校」 */
  const effectiveOriginalLocation = (): string =>
    originalLocation === OTHER_LOCATION ? originalLocationCustom.trim() : originalLocation;

  // 対象者の追加・削除
  const toggleUser = (id: string) => {
    setUserIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    clearErr('userId');
    setConflicts([]); // 人を変えたら、前回の重複チェックの結果は無効
  };

  // 対象日の追加・削除。0日にはできない（最低1日は残す）
  const toggleTargetDate = (d: string) => {
    setTargetDates(prev => {
      const next = new Set(prev);
      if (next.has(d)) { if (next.size > 1) next.delete(d); }
      else next.add(d);
      return next;
    });
    setConflicts([]); // 日を変えたら、前回の重複チェックの結果は無効
  };

  const nameOf = (id: string) => profiles.find((p: ProfileEntry) => p.id === id)?.name ?? '';

  /** いま選ばれている種別（記録として保存される type の一覧） */
  const selectedTypes = (): string[] => {
    const t: string[] = [];
    if (isAbsent) t.push('absent');
    if (isHolidayWork) t.push('holiday_work');
    if (isLocationChange) t.push('location_change');
    if (isTimeChange) t.push('time_change');
    if (isLate) t.push('late');
    if (isLateStart) t.push('late_start');
    if (isEarlyLeave) t.push('early_leave');
    if (isEarlyEnd) t.push('early_end');
    return t;
  };

  const handleConfirm = async () => {
    if (confirmingRef.current) return;
    setError('');
    if (userIds.size === 0) { setError('対象者を選択してください'); setErrFields(new Set(['userId'])); scrollToFirstError(['userId']); return; }
    if (!isAbsent && !isHolidayWork && !isLocationChange && !isTimeChange && !isLate && !isLateStart && !isEarlyLeave && !isEarlyEnd) { setError('種別を選択してください'); return; }
    if ((isLate || isLateStart) && !lateTime) { setError('出勤時間を入力してください'); setErrFields(new Set(['lateTime'])); scrollToFirstError(['lateTime']); return; }
    if ((isEarlyLeave || isEarlyEnd) && !earlyTime) { setError('退勤時間を入力してください'); setErrFields(new Set(['earlyTime'])); scrollToFirstError(['earlyTime']); return; }
    if (isLocationChange && !effectiveOriginalLocation()) { setError('変更前の校を選択してください'); setErrFields(new Set(['originalLocation'])); scrollToFirstError(['originalLocation']); return; }

    if (useSegments) {
      const segs = effectiveSegments();
      if (segs.length === 0) { setError('勤務時間を1つ以上入力してください'); return; }
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const no = `時間帯${i + 1}`;
        if (!s.start || !s.end) { setError(`${no}の勤務時間を入力してください`); return; }
        if (s.start >= s.end) { setError(`${no}は終了時刻を開始時刻より後にしてください`); return; }
        if (!s.location) { setError(`${no}の校を選択してください`); return; }
      }
      // 時間帯どうしが重なっていないか（重なると「どこにいるのか分からない」記録になる）
      const sorted = [...segs].sort((a, b) => a.start.localeCompare(b.start));
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].start < sorted[i - 1].end) { setError('勤務時間が重なっています。時間帯を確認してください'); return; }
      }
    } else {
      // 対象日すべてで校が選ばれているか
      if ([...targetDates].some(d => !effectiveLocation(d))) { setError('すべての日付で校を選択してください'); return; }
    }

    // すでに登録がある日を先に調べておく（確認画面で赤く出し、その日を外して登録できるようにする）。
    // 取れなかった場合は素通しでよい（DBのトリガーが最後の砦として必ず弾く）
    setChecking(true);
    const dates = [...targetDates].sort();
    const ids = [...userIds];
    const types = selectedTypes();
    const { data: existing, error: checkErr } = await supabase
      .from('attendance_exceptions')
      .select('user_id, date, type')
      .in('user_id', ids)
      .in('date', dates);
    setChecking(false);
    if (checkErr) {
      console.error('[attendance] 重複チェックに失敗:', checkErr);
      setConflicts([]);
    } else {
      type Row = { user_id: string; date: string; type: string };
      const found: { userId: string; name: string; date: string; label: string }[] = [];
      for (const uid of ids) {
        for (const d of dates) {
          const sameDay = (existing ?? []).filter((e: Row) => e.user_id === uid && e.date === d);
          const hit = sameDay.find((e: Row) => types.some(t => conflictsWithExisting(t, e.type)));
          if (hit) found.push({ userId: uid, name: nameOf(uid), date: d, label: absenceLabel(hit.type) });
        }
      }
      setConflicts(found);
    }
    confirmingRef.current = true;
    setConfirming(true);
  };

  /** skipConflicts=true のとき、すでに登録がある日を外して残りだけ登録する */
  const handleSave = async (skipConflicts = false) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const segs = useSegments ? effectiveSegments() : [];
    // 校の表示用文字列。時間帯があるときは '四条本校→洛西口校'（シフト表の取り込みと同じ書き方）
    const segLoc = joinSegmentLocations(segs);
    const locOf = (d: string) => (useSegments ? segLoc : effectiveLocation(d));
    // 時間帯の意味は全種別で「実際に勤務した時間帯」に統一する
    const segCol = segs.length > 0 ? segs : null;

    const origLoc = isLocationChange ? effectiveOriginalLocation() : null;

    // 選んだ人 × 選んだ日 すべてに同じ内容を登録する。
    // すでに登録がある組み合わせ（人と日）は、マネージャーが選んだときだけ外す
    const conflictKeys = new Set(conflicts.map(c => `${c.userId}|${c.date}`));
    const pairs: { uid: string; d: string }[] = [];
    for (const uid of [...userIds]) {
      for (const d of [...targetDates].sort()) {
        if (skipConflicts && conflictKeys.has(`${uid}|${d}`)) continue;
        pairs.push({ uid, d });
      }
    }
    if (pairs.length === 0) {
      setSaving(false); savingRef.current = false; confirmingRef.current = false; setConfirming(false);
      setError('登録できる分がありません。対象者・日付を選び直してください');
      return;
    }

    const records: { user_id: string; date: string; type: string; actual_time: string | null; notes: string; created_by: string; location: string; work_segments: WorkSegment[] | null; original_location: string | null }[] = [];
    for (const { uid, d } of pairs) {
      if (isAbsent)         records.push({ user_id: uid, date: d, type: 'absent',          actual_time: null,                   notes, created_by: currentUserId, location: effectiveLocation(d), work_segments: null,   original_location: null });
      if (isHolidayWork)    records.push({ user_id: uid, date: d, type: 'holiday_work',    actual_time: segs[0]?.start ?? null, notes, created_by: currentUserId, location: segLoc,              work_segments: segCol, original_location: null });
      if (isLocationChange) records.push({ user_id: uid, date: d, type: 'location_change', actual_time: null,                   notes, created_by: currentUserId, location: locOf(d),            work_segments: segCol, original_location: origLoc });
      // 勤務時間変更は校が普段どおりなので変更前の校は持たない（時間帯の校がそのまま勤務校）
      if (isTimeChange)     records.push({ user_id: uid, date: d, type: 'time_change',     actual_time: segs[0]?.start ?? null, notes, created_by: currentUserId, location: segLoc,              work_segments: segCol, original_location: null });
      if (isLate)           records.push({ user_id: uid, date: d, type: 'late',            actual_time: lateTime,               notes, created_by: currentUserId, location: locOf(d),            work_segments: segCol, original_location: origLoc });
      if (isLateStart)      records.push({ user_id: uid, date: d, type: 'late_start',      actual_time: lateTime,               notes, created_by: currentUserId, location: locOf(d),            work_segments: segCol, original_location: origLoc });
      if (isEarlyLeave)     records.push({ user_id: uid, date: d, type: 'early_leave',     actual_time: earlyTime,              notes, created_by: currentUserId, location: locOf(d),            work_segments: segCol, original_location: origLoc });
      if (isEarlyEnd)       records.push({ user_id: uid, date: d, type: 'early_end',       actual_time: earlyTime,              notes, created_by: currentUserId, location: locOf(d),            work_segments: segCol, original_location: origLoc });
    }

    const { data: inserted, error: err } = await supabase.from('attendance_exceptions').insert(records).select('id, user_id, type, date, actual_time');
    if (err) {
      setSaving(false);
      savingRef.current = false;
      confirmingRef.current = false;
      setConfirming(false);
      // 同じ日に矛盾する勤怠がある場合はDB側のトリガーが日本語のメッセージを返すので、そのまま出す
      const isConflict = err.message.includes('同じ日にすでに');
      setError(isConflict ? err.message : '保存に失敗しました: ' + err.message);
      return;
    }
    // Googleカレンダーに書き込む。
    // invoke は 4xx/5xx でも throw しないため、必ず error と success を見る（見ないと失敗が誰にも見えない）
    let gcalFailed = false;
    setSaveProgress({ done: 0, total: (inserted ?? []).length });
    for (const rec of inserted ?? []) {
      const { data: syncRes, error: syncErr } = await supabase.functions.invoke('gcal-sync', {
        body: {
          action: 'upsert',
          source_type: 'absence',
          source_id: rec.id,
          dates: [rec.date],
          name: nameOf(rec.user_id), // カレンダーのタイトルはその記録の本人の名前にする
          absence_type: rec.type,
          time: rec.actual_time ? rec.actual_time.slice(0, 5) : undefined,
          locations: { [rec.date]: locOf(rec.date) },
          work_segments: segCol,
        },
      });
      const sr = syncRes as { success?: boolean } | null;
      if (syncErr || sr?.success === false) {
        gcalFailed = true;
        console.error('[gcal-sync] 勤怠の書き込み失敗:', syncErr);
      }
      setSaveProgress(p => ({ ...p, done: p.done + 1 }));
    }
    if (gcalFailed) {
      setSaving(false);
      savingRef.current = false;
      confirmingRef.current = false;
      setConfirming(false);
      setError('登録は完了しましたが、Googleカレンダーへの反映に失敗しました。カレンダーを確認してください。');
      onSaved(); // 一覧だけは最新にする
      return;
    }
    // リーダー以上・本人へ通知（通知設定 attendance:registered に従う）
    // 何人・何日を登録しても、通知は1件にまとめる（人数分ベルが連なるのを防ぐ）
    const { error: notifyErr } = await supabase.functions.invoke('attendance-notify', {
      body: {
        users: [...new Set(records.map(r => r.user_id))].map(id => ({ id, name: nameOf(id) })),
        dates: [...new Set(records.map(r => r.date))],
        types: [...new Set(records.map(r => r.type))],
      },
    });
    if (notifyErr) console.error('[attendance-notify] 通知失敗:', notifyErr);
    clearDraft(DRAFT_KEYS.attendance); // 登録成功で下書きを消す
    onSaving(); // バナー表示
    onClose();  // モーダル・シートを閉じる
    onSaved();  // カレンダーを再取得
  };

  // キャンセル/背景タップは「破棄」＝下書きを消して閉じる（送信以外で明示的に閉じた場合）。
  // 一方、更新や別アプリ移動でシートが消えた場合は下書きが残り、次回開いたとき復元される。
  const handleDismiss = () => { clearDraft(DRAFT_KEYS.attendance); onClose(); };

  // クリア：入力内容を空に戻す（シートは閉じない）。下書きも消す。
  const clearAbsenceForm = () => {
    setUserIds(new Set()); setLocations({}); setLocationCustoms({}); setBulkLocation('');
    setIsAbsent(false); setTargetDates(new Set([date])); setConflicts([]);
    setIsHolidayWork(false); setHasLocationMove(false);
    setIsLocationChange(false); setOriginalLocation(''); setOriginalLocationCustom(''); setIsTimeChange(false);
    setSegments([{ start: '', end: '', location: '' }]); setSegmentCustoms(['']);
    setIsLate(false); setIsLateStart(false); setIsEarlyLeave(false); setIsEarlyEnd(false);
    setLateTime(''); setEarlyTime(''); setNotes(''); setError('');
    clearDraft(DRAFT_KEYS.attendance);
  };

  return (
    <div
      style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={handleDismiss}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: '16px 16px 0 0', padding: '24px 20px', width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto' }}
      >
        <h3 style={{ margin: '0 0 4px', fontSize: 16, textAlign: 'center', color: '#333' }}>
          📝 勤怠入力　{dateLabel}
        </h3>
        <div style={{ fontSize: 11, textAlign: 'center', color: '#888', marginBottom: 8 }}>
          スタッフの欠勤・遅刻・早退・休日出勤を登録します
        </div>
        {/* 入力内容クリア */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button type="button" onClick={clearAbsenceForm}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#8a939c', background: 'none', border: '1px solid #d5dae0', borderRadius: 14, padding: '4px 12px', cursor: 'pointer' }}>
            クリア
          </button>
        </div>

        {/* 対象者 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: errFields.has('userId') ? '#dc3545' : '#666', marginBottom: 6 }}>
            対象者（複数選べます）{userIds.size > 1 && <span style={{ color: '#1a5fa8', marginLeft: 6 }}>{userIds.size}人</span>}
          </div>
          {/* 未選択で送信したときに薄赤で囲む（どこが原因か分かるように） */}
          <div data-err-field="userId" style={errFields.has('userId') ? { border: `1px solid ${ERROR_BORDER}`, background: errorBg(false), borderRadius: 6, padding: 4 } : undefined}>
            <StaffPicker profiles={profiles} grouped={grouped} selectedIds={userIds} onToggle={toggleUser} onClear={() => { setUserIds(new Set()); setConflicts([]); }} />
          </div>
        </div>

        {/* 種別 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>種別（複数選択可）</div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px', border: `2px solid ${isAbsent ? '#dc3545' : '#e0e0e0'}`, borderRadius: 10, marginBottom: 4, cursor: isHolidayWork ? 'default' : 'pointer', background: isAbsent ? '#fff5f5' : '#fff', opacity: isHolidayWork ? 0.4 : 1 }}>
            <input type="checkbox" checked={isAbsent} onChange={e => toggleAbsent(e.target.checked)} style={{ width: 20, height: 20, accentColor: '#dc3545' }} />
            <span style={{ fontSize: 15, fontWeight: 'bold', color: '#c0392b' }}>🔴 全欠勤</span>
            <span style={{ marginLeft: 'auto', fontSize: 10, color: '#c0392b', border: '1px solid #f1b0b7', borderRadius: 4, padding: '1px 5px' }}>単独</span>
          </label>

          {/* 休日出勤（本来休みの日に出勤する場合）。全欠勤と同じく単独で選ぶ */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px', border: `2px solid ${isHolidayWork ? '#0f766e' : '#e0e0e0'}`, borderRadius: 10, marginBottom: 8, cursor: isAbsent ? 'default' : 'pointer', background: isHolidayWork ? '#e6f5f2' : '#fff', opacity: isAbsent ? 0.4 : 1 }}>
            <input type="checkbox" checked={isHolidayWork} onChange={e => toggleHolidayWork(e.target.checked)} style={{ width: 20, height: 20, accentColor: '#0f766e' }} />
            <span style={{ fontSize: 15, fontWeight: 'bold', color: '#0f766e' }}>🏢 休日出勤</span>
            <span style={{ marginLeft: 'auto', fontSize: 10, color: '#0f766e', border: '1px solid #9ccfc7', borderRadius: 4, padding: '1px 5px' }}>単独</span>
          </label>

          {/* 勤務地変更（普段と違う校で勤務する）。遅刻・早退と一緒に選べる */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px', border: `2px solid ${isLocationChange ? '#6d28d9' : '#e0e0e0'}`, borderRadius: 10, marginBottom: 8, cursor: (isAbsent || isHolidayWork) ? 'default' : 'pointer', background: isLocationChange ? '#f3eeff' : '#fff', opacity: (isAbsent || isHolidayWork) ? 0.4 : 1 }}>
            <input type="checkbox" checked={isLocationChange} onChange={e => toggleLocationChange(e.target.checked)} disabled={isAbsent || isHolidayWork} style={{ width: 20, height: 20, accentColor: '#6d28d9' }} />
            <span style={{ fontSize: 15, fontWeight: 'bold', color: '#6d28d9' }}>📍 勤務地変更</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6d28d9' }}>普段と違う校</span>
          </label>

          {/* 勤務時間変更（校は普段どおり・勤務時間だけ違う）。短期などで通常レッスンがない日に使う */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px', border: `2px solid ${isTimeChange ? '#374151' : '#e0e0e0'}`, borderRadius: 10, marginBottom: 8, cursor: (isAbsent || isHolidayWork) ? 'default' : 'pointer', background: isTimeChange ? '#eef0f3' : '#fff', opacity: (isAbsent || isHolidayWork) ? 0.4 : 1 }}>
            <input type="checkbox" checked={isTimeChange} onChange={e => toggleTimeChange(e.target.checked)} disabled={isAbsent || isHolidayWork} style={{ width: 20, height: 20, accentColor: '#374151' }} />
            <span style={{ fontSize: 15, fontWeight: 'bold', color: '#374151' }}>🕐 勤務時間変更</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: '#374151' }}>普段と違う時間</span>
          </label>

          {isTimeChange && (
            <div style={{ fontSize: 11, color: '#888', margin: '-2px 0 8px', paddingLeft: 4, lineHeight: 1.6 }}>
              ※ 校は普段どおりで、勤務時間だけが違う日に使います（短期などで通常レッスンがない日）。
              校も変わる場合は「勤務地変更」を選んでください。
            </div>
          )}

          {/* 遅刻 / 調整遅出 行 */}
          <div style={{ marginBottom: 8, opacity: (isAbsent || isHolidayWork) ? 0.4 : 1 }}>
            <div style={{ display: 'flex', gap: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: `2px solid ${isLate ? '#ff9800' : '#e0e0e0'}`, borderRadius: 10, cursor: (isAbsent || isHolidayWork) ? 'default' : 'pointer', background: isLate ? '#fff8f0' : '#fff', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={isLate} onChange={e => toggleLate(e.target.checked)} disabled={isAbsent || isHolidayWork} style={{ width: 18, height: 18, accentColor: '#ff9800', flexShrink: 0 }} />
              <span style={{ fontSize: 14, fontWeight: 'bold', color: '#e65100' }}>🟠 遅刻</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: `2px solid ${isLateStart ? '#8bc34a' : '#e0e0e0'}`, borderRadius: 10, cursor: (isAbsent || isHolidayWork) ? 'default' : 'pointer', background: isLateStart ? '#f9fbe7' : '#fff', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={isLateStart} onChange={e => toggleLateStart(e.target.checked)} disabled={isAbsent || isHolidayWork} style={{ width: 18, height: 18, accentColor: '#8bc34a', flexShrink: 0 }} />
              <span style={{ fontSize: 14, fontWeight: 'bold', color: '#558b2f' }}>🟢 調整遅出</span>
            </label>
            </div>
            {(isLate || isLateStart) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8 }} onClick={e => e.preventDefault()}>
                <span style={{ fontSize: 12, color: '#666', whiteSpace: 'nowrap' }}>出勤時間</span>
                <input data-err-field="lateTime" type="time" value={lateTime} onChange={e => { setLateTime(e.target.value); clearErr('lateTime'); }} onClick={e => e.stopPropagation()} style={{ ...selStyle, ...errorStyle(errFields.has('lateTime'), false), flex: 1 }} />
              </div>
            )}
          </div>

          {/* 早退 / 調整早退 行 */}
          <div style={{ marginBottom: 8, opacity: (isAbsent || isHolidayWork) ? 0.4 : 1 }}>
            <div style={{ display: 'flex', gap: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: `2px solid ${isEarlyLeave ? '#2196f3' : '#e0e0e0'}`, borderRadius: 10, cursor: (isAbsent || isHolidayWork) ? 'default' : 'pointer', background: isEarlyLeave ? '#f0f8ff' : '#fff', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={isEarlyLeave} onChange={e => toggleEarlyLeave(e.target.checked)} disabled={isAbsent || isHolidayWork} style={{ width: 18, height: 18, accentColor: '#2196f3', flexShrink: 0 }} />
              <span style={{ fontSize: 14, fontWeight: 'bold', color: '#1565c0' }}>🔵 早退</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: `2px solid ${isEarlyEnd ? '#9c27b0' : '#e0e0e0'}`, borderRadius: 10, cursor: (isAbsent || isHolidayWork) ? 'default' : 'pointer', background: isEarlyEnd ? '#f3e5f5' : '#fff', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={isEarlyEnd} onChange={e => toggleEarlyEnd(e.target.checked)} disabled={isAbsent || isHolidayWork} style={{ width: 18, height: 18, accentColor: '#9c27b0', flexShrink: 0 }} />
              <span style={{ fontSize: 14, fontWeight: 'bold', color: '#6a1b9a' }}>🟣 調整早退</span>
            </label>
            </div>
            {(isEarlyLeave || isEarlyEnd) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8 }} onClick={e => e.preventDefault()}>
                <span style={{ fontSize: 12, color: '#666', whiteSpace: 'nowrap' }}>退勤時間</span>
                <input data-err-field="earlyTime" type="time" value={earlyTime} onChange={e => { setEarlyTime(e.target.value); clearErr('earlyTime'); }} onClick={e => e.stopPropagation()} style={{ ...selStyle, ...errorStyle(errFields.has('earlyTime'), false), flex: 1 }} />
              </div>
            )}
          </div>

          {/* なぜ選べないのかを書く（グレーにするだけでは理由が伝わらないため） */}
          {blockedReason && (
            <div style={{ fontSize: 11.5, color: '#666', background: '#f7f8fa', borderRadius: 6, padding: '7px 10px', lineHeight: 1.6 }}>
              {blockedReason}
            </div>
          )}
        </div>

        {/* 対象日（全種別で共通）。同じ校・同じ時間の勤務なら、まとめて登録できる */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>対象日（複数選べます）</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {[...targetDates].sort().map(d => (
              <span key={d} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: '#e8f1fb', border: '1px solid #b7d3f0', color: '#1c5a96', borderRadius: 14, padding: '4px 10px', fontSize: 12.5 }}>
                {`${parseInt(d.slice(5, 7))}/${parseInt(d.slice(8, 10))}（${dow(d)}）`}
                {targetDates.size > 1 && (
                  <button type="button" onClick={() => toggleTargetDate(d)} title="この日を外す"
                    style={{ background: 'none', border: 'none', color: '#1c5a96', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}>✕</button>
                )}
              </span>
            ))}
          </div>
          <MultiDatePicker selectedDates={targetDates} onToggle={toggleTargetDate} />
          <div style={{ fontSize: 11, color: '#888', marginTop: 2, lineHeight: 1.6 }}>
            ※ 同じ校・同じ時間の勤務なら、日付をタップしてまとめて登録できます（選んだ日すべてに同じ内容で登録されます）。
          </div>
        </div>

        {/* 勤務地変更の「変更前の校（普段の校）」。下の「校（必須）」が変更後にあたる */}
        {isLocationChange && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>変更前の校（普段の校）</div>
            <select value={originalLocation} onChange={e => setOriginalLocation(e.target.value)}
              style={{ width: '100%', padding: '8px', borderRadius: 8, border: `1px solid ${!originalLocation ? '#f0a0a0' : '#ccc'}`, fontSize: 14, background: '#fff', color: '#333', boxSizing: 'border-box' }}>
              <option value="">選択してください</option>
              {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
              <option value={OTHER_LOCATION}>その他（自由入力）</option>
            </select>
            {originalLocation === OTHER_LOCATION && (
              <input type="text" value={originalLocationCustom} placeholder="校名・場所を入力"
                onChange={e => setOriginalLocationCustom(e.target.value)}
                style={{ width: '100%', marginTop: 5, padding: '8px', borderRadius: 8, border: `1px solid ${!originalLocationCustom.trim() ? '#f0a0a0' : '#ccc'}`, fontSize: 14, boxSizing: 'border-box' }} />
            )}
            <div style={{ fontSize: 11, color: '#888', marginTop: 5, lineHeight: 1.6 }}>
              ※ 下の「勤務時間と校」が、変更後に実際に勤務する時間と校です。
            </div>
          </div>
        )}

        {/* 勤務時間と校（休日出勤、または「途中で別の校に移動する」とき）。
            時間帯ごとに校を持つので、間に勤務しない時間があっても表せる */}
        {useSegments && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>勤務時間と校（必須）</div>
            {segments.map((seg, i) => {
              const missingLoc = !seg.location || (seg.location === OTHER_LOCATION && !(segmentCustoms[i] ?? '').trim());
              return (
                <div key={i} style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                    <span style={{ fontSize: 12, color: '#666', minWidth: 46, flexShrink: 0 }}>時間帯{i + 1}</span>
                    <input type="time" value={seg.start} onChange={e => updateSegment(i, { start: e.target.value })}
                      style={{ flex: 1, padding: '8px', borderRadius: 8, border: `1px solid ${!seg.start ? '#f0a0a0' : '#ccc'}`, fontSize: 14, background: '#fff', color: '#333' }} />
                    <span style={{ fontSize: 12, color: '#666' }}>〜</span>
                    <input type="time" value={seg.end} onChange={e => updateSegment(i, { end: e.target.value })}
                      style={{ flex: 1, padding: '8px', borderRadius: 8, border: `1px solid ${!seg.end ? '#f0a0a0' : '#ccc'}`, fontSize: 14, background: '#fff', color: '#333' }} />
                    {segments.length > 1 && (
                      <button type="button" onClick={() => removeSegment(i)} title="この時間帯を削除"
                        style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer', fontSize: 15, padding: '0 2px', flexShrink: 0 }}>🚫</button>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 52 }}>
                    <span style={{ fontSize: 12, color: '#666', flexShrink: 0 }}>校</span>
                    <select value={seg.location} onChange={e => updateSegment(i, { location: e.target.value })}
                      style={{ flex: 1, padding: '8px', borderRadius: 8, border: `1px solid ${missingLoc ? '#f0a0a0' : '#ccc'}`, fontSize: 14, background: '#fff', color: '#333' }}>
                      <option value="">選択してください</option>
                      {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
                      <option value={OTHER_LOCATION}>その他（自由入力）</option>
                    </select>
                  </div>
                  {seg.location === OTHER_LOCATION && (
                    <div style={{ paddingLeft: 52, marginTop: 5 }}>
                      <input type="text" value={segmentCustoms[i] ?? ''} placeholder="校名・場所を入力"
                        onChange={e => setSegmentCustoms(prev => prev.map((c, idx) => (idx === i ? e.target.value : c)))}
                        style={{ width: '100%', padding: '8px', borderRadius: 8, border: `1px solid ${!(segmentCustoms[i] ?? '').trim() ? '#f0a0a0' : '#ccc'}`, fontSize: 14, boxSizing: 'border-box' }} />
                    </div>
                  )}
                </div>
              );
            })}
            <div style={{ fontSize: 11, color: '#888', margin: '0 0 6px', lineHeight: 1.6 }}>
              ※ 間に勤務しない時間がある場合や、午前と午後で校が変わる場合は時間帯を追加してください。
            </div>
            {segments.length < 3 && (
              <button type="button" onClick={addSegment}
                style={{ width: '100%', padding: '9px', background: '#e8f4fd', border: '1px solid #90caf9', borderRadius: 8, color: '#1565c0', fontSize: 13, cursor: 'pointer' }}>
                ＋ 時間帯を追加
              </button>
            )}
          </div>
        )}

        {/* 校（必須・日付ごとに選択）。カレンダーのタイトルに［校名］で表示される */}
        {!useSegments && (() => {
          const dates = [...targetDates].sort();
          return (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>校（必須{dates.length > 1 ? '・日付ごとに選択' : ''}）</div>
              {dates.length > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '8px 10px', background: '#f4f7fb', borderRadius: 8 }}>
                  <span style={{ fontSize: 12, color: '#666', flexShrink: 0 }}>すべて同じ校にする：</span>
                  <select
                    value={bulkLocation}
                    onChange={e => {
                      const v = e.target.value;
                      setBulkLocation(v);
                      if (v) setLocations(Object.fromEntries(dates.map(d => [d, v])));
                    }}
                    style={{ flex: 1, padding: '8px', borderRadius: 8, border: '1px solid #ccc', fontSize: 14, background: '#fff', color: '#333' }}
                  >
                    <option value="">選択してください</option>
                    {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
                    <option value={OTHER_LOCATION}>その他（自由入力）</option>
                  </select>
                </div>
              )}
              <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, overflow: 'hidden' }}>
                {dates.map((d, i) => {
                  const isOther = locations[d] === OTHER_LOCATION;
                  const missing = !locations[d] || (isOther && !(locationCustoms[d] ?? '').trim());
                  return (
                    <div key={d} style={{ padding: '8px 10px', borderTop: i > 0 ? '1px solid #e0e0e0' : 'none', background: missing ? '#fff5f5' : 'transparent' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 13, color: '#333', flexShrink: 0, minWidth: 74 }}>
                          {parseInt(d.slice(5, 7))}/{parseInt(d.slice(8, 10))}（{'日月火水木金土'[new Date(d + 'T00:00:00').getDay()]}）
                        </span>
                        <select
                          value={locations[d] ?? ''}
                          onChange={e => {
                            setLocations(prev => ({ ...prev, [d]: e.target.value }));
                            setBulkLocation(''); // 個別に変えたら「一括」表示は解除
                          }}
                          style={{ flex: 1, padding: '8px', borderRadius: 8, border: `1px solid ${missing ? '#f0a0a0' : '#ccc'}`, fontSize: 14, background: '#fff', color: '#333' }}
                        >
                          <option value="">選択してください</option>
                          {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
                          <option value={OTHER_LOCATION}>その他（自由入力）</option>
                        </select>
                      </div>
                      {isOther && (
                        <input type="text" value={locationCustoms[d] ?? ''} placeholder="校名・場所を入力"
                          onChange={e => setLocationCustoms(prev => ({ ...prev, [d]: e.target.value }))}
                          style={{ width: '100%', marginTop: 5, padding: '8px', borderRadius: 8, border: `1px solid ${!(locationCustoms[d] ?? '').trim() ? '#f0a0a0' : '#ccc'}`, fontSize: 14, boxSizing: 'border-box' }} />
                      )}
                    </div>
                  );
                })}
              </div>

              {/* 校の移動（遅刻・早退など。全欠勤は移動が起きないので出さない） */}
              {!isAbsent && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, padding: '9px 10px', background: '#f4f7fb', borderRadius: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={hasLocationMove} onChange={e => toggleLocationMove(e.target.checked)}
                    style={{ width: 17, height: 17, accentColor: '#1976d2', flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, color: '#333' }}>途中で別の校に移動する</span>
                </label>
              )}
            </div>
          );
        })()}

        {/* 移動ありに切り替えた場合も、チェックを外せば元の校の入力に戻せる */}
        {hasLocationMove && !isHolidayWork && !isLocationChange && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: -8, marginBottom: 16, padding: '9px 10px', background: '#f4f7fb', borderRadius: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={hasLocationMove} onChange={e => toggleLocationMove(e.target.checked)}
              style={{ width: 17, height: 17, accentColor: '#1976d2', flexShrink: 0 }} />
            <span style={{ fontSize: 12.5, color: '#333' }}>途中で別の校に移動する</span>
          </label>
        )}

        {/* 備考 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>備考（任意）</div>
          <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder="理由など"
            style={{ width: '100%', padding: '10px', borderRadius: 8, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box' }} />
        </div>

        {error && (
          <div style={{ color: '#dc3545', fontSize: 13, marginBottom: 12, padding: '8px 12px', background: '#fff5f5', borderRadius: 6 }}>
            ⚠️ {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={handleDismiss} style={{ flex: 1, padding: 12, background: '#6c757d', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, cursor: 'pointer' }}>
            キャンセル
          </button>
          <button onClick={handleConfirm} disabled={confirming || saving || checking} style={{ flex: 2, padding: 12, background: '#dc3545', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 'bold', cursor: (confirming || saving || checking) ? 'not-allowed' : 'pointer', opacity: (confirming || saving || checking) ? 0.7 : 1 }}>
            {checking
              ? '確認中...'
              : `登録する${(userIds.size > 1 || targetDates.size > 1)
                  ? `（${userIds.size > 1 ? `${userIds.size}人 × ` : ''}${targetDates.size}日）`
                  : ''}`}
          </button>
        </div>

        {confirming && (() => {
          const segs = useSegments ? effectiveSegments() : [];
          // 日付は入力欄と同じ「7/28（火）」で出す（生の2026-07-28だと確認しづらいため）
          const dLabel = (d: string) => `${parseInt(d.slice(5, 7))}/${parseInt(d.slice(8, 10))}（${'日月火水木金土'[new Date(d + 'T00:00:00').getDay()]}）`;
          // すでに登録がある「人と日」の組み合わせは外して、残りだけを確認画面に出す
          const conflictKeys = new Set(conflicts.map(c => `${c.userId}|${c.date}`));
          const allDates = [...targetDates].sort();
          const okDatesOf = (uid: string) => allDates.filter(d => !conflictKeys.has(`${uid}|${d}`));
          // 時間帯を使う種別は校が全日共通。それ以外は日付ごとに校が違いうるので日付の後ろに校を出す
          const dateWithLoc = (d: string) => (useSegments ? dLabel(d) : `${dLabel(d)}　${effectiveLocation(d)}`);
          const persons = [...userIds]
            .map(uid => ({ uid, name: nameOf(uid), dates: okDatesOf(uid) }))
            .filter(p => p.dates.length > 0);
          const okPairCount = persons.reduce((n, p) => n + p.dates.length, 0);
          const totalCount = okPairCount * selectedTypes().length;
          // 種別ごとに「バッジ＋共通の詳細（時間帯など）＋対象者ごとの日付」を1ブロックで出す
          const segSubs = segs.map(s => `${hhmm(s.start)}〜${hhmm(s.end)}　${s.location}`);
          const blocks: { type: string; detail: string; subs?: string[] }[] = [];
          const add = (type: string, detail: string, subs?: string[]) => { if (persons.length > 0) blocks.push({ type, detail, subs }); };
          if (isAbsent)         add('absent',          '');
          if (isHolidayWork)    add('holiday_work',    '', segSubs);
          if (isLocationChange) add('location_change', `${effectiveOriginalLocation()} → ${joinSegmentLocations(segs)}`, segSubs);
          if (isTimeChange)     add('time_change',     '', segSubs);
          if (isLate)           add('late',        `出勤 ${hhmm(lateTime)}`,  segSubs);
          if (isLateStart)      add('late_start',  `出勤 ${hhmm(lateTime)}`,  segSubs);
          if (isEarlyLeave)     add('early_leave', `退勤 ${hhmm(earlyTime)}`, segSubs);
          if (isEarlyEnd)       add('early_end',   `退勤 ${hhmm(earlyTime)}`, segSubs);
          return (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, pointerEvents: saving ? 'none' : 'auto' }}>
              <div style={{ background: '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 400 }}>
                <div style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 16 }}>登録内容の確認</div>
                <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, padding: 12, marginBottom: 12, maxHeight: '45vh', overflowY: 'auto' }}>
                  {blocks.map((b, i) => {
                    const c = absenceColor(b.type);
                    return (
                      <div key={i} style={{ padding: '6px 0', borderBottom: i < blocks.length - 1 ? '1px solid #f0f0f0' : 'none' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 11, fontWeight: 'bold', padding: '2px 8px', borderRadius: 5, background: c.bg, color: c.text, flexShrink: 0 }}>
                            {absenceEmoji(b.type)} {absenceLabel(b.type)}
                          </span>
                          {b.detail && <span style={{ fontSize: 13.5, color: '#333' }}>{b.detail}</span>}
                        </div>
                        {(b.subs ?? []).map((s, j) => (
                          <div key={j} style={{ fontSize: 13, color: '#555', paddingLeft: 4, marginTop: 3 }}>{s}</div>
                        ))}
                        {/* 対象者ごとに、その人に登録される日を並べる */}
                        {persons.map(p => (
                          <div key={p.uid} style={{ fontSize: 13.5, color: '#333', marginTop: 4, paddingLeft: 4 }}>
                            <strong>{p.name}</strong>　{p.dates.map(dateWithLoc).join('・')}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                  {notes && <div style={{ fontSize: 13, color: '#666', marginTop: 8, paddingTop: 8, borderTop: '1px solid #f0f0f0' }}>備考：{notes}</div>}
                </div>
                {totalCount > 1 && (
                  <div style={{ fontSize: 12.5, color: '#555', marginBottom: 12 }}>合計 {totalCount}件を登録します</div>
                )}
                {/* すでに登録がある日は、その日だけ外して残りを登録できるようにする（黙って飛ばさない） */}
                {conflicts.length > 0 && (
                  <div style={{ background: '#fdecea', border: '1px solid #e24b4a', borderRadius: 8, padding: '10px 12px', marginBottom: 12, fontSize: 12.5, color: '#a32d2d', lineHeight: 1.7 }}>
                    <div style={{ fontWeight: 'bold' }}>⚠️ すでに登録がある分は外します</div>
                    {conflicts.map(c => (
                      <div key={`${c.userId}|${c.date}`}>
                        ・{userIds.size > 1 ? `${c.name}　` : ''}{dLabel(c.date)}　すでに「{c.label}」が登録されています
                      </div>
                    ))}
                    <div style={{ marginTop: 4 }}>
                      {okPairCount > 0
                        ? `この${conflicts.length}件を外して、残り${totalCount}件を登録できます。上書きしたい場合は、先に一覧から取消してください。`
                        : '登録できる分がありません。「戻る」で対象者・日付を選び直してください。'}
                    </div>
                  </div>
                )}
                <div style={{ fontSize: 11.5, color: '#666', background: '#f4f7fb', borderRadius: 8, padding: '8px 11px', marginBottom: 16, lineHeight: 1.6 }}>
                  📅 登録するとGoogleカレンダーに反映されます（一覧の「取消」で取り消せます）
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={() => { confirmingRef.current = false; setConfirming(false); }} disabled={saving} style={{ flex: 1, padding: 12, background: '#6c757d', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, cursor: 'pointer' }}>
                    戻る
                  </button>
                  {okPairCount > 0 && (
                    <button onClick={() => handleSave(conflicts.length > 0)} disabled={saving} style={{ flex: 2, padding: 12, background: saving ? '#aaa' : '#dc3545', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 'bold', cursor: saving ? 'not-allowed' : 'pointer' }}>
                      {saving
                        ? `保存中...${saveProgress.total > 1 ? `（${saveProgress.done}/${saveProgress.total}）` : ''}`
                        : conflicts.length > 0
                          ? `重複を外して登録する（${totalCount}件）`
                          : `確定する${totalCount > 1 ? `（${totalCount}件）` : ''}`}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
};

// ===== PC用カレンダー（グリッドのみ） =====
const PcCalendar: React.FC<{
  year: number; month: number;
  eventsByDate: Record<string, LeaveEvent[]>;
  absencesByDate: Record<string, AbsenceEvent[]>;
  calendarKinds: Record<string, CalendarKind>;
  isDark: boolean;
  onDateTap?: (date: string) => void;
}> = ({ year, month, eventsByDate, absencesByDate, calendarKinds, isDark, onDateTap }) => {
  const bg = isDark ? '#343a40' : '#fff';
  const border = isDark ? '#495057' : '#f0f0f0';
  const textColor = isDark ? '#fff' : '#333';
  const subColor = isDark ? '#adb5bd' : '#888';

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDow = new Date(year, month, 1).getDay(); // 日曜=0始まり
  const cells: { date: string | null; day: number | null; dow: number }[] = [];
  for (let i = 0; i < firstDow; i++) cells.push({ date: null, day: null, dow: i });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ date: fmt(year, month, d), day: d, dow: (firstDow + d - 1) % 7 });
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
            <th key={w} style={{ padding: '6px 0', fontSize: 12, color: i === 0 ? '#e74c3c' : i === 6 ? '#4a90d9' : subColor, borderBottom: `2px solid ${border}`, fontWeight: 'normal' }}>{w}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri}>
            {row.map((cell, ci) => {
              const isSun = ci === 0, isSat = ci === 6;
              const isToday = cell.date === todayStr;
              const events = cell.date ? (eventsByDate[cell.date] || []) : [];
              const absences = cell.date ? (absencesByDate[cell.date] || []) : [];
              // 会社カレンダー（休館日・出勤日）はセルの背景で示す。
              // 丸印や名前のラベルとは別の層なので、既存の表示とぶつからない
              const ck = cell.date ? calendarKinds[cell.date] : undefined;
              const cs = ck ? CALENDAR_CELL_STYLE[ck] : null;
              return (
                <td key={ci}
                  onClick={() => cell.date && onDateTap?.(cell.date)}
                  style={{ border: `1px solid ${border}`, verticalAlign: 'top', minHeight: 80, padding: 4, background: cs ? cs.bg : cell.date ? bg : isDark ? '#2a2f35' : '#fafafa', cursor: cell.date && onDateTap ? 'pointer' : 'default' }}>
                  {cell.day !== null && (
                    <>
                      <div style={{ marginBottom: 2 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', fontSize: 12, fontWeight: 'bold', background: isToday ? '#4a90d9' : 'transparent', color: isToday ? '#fff' : cs ? cs.text : isSat ? '#4a90d9' : isSun ? '#e74c3c' : textColor }}>
                          {cell.day}
                        </span>
                        {cs && <span style={{ fontSize: 10, fontWeight: 'bold', color: cs.text, marginLeft: 3 }}>{cs.short}</span>}
                      </div>
                      {events.map(ev => {
                        const c = getEventColor(ev);
                        const isPending = ev.status === 'pending' || ev.status === 'step2_pending';
                        const loc = cell.date ? ev.locations?.[cell.date] : undefined;
                        return (
                          <div key={ev.id + cell.date} title={`${ev.name}｜${shortType(ev)}${loc ? `［${loc}］` : ''}`}
                            style={{ fontSize: 11, borderRadius: 4, padding: '2px 4px', marginBottom: 2, background: c.bg, color: c.text, border: isPending ? `1px dashed ${'border' in c ? c.border : c.text}` : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {ev.name}{loc && <span style={{ fontSize: 9, opacity: 0.75, marginLeft: 2 }}>{loc}</span>}
                          </div>
                        );
                      })}
                      {absences.map(ab => {
                        const c = absenceColor(ab.type);
                        return (
                          <div key={ab.id} title={`${ab.name}｜${absenceLabel(ab.type)}${ab.location ? `［${ab.location}］` : ''}`}
                            style={{ fontSize: 11, borderRadius: 4, padding: '2px 4px', marginBottom: 2, background: c.bg, color: c.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {ab.name}{ab.location && <span style={{ fontSize: 9, opacity: 0.75, marginLeft: 2 }}>{ab.location}</span>}
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

// ===== スマホ用カレンダー（グリッドのみ） =====
const SpCalendar: React.FC<{
  year: number; month: number;
  eventsByDate: Record<string, LeaveEvent[]>;
  absencesByDate: Record<string, AbsenceEvent[]>;
  calendarKinds: Record<string, CalendarKind>;
  isDark: boolean;
  onDateTap?: (date: string) => void;
}> = ({ year, month, eventsByDate, absencesByDate, calendarKinds, isDark, onDateTap }) => {
  const today = new Date();
  const todayStr = fmt(today.getFullYear(), today.getMonth(), today.getDate());
  const subColor = isDark ? '#adb5bd' : '#888';
  const textColor = isDark ? '#fff' : '#333';

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDow = new Date(year, month, 1).getDay(); // 日曜=0始まり
  const cells: { date: string | null; day: number | null; dow: number }[] = [];
  for (let i = 0; i < firstDow; i++) cells.push({ date: null, day: null, dow: i });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ date: fmt(year, month, d), day: d, dow: (firstDow + d - 1) % 7 });
  while (cells.length % 7 !== 0) cells.push({ date: null, day: null, dow: cells.length % 7 });
  const rows: typeof cells[] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          {WEEKDAYS.map((w, i) => (
            <th key={w} style={{ textAlign: 'center', fontSize: 11, padding: '4px 0', color: i === 0 ? '#e74c3c' : i === 6 ? '#4a90d9' : subColor, fontWeight: 'normal' }}>{w}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri}>
            {row.map((cell, ci) => {
              const isSun = ci === 0, isSat = ci === 6;
              const isToday = cell.date === todayStr;
              const events = cell.date ? (eventsByDate[cell.date] || []) : [];
              const absences = cell.date ? (absencesByDate[cell.date] || []) : [];
              const hasRed = events.length > 0 || absences.some(a => a.type === 'absent');
              const hasOrange = absences.some(a => a.type === 'late' || a.type === 'early_leave');
              const hasGreen = absences.some(a => a.type === 'late_start' || a.type === 'early_end');
              // 休日出勤・勤務地変更は「出勤している」＝不在系と意味が違うので別色にする
              const hasTeal = absences.some(a => a.type === 'holiday_work');
              const hasPurple = absences.some(a => a.type === 'location_change');
              const hasGraphite = absences.some(a => a.type === 'time_change');
              const ck = cell.date ? calendarKinds[cell.date] : undefined;
              const cs = ck ? CALENDAR_CELL_STYLE[ck] : null;
              return (
                <td key={ci}
                  onClick={() => cell.date && onDateTap?.(cell.date)}
                  style={{ textAlign: 'center', padding: '3px 1px', cursor: cell.date && onDateTap ? 'pointer' : 'default' }}>
                  <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', width: 30, borderRadius: 6, background: cs ? cs.bg : isToday ? (isDark ? '#2c3e50' : '#e8f4fd') : 'transparent', padding: '2px 0' }}>
                    <span style={{ fontSize: 13, fontWeight: isToday ? 'bold' : 'normal', color: cs ? cs.text : isSat ? '#4a90d9' : isSun ? '#e74c3c' : cell.day ? textColor : (isDark ? '#555' : '#ccc') }}>
                      {cell.day ?? ''}
                    </span>
                    {/* 休館日は日付の下に2文字だけ。丸印がある日は、その下に並ぶ */}
                    {cs && <span style={{ fontSize: 8, lineHeight: 1.2, color: cs.text, fontWeight: 'bold' }}>{cs.short}</span>}
                    {(hasRed || hasOrange || hasGreen || hasTeal || hasPurple || hasGraphite) && (
                      <div style={{ display: 'flex', gap: 1, marginTop: 1, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 28 }}>
                        {hasRed && <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#dc3545' }} />}
                        {hasOrange && <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#ff9800' }} />}
                        {hasGreen && <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#43a047' }} />}
                        {hasTeal && <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#0f766e' }} />}
                        {hasPurple && <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#6d28d9' }} />}
                        {hasGraphite && <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#374151' }} />}
                      </div>
                    )}
                  </div>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

// ===== メインコンポーネント =====
const CalendarPage: React.FC<Props> = ({ user, roleTitle, isAdmin, isApprover }) => {
  const isDark = useDarkMode();
  // 会社カレンダー（休館日・出勤日）。カレンダーのセルに敷いて、休館日が一目で分かるようにする
  const calendarKinds = useCompanyCalendar();
  const bg = isDark ? '#343a40' : '#fff';
  const textColor = isDark ? '#fff' : '#333';
  const subColor = isDark ? '#adb5bd' : '#888';
  const borderColor = isDark ? '#495057' : '#eee';

  // 🚨 URLは毎回読み直す。同じページを開いたまま通知をタップしても画面は作り直されないため、
  // 開いた瞬間の1回だけの読み取りだと ?focus= が変わったことに気づけない
  const [searchParams] = useSearchParams();
  const viewParam = searchParams.get('view');
  // 受理FYIのバナー（view=fyi）から来た上長は、該当スタッフを確実に表示するため全チーム表示にする
  const defaultGroup = (viewParam === 'fyi' || isAdmin || roleTitle === '社長') ? 'all' : 'mine';
  const CALENDAR_GROUPS = ['こども', '大人', '管理部'];

  const today = new Date();
  // バナー等から ?focus=YYYY-MM-DD で来たら、その月を開き該当行を強調する
  const focusParam = searchParams.get('focus');
  const focusDate = focusParam && /^\d{4}-\d{2}-\d{2}$/.test(focusParam) ? focusParam : null;
  const [year, setYear] = useState(focusDate ? Number(focusDate.slice(0, 4)) : today.getFullYear());
  const [month, setMonth] = useState(focusDate ? Number(focusDate.slice(5, 7)) - 1 : today.getMonth());
  const [highlightDate, setHighlightDate] = useState<string | null>(focusDate);
  // 同じページにいるまま通知をタップされたときも、その月を開き直して該当行を強調する
  useEffect(() => {
    if (!focusDate) return;
    setYear(Number(focusDate.slice(0, 4)));
    setMonth(Number(focusDate.slice(5, 7)) - 1);
    setHighlightDate(focusDate);
  }, [focusDate]);
  const focusRowRef = React.useRef<HTMLDivElement | null>(null);
  const [groupMode, setGroupMode] = useState<string>(defaultGroup);
  const [events, setEvents] = useState<LeaveEvent[]>([]);
  const [absences, setAbsences] = useState<AbsenceEvent[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<AbsenceEvent | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [profiles, setProfiles] = useState<ProfileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [absenceSheet, setAbsenceSheet] = useState<string | null>(null);
  const [workplaces, setWorkplaces] = useState<string[]>([]);
  const [absenceSaved, setAbsenceSaved] = useState(false);
  const [absenceDeleted, setAbsenceDeleted] = useState(false);
  const [gcalDeleteFailed, setGcalDeleteFailed] = useState(false);
  const [monthSummary, setMonthSummary] = useState<{ year: number; month: number; days: number }[]>([]);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 600);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 600);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const getTargetUserIds = useCallback(async (allUserIds: string[]): Promise<string[]> => {
    if (groupMode === 'all') return allUserIds;
    const { data: groupProfiles } = await supabase
      .from('profiles').select('id')
      .overlaps('group_names', [groupMode])
      .in('id', allUserIds);
    const ids = new Set((groupProfiles || []).map((p: { id: string }) => p.id));
    return allUserIds.filter(id => ids.has(id));
  }, [groupMode]);

  const fetchSummary = useCallback(async () => {
    const months: { year: number; month: number; days: number }[] = [];
    const startM = new Date(today.getFullYear(), today.getMonth(), 1);
    const endM = new Date(today.getFullYear(), today.getMonth() + 5, 1);
    const rangeStart = `${startM.getFullYear()}-${String(startM.getMonth() + 1).padStart(2, '0')}-01`;
    const endDate = new Date(endM.getFullYear(), endM.getMonth() + 1, 0);
    const rangeEnd = `${endM.getFullYear()}-${String(endM.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;

    const [{ data: leaves }, { data: absenceData }] = await Promise.all([
      supabase.from('leave_requests').select('user_id, leave_dates, start_date, end_date, status').not('status', 'in', '("rejected","cancelled")').or(`and(start_date.lte.${rangeEnd},end_date.gte.${rangeStart})`),
      supabase.from('attendance_exceptions').select('user_id, date, type').gte('date', rangeStart).lte('date', rangeEnd).eq('type', 'absent'),
    ]);

    const allUserIds = [...new Set([
      ...(leaves || []).map((l: { user_id: string }) => l.user_id),
      ...(absenceData || []).map((a: { user_id: string }) => a.user_id),
    ])] as string[];
    const targetIds = new Set(allUserIds.length > 0 ? await getTargetUserIds(allUserIds) : []);

    for (let i = 0; i < 6; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
      const y = d.getFullYear(), m = d.getMonth();
      const mStart = `${y}-${String(m + 1).padStart(2, '0')}-01`;
      const mEndDate = new Date(y, m + 1, 0);
      const mEnd = `${y}-${String(m + 1).padStart(2, '0')}-${String(mEndDate.getDate()).padStart(2, '0')}`;

      let dayCount = 0;
      for (const l of (leaves || [])) {
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
      // 欠勤（全欠勤）も加算
      dayCount += (absenceData || []).filter((a: { user_id: string; date: string }) =>
        targetIds.has(a.user_id) && a.date >= mStart && a.date <= mEnd
      ).length;
      months.push({ year: y, month: m, days: dayCount });
    }
    setMonthSummary(months);
  }, [groupMode, getTargetUserIds]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const startStr = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      const endDate = new Date(year, month + 1, 0);
      const endStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;

      const { data: leaves } = await supabase
        .from('leave_requests')
        .select('id, user_id, leave_type, leave_type_other, leave_dates, leave_locations, start_date, end_date, status, purpose, reason')
        .not('status', 'in', '("rejected","cancelled")')
        .or(`and(start_date.lte.${endStr},end_date.gte.${startStr})`);

      if (!leaves || leaves.length === 0) { setEvents([]); return; }

      let userIds = [...new Set(leaves.map((l: { user_id: string }) => l.user_id))] as string[];
      userIds = await getTargetUserIds(userIds);

      const { data: profs } = await supabase.from('profiles').select('id, name').in('id', userIds);
      const profileMap: Record<string, string> = {};
      (profs || []).forEach((p: { id: string; name: string }) => { profileMap[p.id] = p.name; });

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
        // 日付→校の対応表（校なしの既存申請・JSON破損はundefinedのまま）
        let locations: Record<string, string> | undefined;
        try { if (l.leave_locations) locations = JSON.parse(l.leave_locations); } catch { locations = undefined; }
        if (dates.length > 0) {
          result.push({ id: l.id, user_id: l.user_id, name, leave_type: l.leave_type, leave_type_other: l.leave_type_other, dates, status: l.status, locations, purpose: l.purpose, reason: l.reason });
        }
      }
      setEvents(result);
    } finally {
      setLoading(false);
    }
  }, [year, month, groupMode, getTargetUserIds]);

  const fetchAbsences = useCallback(async () => {
    const startStr = `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const endDate = new Date(year, month + 1, 0);
    const endStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;

    const { data } = await supabase
      .from('attendance_exceptions')
      .select('id, user_id, date, type, actual_time, notes, location, work_segments, original_location')
      .gte('date', startStr)
      .lte('date', endStr)
      .order('date');

    if (!data || data.length === 0) { setAbsences([]); return; }

    const userIds = [...new Set(data.map((a: { user_id: string }) => a.user_id))] as string[];
    const { data: profs } = await supabase.from('profiles').select('id, name').in('id', userIds);
    const profileMap: Record<string, string> = {};
    (profs || []).forEach((p: { id: string; name: string }) => { profileMap[p.id] = p.name; });

    setAbsences(data.map((a: { id: string; user_id: string; date: string; type: AttendanceType; actual_time: string | null; notes: string | null; location: string | null; original_location: string | null; work_segments: unknown }) => ({
      ...a, name: profileMap[a.user_id] || '不明', work_segments: parseSegments(a.work_segments),
    })));
  }, [year, month]);

  useEffect(() => { fetchEvents(); fetchAbsences(); }, [fetchEvents, fetchAbsences]);

  // ?focus= で来たとき：一覧の該当行までスクロールし、数秒後にハイライトを消す
  useEffect(() => {
    if (!highlightDate || loading) return;
    const t1 = setTimeout(() => focusRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
    const t2 = setTimeout(() => setHighlightDate(null), 6000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [highlightDate, loading, absences, events]);

  useEffect(() => {
    if (!isApprover && !isAdmin) return;
    supabase.from('profiles').select('id, name, role_title, employment_type, group_names').eq('is_active', true).neq('role_title', '管理者').then(({ data }) => {
      if (data) setProfiles(data.map((p: { id: string; name: string; role_title: string; employment_type: string; group_names: string | string[] }) => ({
        ...p,
        group_names: Array.isArray(p.group_names) ? p.group_names : (typeof p.group_names === 'string' ? JSON.parse(p.group_names) : []),
      })));
    });
    // 欠勤入力の校ドロップダウン用（勤務変更報告と同じ勤務地マスタ）
    supabase.from('master_options').select('value').eq('category', 'workplace').order('sort_order')
      .then(({ data }) => { if (data) setWorkplaces(data.map((r: { value: string }) => r.value)); });
    // 更新・別アプリ移動でシートが閉じても、入力途中の下書きがあればシートを開き直す
    const absDraft = loadDraft<AbsenceDraft>(DRAFT_KEYS.attendance);
    if (absDraft?.date) setAbsenceSheet(absDraft.date);
  }, [isApprover, isAdmin]);

  const eventsByDate: Record<string, LeaveEvent[]> = {};
  for (const ev of events) {
    for (const d of ev.dates) {
      if (!eventsByDate[d]) eventsByDate[d] = [];
      eventsByDate[d].push(ev);
    }
  }

  const absencesByDate: Record<string, AbsenceEvent[]> = {};
  for (const ab of absences) {
    if (!absencesByDate[ab.date]) absencesByDate[ab.date] = [];
    absencesByDate[ab.date].push(ab);
  }

  type ListRow =
    | { kind: 'leave'; date: string; ev: LeaveEvent }
    | { kind: 'absence'; date: string; ab: AbsenceEvent };

  const allDates = new Set([...Object.keys(eventsByDate), ...Object.keys(absencesByDate)]);
  const monthListRows: ListRow[] = [];
  for (const date of [...allDates].sort()) {
    for (const ev of (eventsByDate[date] || [])) monthListRows.push({ kind: 'leave', date, ev });
    for (const ab of (absencesByDate[date] || [])) monthListRows.push({ kind: 'absence', date, ab });
  }

  const prevMonth = () => { if (month === 0) { setYear(y => y - 1); setMonth(11); } else setMonth(m => m - 1); };
  const nextMonth = () => { if (month === 11) { setYear(y => y + 1); setMonth(0); } else setMonth(m => m + 1); };

  const btnStyle = { background: isDark ? '#495057' : '#f0f4ff', border: 'none', borderRadius: 8, width: 32, height: 32, fontSize: 16, cursor: 'pointer', color: '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, padding: 0 } as const;

  const canInput = isApprover || isAdmin;

  /**
   * 勤怠の取消。
   * reuse=true のときは、取消したうえで同じ内容を入力シートに引き継いで開く
   * （＝「取消してこの内容を利用して入力する」）。DBは常に「登録か取消」の2状態だけになる。
   */
  const handleDelete = async (reuse = false) => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleting(true);
    await supabase.from('attendance_exceptions').delete().eq('id', target.id);
    // invoke は 4xx/5xx でも throw しないので error を必ず見る（見ないと削除失敗が誰にも見えない）
    const { data: syncRes, error: syncErr } = await supabase.functions.invoke('gcal-sync', {
      body: { action: 'delete', source_type: 'absence', source_id: target.id },
    });
    const sr = syncRes as { success?: boolean } | null;
    if (syncErr || sr?.success === false) {
      console.error('[gcal-sync] 勤怠の削除失敗:', syncErr);
      setGcalDeleteFailed(true);
    }
    // 取消したことをリーダー以上へ通知（通知設定 attendance:cancelled に従う）。
    // 通知を出さないと、共有カレンダーから予定が黙って消えるだけで経緯が誰にも伝わらない
    const { error: notifyErr } = await supabase.functions.invoke('attendance-notify', {
      body: { user_id: target.user_id, user_name: target.name, dates: [target.date], types: [target.type], mode: 'cancelled' },
    });
    if (notifyErr) console.error('[attendance-notify] 取消通知の送信失敗:', notifyErr);

    setDeleting(false);
    setDeleteTarget(null);
    fetchAbsences();
    if (reuse) {
      // 入力シートは開いた日付の下書きを復元する作りなので、下書きに書いてから開く
      saveDraft(DRAFT_KEYS.attendance, absenceToDraft(target, workplaces));
      setAbsenceSheet(target.date);
    } else {
      setAbsenceDeleted(true);
    }
  };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>

      <h1 style={{ margin: '28px 0 16px', fontSize: 20, fontWeight: 800, color: textColor, letterSpacing: '0.04em', lineHeight: 1.2 }}>📅 勤怠カレンダー</h1>

      {/* このページの説明 */}
      <div style={{
        background: '#fff3cd',
        border: '1px solid #ffe0a3',
        borderRadius: 8, padding: '12px 14px', marginBottom: 16, textAlign: 'left',
        position: 'relative', // 右上のFAQボタンの基準
      }}>
        <HelpLinkButton category="勤怠カレンダー" />
        <p style={{ fontSize: 13, fontWeight: 'bold', color: '#856404', textAlign: 'center', margin: '0 0 10px' }}>【リーダー・マネージャー専用】</p>
        {[
          'スタッフの休み・出勤予定を一覧で確認できます',
          '欠勤・遅刻・早退・休日出勤の入力ができます',
        ].map((text, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '0 0 6px' }}>
            <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: '50%', background: '#4a90d9', color: '#fff', fontSize: 13, fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
            <span style={{ fontSize: 14, fontWeight: 'bold', color: '#664d03', lineHeight: '22px' }}>{text}</span>
          </div>
        ))}
        <p style={{ fontSize: 12, color: '#856404', lineHeight: 1.8, margin: '8px 0 0' }}>※Googleカレンダーに自動登録されます。</p>
        <p style={{ fontSize: 12, color: '#856404', lineHeight: 1.8, margin: 0 }}>※有給の申請はできません。</p>
        <p style={{ fontSize: 12, color: '#856404', lineHeight: 1.8, margin: 0 }}>※ここでの登録は予定の共有用です。給与に関わる勤務時間の報告は「勤務変更」で行います。</p>
      </div>

      {/* 直近6ヶ月サマリー */}
      <div style={{ background: bg, borderRadius: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.08)', padding: isMobile ? 14 : 20, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 'bold', color: subColor, marginBottom: 12 }}>直近6ヶ月の休暇・欠勤日数</div>
        <div style={{ display: 'flex', gap: isMobile ? 6 : 12, flexWrap: 'wrap' }}>
          {monthSummary.map(({ year: y, month: m, days }) => {
            const isCurrentView = y === year && m === month;
            return (
              <button key={`${y}-${m}`} onClick={() => { setYear(y); setMonth(m); }}
                style={{ flex: 1, minWidth: isMobile ? 44 : 70, padding: isMobile ? '8px 4px' : '10px 8px', borderRadius: 10, border: isCurrentView ? '2px solid #4a90d9' : `1px solid ${borderColor}`, background: isCurrentView ? (isDark ? '#1a3a5c' : '#e8f4fd') : (isDark ? '#2a2f35' : '#f8f9ff'), cursor: 'pointer', textAlign: 'center' }}>
                <div style={{ fontSize: isMobile ? 11 : 12, color: subColor, marginBottom: 4 }}>{m + 1}月</div>
                <div style={{ fontSize: isMobile ? 18 : 22, fontWeight: 'bold', color: isCurrentView ? '#4a90d9' : textColor }}>{days}</div>
                <div style={{ fontSize: 10, color: subColor }}>日</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* カレンダー */}
      <div style={{ background: bg, borderRadius: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.08)', padding: isMobile ? 16 : 20, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={prevMonth} style={btnStyle}>‹</button>
            <span style={{ fontSize: isMobile ? 15 : 18, fontWeight: 'bold', color: textColor, minWidth: 110, textAlign: 'center' }}>{year}年 {month + 1}月</span>
            <button onClick={nextMonth} style={btnStyle}>›</button>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {loading && <span style={{ fontSize: 12, color: subColor }}>読み込み中...</span>}
            <select value={groupMode} onChange={e => setGroupMode(e.target.value)}
              style={{ padding: '6px 10px', border: `2px solid #4a90d9`, borderRadius: 8, fontSize: 13, color: '#4a90d9', background: isDark ? '#495057' : '#f0f4ff', cursor: 'pointer' }}>
              <option value="all">全チーム</option>
              {CALENDAR_GROUPS.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
        </div>

        {/* 凡例 */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12, fontSize: 12, color: subColor }}>
          {[
            { label: '有給（受理）', bg: '#d5f5e3' },
            { label: '調整休（受理）', bg: '#f4ecf7' },
            { label: '慶弔・その他', bg: '#fdedec' },
            { label: '申請中', bg: '#fef9e7', border: '#f39c12' },
            { label: '全欠勤', bg: '#fde8e8' },
            { label: '遅刻', bg: '#ff9800' },
            { label: '早退', bg: '#1565c0' },
            { label: '遅出(調整)', bg: '#558b2f' },
            { label: '早退(調整)', bg: '#7b1fa2' },
            { label: '休日出勤', bg: '#0f766e' },
            { label: '勤務地変更', bg: '#6d28d9' },
            { label: '勤務時間変更', bg: '#374151' },
            // 会社カレンダー。日ごとの予定ではなく「その日の会社の状態」なので最後に置く
            { label: '休館日（全社員休み）', bg: CALENDAR_CELL_STYLE.closed_all.bg },
            { label: '休館日（社員出勤日）', bg: CALENDAR_CELL_STYLE.work_on_closed.bg },
          ].map(({ label, bg: cbg, border }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 12, height: 12, borderRadius: 3, background: cbg, border: border ? `1px dashed ${border}` : 'none' }} />
              {label}
            </div>
          ))}
        </div>

        {(canInput || isMobile) && (
          <div style={{ fontSize: 12, color: isDark ? '#fff' : '#4a90d9', marginBottom: 12, padding: '6px 10px', background: isDark ? '#1a3a5c' : '#e8f4fd', borderRadius: 6 }}>
            {canInput && <div>📅 日付をタップして勤怠を入力できます</div>}
            {isMobile && <div style={canInput ? { marginTop: 4 } : undefined}>💡 スマホを横向きにすると、休暇・勤怠の名前が表示されます</div>}
          </div>
        )}

        {isMobile ? (
          <SpCalendar year={year} month={month} eventsByDate={eventsByDate} absencesByDate={absencesByDate} calendarKinds={calendarKinds} isDark={isDark} onDateTap={canInput ? d => setAbsenceSheet(d) : undefined} />
        ) : (
          <PcCalendar year={year} month={month} eventsByDate={eventsByDate} absencesByDate={absencesByDate} calendarKinds={calendarKinds} isDark={isDark} onDateTap={canInput ? d => setAbsenceSheet(d) : undefined} />
        )}
      </div>

      {/* 月別リスト */}
      <div style={{ background: bg, borderRadius: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.08)', padding: isMobile ? 14 : 20 }}>
        <div style={{ fontSize: 14, fontWeight: 'bold', color: textColor, marginBottom: 12 }}>
          {year}年 {month + 1}月 の休暇・勤怠一覧
        </div>
        {monthListRows.length === 0 ? (
          <div style={{ textAlign: 'center', color: subColor, fontSize: 13, padding: '16px 0' }}>
            この月のデータはありません
          </div>
        ) : (
          <div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: isMobile ? '64px 1fr 52px 44px 56px 42px' : '100px 1fr 80px 70px 90px 60px',
              gap: 6, padding: '6px 8px', fontSize: 11, color: subColor,
              borderBottom: `1px solid ${borderColor}`, marginBottom: 4,
            }}>
              <span>日付</span><span>名前</span><span>種別</span><span>時間</span><span style={{ textAlign: 'center' }}>校</span><span style={{ textAlign: 'right' }}>状態</span>
            </div>
            {monthListRows.map((row, i) => {
              const d = parseInt(row.date.split('-')[2]);
              const gridCols = isMobile ? '64px 1fr 52px 44px 56px 42px' : '100px 1fr 80px 70px 90px 60px';
              if (row.kind === 'leave') {
                const { ev } = row;
                const isPending = ev.status === 'pending' || ev.status === 'step2_pending';
                const c = getEventColor(ev);
                // 理由の2行目：調整休のみ「振替休日：〇〇のため」形式で表示。
                // 他の休暇の事由はプライバシー配慮で全スタッフ向けのこの一覧には出さない（管理画面では見られる）
                // ただし有給奨励日由来の申請（reason='【有給奨励日】'）は会社が指定した日なので明示する
                const choseiNote = ev.leave_type === '調整休'
                  ? `${ev.reason?.startsWith('振替休日') ? '振替休日' : '時間外調整休'}${ev.purpose ? `：${ev.purpose}` : ''}`
                  : (ev.reason?.includes('【有給奨励日】') || ev.purpose === '有給奨励日')
                    ? '📅 有給奨励日'
                    : null;
                const isFocused = highlightDate === row.date;
                return (
                  <div key={`l-${ev.id}-${row.date}-${i}`} ref={isFocused ? focusRowRef : undefined} style={{ borderBottom: `1px solid ${borderColor}`, background: isFocused ? (isDark ? '#4a4423' : '#fff9c4') : 'transparent', transition: 'background 0.6s' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 6, padding: '7px 8px', fontSize: isMobile ? 13 : 14, alignItems: 'center' }}>
                      <span style={{ color: subColor, fontSize: isMobile ? 11 : 13 }}>{month + 1}/{d}（{dow(row.date)}）</span>
                      <span style={{ fontWeight: 'bold', color: textColor }}>{ev.name}</span>
                      <span style={{ fontSize: 11, padding: '2px 5px', borderRadius: 4, background: c.bg, color: c.text, border: isPending ? `1px dashed ${'border' in c ? c.border : c.text}` : 'none', textAlign: 'center' }}>
                        {shortType(ev)}
                      </span>
                      <span style={{ fontSize: 12, color: subColor, textAlign: 'center' }}>—</span>
                      <span style={{ fontSize: 11, color: subColor, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ev.locations?.[row.date] ?? '—'}
                      </span>
                      <span style={{ fontSize: 11, textAlign: 'right', color: isPending ? '#b7770d' : '#1e8449', fontWeight: 'bold' }}>
                        {STATUS_LABEL[ev.status] || ev.status}
                      </span>
                    </div>
                    {choseiNote && (
                      <div style={{ padding: '0 8px 7px', fontSize: 11, color: subColor, lineHeight: 1.5 }}>{choseiNote}</div>
                    )}
                  </div>
                );
              } else {
                const { ab } = row;
                const c = absenceColor(ab.type);
                // 時間帯が複数ある場合、44px幅の列に全部は入らないので先頭の開始時刻だけ出し、
                // 全体は下の行（勤務：09:00〜12:00［四条本校］/ …）に出す
                const segs = ab.work_segments;
                const timeLabel = segs.length > 0
                  ? hhmm(segs[0].start)
                  : (ab.actual_time ? hhmm(ab.actual_time) : '—');
                const locLabel = segs.length > 1
                  ? `${new Set(segs.map(s => s.location).filter(Boolean)).size}校`
                  : (ab.location ?? '—');
                const isFocused = highlightDate === row.date;
                return (
                  <div key={`a-${ab.id}-${i}`} ref={isFocused ? focusRowRef : undefined} style={{ borderBottom: `1px solid ${borderColor}`, background: isFocused ? (isDark ? '#4a4423' : '#fff9c4') : 'transparent', transition: 'background 0.6s' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 6, padding: '7px 8px', fontSize: isMobile ? 13 : 14, alignItems: 'center' }}>
                      <span style={{ color: subColor, fontSize: isMobile ? 11 : 13 }}>{month + 1}/{d}（{dow(row.date)}）</span>
                      <span style={{ fontWeight: 'bold', color: textColor }}>{ab.name}</span>
                      <span style={{ fontSize: 11, padding: '2px 5px', borderRadius: 4, background: c.bg, color: c.text, textAlign: 'center' }}>
                        {absenceLabel(ab.type)}
                      </span>
                      <span style={{ fontSize: 12, color: textColor, textAlign: 'center', fontWeight: (ab.actual_time || segs.length > 0) ? 'bold' : 'normal' }}>
                        {timeLabel}
                      </span>
                      <span style={{ fontSize: 11, color: subColor, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {locLabel}
                      </span>
                      <span style={{ fontSize: 11, textAlign: 'right', color: subColor }}>
                        {canInput && (
                          <button onClick={() => setDeleteTarget(ab)} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px solid #dc3545', background: 'transparent', color: '#dc3545', cursor: 'pointer' }}>
                            取消
                          </button>
                        )}
                      </span>
                    </div>
                    {/* 勤務地変更は変更前も分かるように出す（上の校の列は変更後のみ） */}
                    {ab.original_location && (
                      <div style={{ padding: '0 8px 7px', fontSize: 11, color: subColor, lineHeight: 1.5 }}>勤務地：{ab.original_location} → {ab.location ?? ''}</div>
                    )}
                    {/* 勤務時間帯（校の移動がある場合）。上の列は幅が狭く入りきらないためここに全部出す */}
                    {segs.length > 0 && (
                      <div style={{ padding: '0 8px 7px', fontSize: 11, color: subColor, lineHeight: 1.5 }}>勤務：{formatSegments(segs)}</div>
                    )}
                    {/* 備考（勤怠入力・時間調整の備考。了承者名を含む）。入力がある場合のみ */}
                    {ab.notes && (
                      <div style={{ padding: '0 8px 7px', fontSize: 11, color: subColor, lineHeight: 1.5 }}>理由：{ab.notes}</div>
                    )}
                  </div>
                );
              }
            })}
          </div>
        )}
      </div>

      {/* 取消確認モーダル */}
      {deleteTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 340 }}>
            <div style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 16, color: '#dc3545' }}>取消の確認</div>
            <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, padding: 12, marginBottom: 20, fontSize: 14, color: '#333' }}>
              <div><strong>{deleteTarget.name}</strong></div>
              {/* 日付は入力画面と同じ「7/31（金）」で出す（生の2026-07-31だと確認しづらいため） */}
              <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span>{parseInt(deleteTarget.date.slice(5, 7))}/{parseInt(deleteTarget.date.slice(8, 10))}（{dow(deleteTarget.date)}）</span>
                <span style={{ fontSize: 11, fontWeight: 'bold', padding: '2px 8px', borderRadius: 5, background: absenceColor(deleteTarget.type).bg, color: absenceColor(deleteTarget.type).text }}>
                  {absenceEmoji(deleteTarget.type)} {absenceLabel(deleteTarget.type)}
                </span>
                {deleteTarget.actual_time && <span>{hhmm(deleteTarget.actual_time)}</span>}
              </div>
              {deleteTarget.work_segments.length > 0 && (
                <div style={{ marginTop: 4, fontSize: 13, color: '#666' }}>勤務：{formatSegments(deleteTarget.work_segments)}</div>
              )}
              {deleteTarget.notes && <div style={{ marginTop: 4, fontSize: 13, color: '#666' }}>備考：{deleteTarget.notes}</div>}
            </div>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 16, lineHeight: 1.7 }}>
              取消すとGoogleカレンダーからも消え、リーダー・マネージャーに取消の通知が届きます。<br />
              内容を直したい場合は、下の「取消してこの内容を利用して入力する」を選ぶと、
              入力画面に元の内容が入った状態で開きます。
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button onClick={() => handleDelete(false)} disabled={deleting} style={{ width: '100%', padding: 12, background: '#dc3545', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 'bold', cursor: deleting ? 'not-allowed' : 'pointer', opacity: deleting ? 0.7 : 1 }}>
                {deleting ? '処理中...' : '取消す'}
              </button>
              <button onClick={() => handleDelete(true)} disabled={deleting} style={{ width: '100%', padding: 12, background: 'transparent', color: '#495057', border: '1px solid #adb5bd', borderRadius: 10, fontSize: 14, cursor: deleting ? 'not-allowed' : 'pointer', opacity: deleting ? 0.7 : 1, lineHeight: 1.5 }}>
                取消してこの内容を利用して入力する
              </button>
              <button onClick={() => setDeleteTarget(null)} disabled={deleting} style={{ width: '100%', padding: 10, background: 'none', color: '#6c757d', border: 'none', fontSize: 14, cursor: 'pointer' }}>
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 欠勤削除完了バナー */}
      {absenceDeleted && !gcalDeleteFailed && <CalendarResultModal type="delete" onClose={() => setAbsenceDeleted(false)} />}
      {/* Googleカレンダーからの削除だけ失敗した場合（アプリ上は消えているので✕で閉じられる形にする） */}
      {gcalDeleteFailed && (
        <div style={{ position: 'fixed', top: 70, left: '50%', transform: 'translateX(-50%)', zIndex: 9999, background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '10px 14px', maxWidth: 420, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, color: '#842029', lineHeight: 1.6 }}>
            取消しましたが、Googleカレンダーからの削除に失敗しました。カレンダーを確認してください。
          </span>
          <button onClick={() => { setGcalDeleteFailed(false); setAbsenceDeleted(false); }}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#842029', cursor: 'pointer', fontSize: 15 }}>✕</button>
        </div>
      )}

      {/* 欠勤登録完了バナー */}
      {absenceSaved && <CalendarResultModal type="save" onClose={() => setAbsenceSaved(false)} />}

      {/* 欠勤入力ボトムシート */}
      {absenceSheet && user && (
        <AbsenceInputSheet
          date={absenceSheet}
          profiles={profiles}
          currentUserId={user.id}
          workplaces={workplaces}
          onClose={() => setAbsenceSheet(null)}
          onSaving={() => { setAbsenceSaved(true); }}
          onSaved={() => { fetchAbsences(); }}
        />
      )}
    </div>
  );
};

export default CalendarPage;
