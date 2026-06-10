import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import type { AuthUser } from '../types';

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
}

interface AbsenceEvent {
  id: string;
  user_id: string;
  name: string;
  date: string;
  type: 'late' | 'early_leave' | 'absent' | 'late_start' | 'early_end';
  actual_time: string | null;
  notes: string | null;
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

const ABSENCE_LABEL: Record<string, string> = {
  absent:      '全欠勤',
  late:        '遅刻',
  early_leave: '早退',
  late_start:  '遅出',
  early_end:   '早退(残業調整)',
};

const ABSENCE_COLOR: Record<string, { bg: string; text: string }> = {
  absent:      { bg: '#fde8e8', text: '#c0392b' },
  late:        { bg: '#ff9800', text: '#fff' },
  early_leave: { bg: '#e3f2fd', text: '#1565c0' },
  late_start:  { bg: '#8bc34a', text: '#fff' },
  early_end:   { bg: '#e1bee7', text: '#6a1b9a' },
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
  userId: string;
  onSelect: (id: string) => void;
}> = ({ profiles, grouped, userId, onSelect }) => {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const selectedProfile = profiles.find(p => p.id === userId);
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
      {/* 選択済み表示 */}
      {selectedProfile && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: '#eaf4ff', border: `2px solid ${ACCENT}`, borderRadius: 8, marginBottom: 10 }}>
          <span style={{ fontWeight: 'bold', fontSize: 15, color: '#1a5fa8' }}>✓ {selectedProfile.name}</span>
          <button onClick={() => { onSelect(''); setActiveKey(null); }}
            style={{ background: 'none', border: 'none', color: '#888', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>×</button>
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

      {/* 名前リスト（パートの下に展開、選択後に閉じる） */}
      {activeKey && (
        <div style={{ marginTop: 4, border: '1px solid #d0d0d0', borderRadius: 8, overflow: 'hidden' }}>
          {activeMembers.map((p, i) => (
            <div key={p.id} onClick={() => { onSelect(p.id); setActiveKey(null); }}
              style={{ padding: '7px 14px', cursor: 'pointer', fontSize: 14, background: p.id === userId ? ACCENT : i % 2 === 0 ? '#fff' : '#fafafa', color: p.id === userId ? '#fff' : '#222', fontWeight: p.id === userId ? 'bold' : 'normal', borderBottom: '1px solid #ececec' }}>
              {p.name}
            </div>
          ))}
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
  const today = new Date();
  const [calYear, setCalYear] = useState(today.getFullYear());
  const [calMonth, setCalMonth] = useState(today.getMonth());

  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const firstDow = (new Date(calYear, calMonth, 1).getDay() + 6) % 7;
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
              <th key={w} style={{ fontSize: 11, padding: '4px 0', color: i === 5 ? '#4a90d9' : i === 6 ? '#e74c3c' : '#888', fontWeight: 'normal', textAlign: 'center' }}>{w}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((date, ci) => {
                const selected = date ? selectedDates.has(date) : false;
                const isSat = ci === 5, isSun = ci === 6;
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
      {selectedDates.size > 0 && (
        <div style={{ padding: '6px 10px', background: '#fff5f5', fontSize: 12, color: '#c0392b', borderTop: '1px solid #f0c0c0' }}>
          選択中: {[...selectedDates].sort().map(d => `${parseInt(d.slice(5, 7))}/${parseInt(d.slice(8))}`).join('、')}
        </div>
      )}
    </div>
  );
};

// ===== 欠勤入力ボトムシート =====
const AbsenceInputSheet: React.FC<{
  date: string;
  profiles: ProfileEntry[];
  currentUserId: string;
  onClose: () => void;
  onSaved: () => void;
}> = ({ date, profiles, currentUserId, onClose, onSaved }) => {
  const [userId, setUserId] = useState('');
  const [isAbsent, setIsAbsent] = useState(false);
  const [absentDates, setAbsentDates] = useState<Set<string>>(() => new Set([date]));
  const [isLate, setIsLate] = useState(false);
  const [isLateStart, setIsLateStart] = useState(false);
  const [isEarlyLeave, setIsEarlyLeave] = useState(false);
  const [isEarlyEnd, setIsEarlyEnd] = useState(false);
  const [lateTime, setLateTime] = useState('');
  const [earlyTime, setEarlyTime] = useState('');
  const MINUTES_5 = Array.from({ length: 12 }, (_, i) => i * 5);
  const HOURS_24 = Array.from({ length: 24 }, (_, i) => i);
  const timeH = (t: string) => t ? parseInt(t.split(':')[0], 10) : 8;
  const timeM = (t: string) => t ? parseInt(t.split(':')[1], 10) : 0;
  const toTimeStr = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const selStyle: React.CSSProperties = { padding: '4px 4px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14 };
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  const dateLabel = `${date.slice(5, 7)}月${date.slice(8, 10)}日（${dow(date)}）`;
  const grouped = buildProfileGroups(profiles);

  const toggleAbsent = (checked: boolean) => {
    setIsAbsent(checked);
    if (checked) { setIsLate(false); setIsLateStart(false); setIsEarlyLeave(false); setIsEarlyEnd(false); }
  };

  const toggleLate = (checked: boolean) => {
    if (isAbsent) return;
    setIsLate(checked);
    if (checked) setIsLateStart(false);
  };

  const toggleLateStart = (checked: boolean) => {
    if (isAbsent) return;
    setIsLateStart(checked);
    if (checked) setIsLate(false);
  };

  const toggleEarlyLeave = (checked: boolean) => {
    if (isAbsent) return;
    setIsEarlyLeave(checked);
    if (checked) setIsEarlyEnd(false);
  };

  const toggleEarlyEnd = (checked: boolean) => {
    if (isAbsent) return;
    setIsEarlyEnd(checked);
    if (checked) setIsEarlyLeave(false);
  };

  const toggleAbsentDate = (d: string) => {
    setAbsentDates(prev => {
      const next = new Set(prev);
      if (next.has(d)) { if (next.size > 1) next.delete(d); }
      else next.add(d);
      return next;
    });
  };

  const handleConfirm = () => {
    setError('');
    if (!userId) { setError('対象者を選択してください'); return; }
    if (!isAbsent && !isLate && !isLateStart && !isEarlyLeave && !isEarlyEnd) { setError('種別を選択してください'); return; }
    if ((isLate || isLateStart) && !lateTime) { setError('出勤時間を入力してください'); return; }
    if ((isEarlyLeave || isEarlyEnd) && !earlyTime) { setError('退勤時間を入力してください'); return; }
    setConfirming(true);
  };

  const handleSave = async () => {
    setSaving(true);
    const records: { user_id: string; date: string; type: string; actual_time: string | null; notes: string; created_by: string }[] = [];
    if (isAbsent) {
      for (const d of [...absentDates].sort()) {
        records.push({ user_id: userId, date: d, type: 'absent', actual_time: null, notes, created_by: currentUserId });
      }
    }
    if (isLate)       records.push({ user_id: userId, date, type: 'late',        actual_time: lateTime,  notes, created_by: currentUserId });
    if (isLateStart)  records.push({ user_id: userId, date, type: 'late_start',  actual_time: lateTime,  notes, created_by: currentUserId });
    if (isEarlyLeave) records.push({ user_id: userId, date, type: 'early_leave', actual_time: earlyTime, notes, created_by: currentUserId });
    if (isEarlyEnd)   records.push({ user_id: userId, date, type: 'early_end',   actual_time: earlyTime, notes, created_by: currentUserId });

    const { error: err } = await supabase.from('attendance_exceptions').insert(records);
    setSaving(false);
    if (err) { setError('保存に失敗しました: ' + err.message); return; }
    onSaved();
    onClose();
  };

  return (
    <div
      style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: '16px 16px 0 0', padding: '24px 20px', width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto' }}
      >
        <h3 style={{ margin: '0 0 20px', fontSize: 16, textAlign: 'center', color: '#333' }}>
          🔴 欠勤入力　{dateLabel}
        </h3>

        {/* 対象者 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>対象者</div>
          <StaffPicker profiles={profiles} grouped={grouped} userId={userId} onSelect={setUserId} />
        </div>

        {/* 種別 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>種別（複数選択可）</div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px', border: `2px solid ${isAbsent ? '#dc3545' : '#e0e0e0'}`, borderRadius: 10, marginBottom: 4, cursor: 'pointer', background: isAbsent ? '#fff5f5' : '#fff' }}>
            <input type="checkbox" checked={isAbsent} onChange={e => toggleAbsent(e.target.checked)} style={{ width: 20, height: 20, accentColor: '#dc3545' }} />
            <span style={{ fontSize: 15, fontWeight: 'bold', color: '#c0392b' }}>🔴 全欠勤</span>
            {isAbsent && <span style={{ marginLeft: 'auto', fontSize: 11, color: '#c0392b' }}>複数日選択可</span>}
          </label>

          {isAbsent && (
            <div style={{ marginBottom: 8, paddingLeft: 4 }}>
              <MultiDatePicker selectedDates={absentDates} onToggle={toggleAbsentDate} />
            </div>
          )}

          {/* 遅刻 / 調整遅出 行 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, opacity: isAbsent ? 0.4 : 1 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: `2px solid ${isLate ? '#ff9800' : '#e0e0e0'}`, borderRadius: 10, cursor: isAbsent ? 'default' : 'pointer', background: isLate ? '#fff8f0' : '#fff', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={isLate} onChange={e => toggleLate(e.target.checked)} disabled={isAbsent} style={{ width: 18, height: 18, accentColor: '#ff9800', flexShrink: 0 }} />
              <span style={{ fontSize: 14, fontWeight: 'bold', color: '#e65100' }}>🟡 遅刻</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: `2px solid ${isLateStart ? '#8bc34a' : '#e0e0e0'}`, borderRadius: 10, cursor: isAbsent ? 'default' : 'pointer', background: isLateStart ? '#f9fbe7' : '#fff', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={isLateStart} onChange={e => toggleLateStart(e.target.checked)} disabled={isAbsent} style={{ width: 18, height: 18, accentColor: '#8bc34a', flexShrink: 0 }} />
              <span style={{ fontSize: 14, fontWeight: 'bold', color: '#558b2f' }}>🟢 調整遅出</span>
            </label>
            {(isLate || isLateStart) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }} onClick={e => e.preventDefault()}>
                <span style={{ fontSize: 12, color: '#666', whiteSpace: 'nowrap' }}>出勤時間</span>
                <select value={timeH(lateTime)} onChange={e => setLateTime(toTimeStr(+e.target.value, timeM(lateTime)))} style={selStyle} onClick={e => e.stopPropagation()}>
                  {HOURS_24.map(h => <option key={h} value={h}>{String(h).padStart(2,'0')}</option>)}
                </select>
                <span style={{ fontSize: 14 }}>:</span>
                <select value={timeM(lateTime)} onChange={e => setLateTime(toTimeStr(timeH(lateTime), +e.target.value))} style={selStyle} onClick={e => e.stopPropagation()}>
                  {MINUTES_5.map(m => <option key={m} value={m}>{String(m).padStart(2,'0')}</option>)}
                </select>
              </div>
            )}
          </div>

          {/* 早退 / 調整早退 行 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, opacity: isAbsent ? 0.4 : 1 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: `2px solid ${isEarlyLeave ? '#2196f3' : '#e0e0e0'}`, borderRadius: 10, cursor: isAbsent ? 'default' : 'pointer', background: isEarlyLeave ? '#f0f8ff' : '#fff', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={isEarlyLeave} onChange={e => toggleEarlyLeave(e.target.checked)} disabled={isAbsent} style={{ width: 18, height: 18, accentColor: '#2196f3', flexShrink: 0 }} />
              <span style={{ fontSize: 14, fontWeight: 'bold', color: '#1565c0' }}>🟠 早退</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: `2px solid ${isEarlyEnd ? '#9c27b0' : '#e0e0e0'}`, borderRadius: 10, cursor: isAbsent ? 'default' : 'pointer', background: isEarlyEnd ? '#f3e5f5' : '#fff', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={isEarlyEnd} onChange={e => toggleEarlyEnd(e.target.checked)} disabled={isAbsent} style={{ width: 18, height: 18, accentColor: '#9c27b0', flexShrink: 0 }} />
              <span style={{ fontSize: 14, fontWeight: 'bold', color: '#6a1b9a' }}>🟣 調整早退</span>
            </label>
            {(isEarlyLeave || isEarlyEnd) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }} onClick={e => e.preventDefault()}>
                <span style={{ fontSize: 12, color: '#666', whiteSpace: 'nowrap' }}>退勤時間</span>
                <select value={timeH(earlyTime)} onChange={e => setEarlyTime(toTimeStr(+e.target.value, timeM(earlyTime)))} style={selStyle} onClick={e => e.stopPropagation()}>
                  {HOURS_24.map(h => <option key={h} value={h}>{String(h).padStart(2,'0')}</option>)}
                </select>
                <span style={{ fontSize: 14 }}>:</span>
                <select value={timeM(earlyTime)} onChange={e => setEarlyTime(toTimeStr(timeH(earlyTime), +e.target.value))} style={selStyle} onClick={e => e.stopPropagation()}>
                  {MINUTES_5.map(m => <option key={m} value={m}>{String(m).padStart(2,'0')}</option>)}
                </select>
              </div>
            )}
          </div>
        </div>

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
          <button onClick={onClose} style={{ flex: 1, padding: 12, background: '#6c757d', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, cursor: 'pointer' }}>
            キャンセル
          </button>
          <button onClick={handleConfirm} style={{ flex: 2, padding: 12, background: '#dc3545', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 'bold', cursor: 'pointer' }}>
            {`登録する${isAbsent && absentDates.size > 1 ? `（${absentDates.size}日）` : ''}`}
          </button>
        </div>

        {confirming && (() => {
          const personName = profiles.find(p => p.id === userId)?.name ?? '';
          const lines: string[] = [];
          if (isAbsent) [...absentDates].sort().forEach(d => lines.push(`${d}　全欠勤`));
          if (isLate)       lines.push(`${date}　遅刻　出勤 ${lateTime}`);
          if (isLateStart)  lines.push(`${date}　遅出（残業調整）　出勤 ${lateTime}`);
          if (isEarlyLeave) lines.push(`${date}　早退　退勤 ${earlyTime}`);
          if (isEarlyEnd)   lines.push(`${date}　早退（残業調整）　退勤 ${earlyTime}`);
          return (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
              <div style={{ background: '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 360 }}>
                <div style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 16 }}>登録内容の確認</div>
                <div style={{ fontSize: 14, color: '#333', marginBottom: 4 }}>対象者：<strong>{personName}</strong></div>
                <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, padding: 12, marginBottom: 16 }}>
                  {lines.map((l, i) => <div key={i} style={{ fontSize: 14, padding: '4px 0', borderBottom: i < lines.length - 1 ? '1px solid #f0f0f0' : 'none' }}>{l}</div>)}
                  {notes && <div style={{ fontSize: 13, color: '#666', marginTop: 8 }}>備考：{notes}</div>}
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={() => setConfirming(false)} style={{ flex: 1, padding: 12, background: '#6c757d', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, cursor: 'pointer' }}>
                    戻る
                  </button>
                  <button onClick={handleSave} disabled={saving} style={{ flex: 2, padding: 12, background: '#dc3545', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 'bold', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
                    {saving ? '保存中...' : '確定する'}
                  </button>
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
  isDark: boolean;
  onDateTap?: (date: string) => void;
}> = ({ year, month, eventsByDate, absencesByDate, isDark, onDateTap }) => {
  const bg = isDark ? '#343a40' : '#fff';
  const border = isDark ? '#495057' : '#f0f0f0';
  const textColor = isDark ? '#fff' : '#333';
  const subColor = isDark ? '#adb5bd' : '#888';

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
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
            <th key={w} style={{ padding: '6px 0', fontSize: 12, color: i === 5 ? '#4a90d9' : i === 6 ? '#e74c3c' : subColor, borderBottom: `2px solid ${border}`, fontWeight: 'normal' }}>{w}</th>
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
              const absences = cell.date ? (absencesByDate[cell.date] || []) : [];
              return (
                <td key={ci}
                  onClick={() => cell.date && onDateTap?.(cell.date)}
                  style={{ border: `1px solid ${border}`, verticalAlign: 'top', minHeight: 80, padding: 4, background: cell.date ? bg : isDark ? '#2a2f35' : '#fafafa', cursor: cell.date && onDateTap ? 'pointer' : 'default' }}>
                  {cell.day !== null && (
                    <>
                      <div style={{ marginBottom: 2 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', fontSize: 12, fontWeight: 'bold', background: isToday ? '#4a90d9' : 'transparent', color: isToday ? '#fff' : isSat ? '#4a90d9' : isSun ? '#e74c3c' : textColor }}>
                          {cell.day}
                        </span>
                      </div>
                      {events.map(ev => {
                        const c = getEventColor(ev);
                        const isPending = ev.status === 'pending' || ev.status === 'step2_pending';
                        return (
                          <div key={ev.id + cell.date} title={`${ev.name}｜${shortType(ev)}`}
                            style={{ fontSize: 11, borderRadius: 4, padding: '2px 4px', marginBottom: 2, background: c.bg, color: c.text, border: isPending ? `1px dashed ${'border' in c ? c.border : c.text}` : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {ev.name}
                          </div>
                        );
                      })}
                      {absences.map(ab => {
                        const c = ABSENCE_COLOR[ab.type];
                        return (
                          <div key={ab.id} title={`${ab.name}｜${ABSENCE_LABEL[ab.type]}`}
                            style={{ fontSize: 11, borderRadius: 4, padding: '2px 4px', marginBottom: 2, background: c.bg, color: c.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {ab.name}
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
  isDark: boolean;
  onDateTap?: (date: string) => void;
}> = ({ year, month, eventsByDate, absencesByDate, isDark, onDateTap }) => {
  const today = new Date();
  const todayStr = fmt(today.getFullYear(), today.getMonth(), today.getDate());
  const subColor = isDark ? '#adb5bd' : '#888';
  const textColor = isDark ? '#fff' : '#333';

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
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
            <th key={w} style={{ textAlign: 'center', fontSize: 11, padding: '4px 0', color: i === 5 ? '#4a90d9' : i === 6 ? '#e74c3c' : subColor, fontWeight: 'normal' }}>{w}</th>
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
              const absences = cell.date ? (absencesByDate[cell.date] || []) : [];
              const hasPending = events.some(e => e.status === 'pending' || e.status === 'step2_pending');
              return (
                <td key={ci}
                  onClick={() => cell.date && onDateTap?.(cell.date)}
                  style={{ textAlign: 'center', padding: '3px 1px', cursor: cell.date && onDateTap ? 'pointer' : 'default' }}>
                  <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', width: 30, borderRadius: 6, background: isToday ? (isDark ? '#2c3e50' : '#e8f4fd') : 'transparent', padding: '2px 0' }}>
                    <span style={{ fontSize: 13, fontWeight: isToday ? 'bold' : 'normal', color: isSat ? '#4a90d9' : isSun ? '#e74c3c' : cell.day ? textColor : (isDark ? '#555' : '#ccc') }}>
                      {cell.day ?? ''}
                    </span>
                    {(events.length > 0 || absences.length > 0) && (
                      <div style={{ display: 'flex', gap: 2, marginTop: 1 }}>
                        {events.length > 0 && <div style={{ width: 5, height: 5, borderRadius: '50%', background: hasPending ? '#f39c12' : '#27ae60' }} />}
                        {absences.length > 0 && <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#dc3545' }} />}
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
  const [absences, setAbsences] = useState<AbsenceEvent[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<AbsenceEvent | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [profiles, setProfiles] = useState<ProfileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [absenceSheet, setAbsenceSheet] = useState<string | null>(null);
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
        .select('id, user_id, leave_type, leave_type_other, leave_dates, start_date, end_date, status')
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
        if (dates.length > 0) {
          result.push({ id: l.id, user_id: l.user_id, name, leave_type: l.leave_type, leave_type_other: l.leave_type_other, dates, status: l.status });
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
      .select('id, user_id, date, type, actual_time, notes')
      .gte('date', startStr)
      .lte('date', endStr)
      .order('date');

    if (!data || data.length === 0) { setAbsences([]); return; }

    const userIds = [...new Set(data.map((a: { user_id: string }) => a.user_id))] as string[];
    const { data: profs } = await supabase.from('profiles').select('id, name').in('id', userIds);
    const profileMap: Record<string, string> = {};
    (profs || []).forEach((p: { id: string; name: string }) => { profileMap[p.id] = p.name; });

    setAbsences(data.map((a: { id: string; user_id: string; date: string; type: 'late' | 'early_leave' | 'absent' | 'late_start' | 'early_end'; actual_time: string | null; notes: string | null }) => ({
      ...a, name: profileMap[a.user_id] || '不明',
    })));
  }, [year, month]);

  useEffect(() => { fetchEvents(); fetchAbsences(); }, [fetchEvents, fetchAbsences]);

  useEffect(() => {
    if (!isApprover && !isAdmin) return;
    supabase.from('profiles').select('id, name, role_title, employment_type, group_names').eq('is_active', true).neq('role_title', '管理者').then(({ data }) => {
      if (data) setProfiles(data.map((p: { id: string; name: string; role_title: string; employment_type: string; group_names: string | string[] }) => ({
        ...p,
        group_names: Array.isArray(p.group_names) ? p.group_names : (typeof p.group_names === 'string' ? JSON.parse(p.group_names) : []),
      })));
    });
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

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    await supabase.from('attendance_exceptions').delete().eq('id', deleteTarget.id);
    setDeleting(false);
    setDeleteTarget(null);
    fetchAbsences();
  };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>

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
            { label: '遅刻', bg: '#fff8e1' },
            { label: '早退', bg: '#e3f2fd' },
          ].map(({ label, bg: cbg, border }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 12, height: 12, borderRadius: 3, background: cbg, border: border ? `1px dashed ${border}` : 'none' }} />
              {label}
            </div>
          ))}
        </div>

        {canInput && (
          <div style={{ fontSize: 12, color: '#4a90d9', marginBottom: 12, padding: '6px 10px', background: isDark ? '#1a3a5c' : '#e8f4fd', borderRadius: 6 }}>
            📅 日付をタップして欠勤入力できます
          </div>
        )}

        {isMobile ? (
          <SpCalendar year={year} month={month} eventsByDate={eventsByDate} absencesByDate={absencesByDate} isDark={isDark} onDateTap={canInput ? d => setAbsenceSheet(d) : undefined} />
        ) : (
          <PcCalendar year={year} month={month} eventsByDate={eventsByDate} absencesByDate={absencesByDate} isDark={isDark} onDateTap={canInput ? d => setAbsenceSheet(d) : undefined} />
        )}
      </div>

      {/* 月別リスト */}
      <div style={{ background: bg, borderRadius: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.08)', padding: isMobile ? 14 : 20 }}>
        <div style={{ fontSize: 14, fontWeight: 'bold', color: textColor, marginBottom: 12 }}>
          {year}年 {month + 1}月 の休暇・欠勤一覧
        </div>
        {monthListRows.length === 0 ? (
          <div style={{ textAlign: 'center', color: subColor, fontSize: 13, padding: '16px 0' }}>
            この月のデータはありません
          </div>
        ) : (
          <div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: isMobile ? '72px 1fr 56px 56px 44px' : '100px 1fr 80px 80px 60px',
              gap: 6, padding: '6px 8px', fontSize: 11, color: subColor,
              borderBottom: `1px solid ${borderColor}`, marginBottom: 4,
            }}>
              <span>日付</span><span>名前</span><span>種別</span><span>時間</span><span style={{ textAlign: 'right' }}>状態</span>
            </div>
            {monthListRows.map((row, i) => {
              const d = parseInt(row.date.split('-')[2]);
              const gridCols = isMobile ? '72px 1fr 56px 56px 44px' : '100px 1fr 80px 80px 60px';
              if (row.kind === 'leave') {
                const { ev } = row;
                const isPending = ev.status === 'pending' || ev.status === 'step2_pending';
                const c = getEventColor(ev);
                return (
                  <div key={`l-${ev.id}-${row.date}-${i}`} style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 6, padding: '7px 8px', fontSize: isMobile ? 13 : 14, borderBottom: `1px solid ${borderColor}`, alignItems: 'center' }}>
                    <span style={{ color: subColor, fontSize: isMobile ? 11 : 13 }}>{month + 1}/{d}（{dow(row.date)}）</span>
                    <span style={{ fontWeight: 'bold', color: textColor }}>{ev.name}</span>
                    <span style={{ fontSize: 11, padding: '2px 5px', borderRadius: 4, background: c.bg, color: c.text, border: isPending ? `1px dashed ${'border' in c ? c.border : c.text}` : 'none', textAlign: 'center' }}>
                      {shortType(ev)}
                    </span>
                    <span style={{ fontSize: 12, color: subColor, textAlign: 'center' }}>—</span>
                    <span style={{ fontSize: 11, textAlign: 'right', color: isPending ? '#b7770d' : '#1e8449', fontWeight: 'bold' }}>
                      {STATUS_LABEL[ev.status] || ev.status}
                    </span>
                  </div>
                );
              } else {
                const { ab } = row;
                const c = ABSENCE_COLOR[ab.type];
                const timeLabel = ab.actual_time ? ab.actual_time.slice(0, 5) : '—';
                return (
                  <div key={`a-${ab.id}-${i}`} style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 6, padding: '7px 8px', fontSize: isMobile ? 13 : 14, borderBottom: `1px solid ${borderColor}`, alignItems: 'center' }}>
                    <span style={{ color: subColor, fontSize: isMobile ? 11 : 13 }}>{month + 1}/{d}（{dow(row.date)}）</span>
                    <span style={{ fontWeight: 'bold', color: textColor }}>{ab.name}</span>
                    <span style={{ fontSize: 11, padding: '2px 5px', borderRadius: 4, background: c.bg, color: c.text, textAlign: 'center' }}>
                      {ABSENCE_LABEL[ab.type]}
                    </span>
                    <span style={{ fontSize: 12, color: textColor, textAlign: 'center', fontWeight: ab.actual_time ? 'bold' : 'normal' }}>
                      {timeLabel}
                    </span>
                    <span style={{ fontSize: 11, textAlign: 'right', color: subColor }}>
                      {canInput && (
                        <button onClick={() => setDeleteTarget(ab)} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px solid #dc3545', background: 'transparent', color: '#dc3545', cursor: 'pointer' }}>
                          取消
                        </button>
                      )}
                    </span>
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
              <div style={{ marginTop: 4 }}>{deleteTarget.date}　{ABSENCE_LABEL[deleteTarget.type]}{deleteTarget.actual_time ? `　${deleteTarget.actual_time.slice(0, 5)}` : ''}</div>
              {deleteTarget.notes && <div style={{ marginTop: 4, fontSize: 13, color: '#666' }}>備考：{deleteTarget.notes}</div>}
            </div>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>このレコードを削除します。元に戻せません。</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setDeleteTarget(null)} style={{ flex: 1, padding: 12, background: '#6c757d', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, cursor: 'pointer' }}>
                戻る
              </button>
              <button onClick={handleDelete} disabled={deleting} style={{ flex: 2, padding: 12, background: '#dc3545', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 'bold', cursor: deleting ? 'not-allowed' : 'pointer', opacity: deleting ? 0.7 : 1 }}>
                {deleting ? '削除中...' : '取消を確定する'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 欠勤入力ボトムシート */}
      {absenceSheet && user && (
        <AbsenceInputSheet
          date={absenceSheet}
          profiles={profiles}
          currentUserId={user.id}
          onClose={() => setAbsenceSheet(null)}
          onSaved={fetchAbsences}
        />
      )}
    </div>
  );
};

export default CalendarPage;
