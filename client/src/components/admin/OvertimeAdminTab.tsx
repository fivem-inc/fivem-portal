import React, { useState, useEffect, useCallback } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import OvertimeShiftImport from './OvertimeShiftImport';
import {
  calcPatternFields, timeToMin, formatMin, todayJstStr,
  DAY_KIND_LABELS, CALENDAR_KIND_LABELS,
} from '../../lib/breakCalc';
import type { DayKind, CalendarKind } from '../../lib/breakCalc';
import { DEFAULT_LOCATION } from '../../lib/shiftExcelImport';

// 残業・時間管理の管理タブ：曜日パターン／会社カレンダー／設定

interface PatternRow {
  id: string;
  user_id: string;
  day_kind: DayKind;
  start_time: string | null;
  end_time: string | null;
  start_time2: string | null;
  end_time2: string | null;
  location: string | null;
  break_minutes: number;
  labor_minutes: number;
  valid_from: string;
  valid_to: string | null;
}

interface CalendarRow {
  date: string;
  kind: CalendarKind;
  note: string | null;
}

interface StaffRow {
  id: string;
  name: string;
  role_title: string;
  employment_type: string | null;
}

const DAY_ORDER: DayKind[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'holiday', 'work_on_closed'];
// 週の労働時間合計に含める曜日（祝・出は特別区分なので除く）
const WEEK_DAYS: DayKind[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// 役職の序列（社長＞マネージャー＞リーダー＞フロア責任者＞一般）。スタッフ一覧の並び順に使う
const ROLE_RANK: Record<string, number> = {
  '社長': 1, '管理者': 1, 'マネージャー': 2, 'リーダー': 3, 'フロア責任者': 4, '一般': 5,
};
const ROLE_GROUP_ORDER = ['社長', '管理者', 'マネージャー', 'リーダー', 'フロア責任者', '一般'];

const OvertimeAdminTab: React.FC = () => {
  const ctx = useAdminPanel();
  const { isDarkMode, supabase } = ctx;

  const [section, setSection] = useState<'patterns' | 'calendar' | 'settings'>('patterns');

  const text = isDarkMode ? '#f8f9fa' : '#212529';
  const subText = isDarkMode ? '#adb5bd' : '#6c757d';
  const borderColor = isDarkMode ? '#495057' : '#dee2e6';
  const cardBg = isDarkMode ? '#343a40' : '#fff';
  const innerBg = isDarkMode ? '#2b3035' : '#f8f9fa';
  const inputStyle: React.CSSProperties = {
    padding: '7px 10px', borderRadius: 8, border: `1px solid ${borderColor}`,
    background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 13,
  };

  // ─────────── 曜日パターン ───────────
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [patterns, setPatterns] = useState<PatternRow[]>([]);
  const [editTimes, setEditTimes] = useState<Record<string, { start: string; end: string; start2: string; end2: string; location: string }>>({});
  const [applyFrom, setApplyFrom] = useState(() => todayJstStr());
  const [patternMsg, setPatternMsg] = useState('');
  const [patternErr, setPatternErr] = useState('');
  const [savingPattern, setSavingPattern] = useState(false);
  // 全員の現在の適用パターン一覧（いま何が適用されているかの確認用）
  const [overview, setOverview] = useState<{ staffId: string; name: string; role: string; days: Record<string, PatternRow | undefined> }[]>([]);
  const [showOverview, setShowOverview] = useState(false);

  const fetchStaff = useCallback(async () => {
    // 全アクティブスタッフを取得（Excel照合でパートも判定に使うため）。ドロップダウンは正社員のみ表示
    const { data } = await supabase.from('profiles')
      .select('id, name, role_title, employment_type')
      .eq('is_active', true)
      .order('name');
    // 役職の序列順に並べ替え（社長＞マネージャー＞リーダー＞フロア責任者＞一般）。同役職内は名前順
    const rows = (data as StaffRow[] | null) ?? [];
    rows.sort((a, b) =>
      (ROLE_RANK[a.role_title] ?? 99) - (ROLE_RANK[b.role_title] ?? 99)
      || a.name.localeCompare(b.name, 'ja'));
    setStaff(rows);
  }, [supabase]);

  const fetchPatterns = useCallback(async (userId: string) => {
    if (!userId) { setPatterns([]); return; }
    const { data } = await supabase.from('weekly_shift_patterns')
      .select('*').eq('user_id', userId).order('valid_from', { ascending: false });
    const rows = (data as PatternRow[] | null) ?? [];
    setPatterns(rows);
    // 現在有効なパターンを編集欄へ
    const today = todayJstStr();
    const active = rows.filter(p => p.valid_from <= today && (p.valid_to === null || p.valid_to >= today));
    const next: Record<string, { start: string; end: string; start2: string; end2: string; location: string }> = {};
    for (const k of DAY_ORDER) {
      const p = active.find(x => x.day_kind === k);
      next[k] = {
        start: p?.start_time?.slice(0, 5) ?? '', end: p?.end_time?.slice(0, 5) ?? '',
        start2: p?.start_time2?.slice(0, 5) ?? '', end2: p?.end_time2?.slice(0, 5) ?? '',
        location: p?.location ?? '',
      };
    }
    setEditTimes(next);
  }, [supabase]);

  // 全員の「今日時点で有効な」曜日パターンを集めて一覧化
  const fetchOverview = useCallback(async () => {
    const { data } = await supabase.from('weekly_shift_patterns')
      .select('id, user_id, day_kind, start_time, end_time, start_time2, end_time2, location, break_minutes, labor_minutes, valid_from, valid_to');
    const rows = (data as PatternRow[] | null) ?? [];
    const today = todayJstStr();
    const seishain = staff.filter(s => s.employment_type !== 'パート');
    const list = seishain.map(s => {
      const days: Record<string, PatternRow | undefined> = {};
      for (const k of DAY_ORDER) {
        days[k] = rows.find(p => p.user_id === s.id && p.day_kind === k
          && p.valid_from <= today && (p.valid_to === null || p.valid_to >= today));
      }
      return { staffId: s.id, name: s.name, role: s.role_title, days };
    }).filter(x => DAY_ORDER.some(k => x.days[k] !== undefined)); // 未登録の人は出さない
    setOverview(list);
  }, [supabase, staff]);

  useEffect(() => { fetchStaff(); }, [fetchStaff]);
  useEffect(() => { fetchPatterns(selectedStaffId); setPatternMsg(''); setPatternErr(''); }, [selectedStaffId, fetchPatterns]);
  useEffect(() => { if (section === 'patterns' && staff.length > 0) fetchOverview(); }, [section, staff, fetchOverview]);

  const savePatterns = async () => {
    setPatternErr(''); setPatternMsg('');
    if (!selectedStaffId) { setPatternErr('スタッフを選択してください'); return; }
    if (!applyFrom) { setPatternErr('適用開始日を入力してください'); return; }
    // 入力チェック
    for (const k of DAY_ORDER) {
      const t = editTimes[k] ?? { start: '', end: '', start2: '', end2: '', location: '' };
      if ((t.start && !t.end) || (!t.start && t.end)) {
        setPatternErr(`${DAY_KIND_LABELS[k]}の開始・終了を両方入力してください（休みの場合は両方空欄）`);
        return;
      }
      const s = timeToMin(t.start); const e = timeToMin(t.end);
      if (s != null && e != null && e <= s) {
        setPatternErr(`${DAY_KIND_LABELS[k]}の終了時刻は開始より後にしてください`);
        return;
      }
      if ((t.start2 && !t.end2) || (!t.start2 && t.end2)) {
        setPatternErr(`${DAY_KIND_LABELS[k]}の2つ目の時間帯は開始・終了を両方入力してください`);
        return;
      }
      const s2 = timeToMin(t.start2); const e2 = timeToMin(t.end2);
      if (s2 != null && e2 != null && e2 <= s2) {
        setPatternErr(`${DAY_KIND_LABELS[k]}の2つ目の時間帯の終了は開始より後にしてください`);
        return;
      }
      if (s2 != null && s == null) {
        setPatternErr(`${DAY_KIND_LABELS[k]}は1つ目の時間帯を入力してから2つ目を入力してください`);
        return;
      }
    }
    setSavingPattern(true);
    try {
      const prevDay = (() => {
        const [y, m, d] = applyFrom.split('-').map(Number);
        const dt = new Date(y, m - 1, d - 1);
        return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      })();

      for (const k of DAY_ORDER) {
        const t = editTimes[k] ?? { start: '', end: '', start2: '', end2: '', location: '' };
        // 適用開始日以降と重なる既存行を締める/消す
        const overlapping = patterns.filter(p =>
          p.day_kind === k && (p.valid_to === null || p.valid_to >= applyFrom));
        for (const p of overlapping) {
          if (p.valid_from >= applyFrom) {
            await supabase.from('weekly_shift_patterns').delete().eq('id', p.id);
          } else {
            await supabase.from('weekly_shift_patterns').update({ valid_to: prevDay }).eq('id', p.id);
          }
        }
        const s = timeToMin(t.start); const e = timeToMin(t.end);
        const s2 = timeToMin(t.start2); const e2 = timeToMin(t.end2);
        const isWork = s != null && e != null;
        const { breakMinutes, laborMinutes } = calcPatternFields({ start: s, end: e }, { start: s2, end: e2 });
        const { error } = await supabase.from('weekly_shift_patterns').insert({
          user_id: selectedStaffId,
          day_kind: k,
          start_time: t.start || null,
          end_time: t.end || null,
          start_time2: (s2 != null) ? t.start2 : null,
          end_time2: (e2 != null) ? t.end2 : null,
          location: isWork ? (t.location.trim() || DEFAULT_LOCATION) : null,
          break_minutes: breakMinutes,
          labor_minutes: laborMinutes,
          valid_from: applyFrom,
          valid_to: null,
        });
        if (error) throw error;
      }
      setPatternMsg(`保存しました（${applyFrom} から適用）`);
      fetchPatterns(selectedStaffId);
      fetchOverview();
    } catch (e) {
      setPatternErr('保存に失敗しました: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSavingPattern(false);
    }
  };

  // ─────────── 会社カレンダー ───────────
  const [calRows, setCalRows] = useState<CalendarRow[]>([]);
  const [calDate, setCalDate] = useState('');
  const [calKind, setCalKind] = useState<CalendarKind>('closed_all');
  const [calNote, setCalNote] = useState('');
  const [calErr, setCalErr] = useState('');
  const [calMsg, setCalMsg] = useState('');
  const [calDeleteTarget, setCalDeleteTarget] = useState<string | null>(null);

  const fetchCalendar = useCallback(async () => {
    const { data } = await supabase.from('company_calendar')
      .select('date, kind, note')
      .gte('date', `${new Date().getFullYear() - 1}-01-01`)
      .order('date', { ascending: true });
    setCalRows((data as CalendarRow[] | null) ?? []);
  }, [supabase]);

  useEffect(() => { if (section === 'calendar') fetchCalendar(); }, [section, fetchCalendar]);

  const addCalendar = async () => {
    setCalErr(''); setCalMsg('');
    if (!calDate) { setCalErr('日付を選択してください'); return; }
    const { error } = await supabase.from('company_calendar')
      .upsert({ date: calDate, kind: calKind, note: calNote || null });
    if (error) { setCalErr('保存に失敗しました: ' + error.message); return; }
    setCalMsg(`${calDate} を「${CALENDAR_KIND_LABELS[calKind]}」として保存しました`);
    setCalDate(''); setCalNote('');
    fetchCalendar();
  };

  const deleteCalendar = async (date: string) => {
    await supabase.from('company_calendar').delete().eq('date', date);
    setCalDeleteTarget(null);
    fetchCalendar();
  };

  // ─────────── 設定 ───────────
  const [thresholdHours, setThresholdHours] = useState('10');
  const [thresholdMins, setThresholdMins] = useState('0');
  const [groupOptions, setGroupOptions] = useState<string[]>([]);
  const [bannerGroups, setBannerGroups] = useState<string[]>([]);
  const [settingsMsg, setSettingsMsg] = useState('');
  const [settingsErr, setSettingsErr] = useState('');

  const fetchSettings = useCallback(async () => {
    const [setRes, grpRes] = await Promise.all([
      supabase.from('overtime_settings').select('threshold_minutes, banner_group_names').eq('id', 1).maybeSingle(),
      supabase.from('master_options').select('value').eq('category', 'group').order('sort_order'),
    ]);
    const th = (setRes.data?.threshold_minutes as number | undefined) ?? 600;
    setThresholdHours(String(Math.floor(th / 60)));
    setThresholdMins(String(th % 60));
    setBannerGroups((setRes.data?.banner_group_names as string[] | null) ?? []);
    setGroupOptions(((grpRes.data as { value: string }[] | null) ?? []).map(g => g.value));
  }, [supabase]);

  useEffect(() => { if (section === 'settings') fetchSettings(); }, [section, fetchSettings]);

  const saveSettings = async () => {
    setSettingsErr(''); setSettingsMsg('');
    const h = parseInt(thresholdHours, 10);
    const m = parseInt(thresholdMins, 10);
    if (isNaN(h) || h < 0 || isNaN(m) || m < 0 || m > 59) {
      setSettingsErr('しきい値は「時間（0以上）」「分（0〜59）」で入力してください');
      return;
    }
    const { error } = await supabase.from('overtime_settings')
      .update({ threshold_minutes: h * 60 + m, banner_group_names: bannerGroups })
      .eq('id', 1);
    if (error) { setSettingsErr('保存に失敗しました: ' + error.message); return; }
    setSettingsMsg('設定を保存しました');
  };

  // ─────────── render ───────────
  const sectionBtn = (key: typeof section, label: string) => (
    <button key={key} onClick={() => setSection(key)}
      style={{
        flex: 1, padding: '9px 0', borderRadius: 8, cursor: 'pointer', fontSize: 13,
        fontWeight: section === key ? 'bold' : 'normal',
        border: section === key ? '2px solid #007bff' : `1px solid ${borderColor}`,
        background: section === key ? (isDarkMode ? '#1e3a5f' : '#e7f1ff') : 'transparent',
        color: section === key ? (isDarkMode ? '#8fc5f6' : '#0d6efd') : subText,
      }}>
      {label}
    </button>
  );

  return (
    <div>
      <h3 style={{ margin: '0 0 4px', fontSize: 16, color: text }}>⏱ 残業・時間管理（正社員）</h3>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: subText }}>
        通常シフトの曜日パターン・会社カレンダー・超過バナーの設定を管理します
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {sectionBtn('patterns', '曜日パターン')}
        {sectionBtn('calendar', '会社カレンダー')}
        {sectionBtn('settings', '設定')}
      </div>

      {/* ─── 曜日パターン ─── */}
      {section === 'patterns' && (
        <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${borderColor}`, padding: '14px 16px' }}>
          <p style={{ margin: '0 0 10px', fontSize: 12.5, color: subText, lineHeight: 1.7 }}>
            スタッフごとの通常シフト（曜日パターン）を登録します。休みの曜日は空欄のままにしてください。<br />
            変更は「適用開始日」以降に反映され、それより前の申請・集計は変わりません（履歴型）。
          </p>

          <OvertimeShiftImport
            supabase={supabase}
            isDarkMode={isDarkMode}
            staff={staff}
            onImported={() => { if (selectedStaffId) fetchPatterns(selectedStaffId); fetchOverview(); }}
          />

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12, marginTop: 14 }}>
            <select value={selectedStaffId} onChange={e => setSelectedStaffId(e.target.value)} style={{ ...inputStyle, minWidth: 200 }}>
              <option value="">スタッフを選択</option>
              {ROLE_GROUP_ORDER.map(role => {
                const members = staff.filter(s => s.role_title === role && s.employment_type !== 'パート');
                if (members.length === 0) return null;
                return (
                  <optgroup key={role} label={role}>
                    {members.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </optgroup>
                );
              })}
              {/* 序列に載っていない役職（想定外・パートを除く）は末尾に */}
              {(() => {
                const others = staff.filter(s => !ROLE_GROUP_ORDER.includes(s.role_title) && s.employment_type !== 'パート');
                if (others.length === 0) return null;
                return (
                  <optgroup label="その他">
                    {others.map(s => <option key={s.id} value={s.id}>{s.name}（{s.role_title}）</option>)}
                  </optgroup>
                );
              })()}
            </select>
            <label style={{ fontSize: 12.5, color: subText, display: 'flex', alignItems: 'center', gap: 6 }}>
              適用開始日
              <input type="date" value={applyFrom} onChange={e => setApplyFrom(e.target.value)} style={inputStyle} />
            </label>
          </div>

          {selectedStaffId && (
            <>
              <p style={{ margin: '0 0 8px', fontSize: 11.5, color: subText }}>
                外出・戻り・テレワークがある日は「＋2つ目」に入力してください。校が空欄の日は{DEFAULT_LOCATION}になります。
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {DAY_ORDER.map(k => {
                  const t = editTimes[k] ?? { start: '', end: '', start2: '', end2: '', location: '' };
                  const s = timeToMin(t.start); const e = timeToMin(t.end);
                  const s2 = timeToMin(t.start2); const e2 = timeToMin(t.end2);
                  const valid = s != null && e != null && e > s;
                  const { breakMinutes, laborMinutes } = calcPatternFields({ start: s, end: e }, { start: s2, end: e2 });
                  const has2 = t.start2 || t.end2;
                  return (
                    <div key={k} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 8, background: innerBg }}>
                      <span style={{ color: subText, whiteSpace: 'nowrap', minWidth: 110, fontSize: 12.5 }}>{DAY_KIND_LABELS[k]}</span>
                      <input type="time" value={t.start}
                        onChange={ev => setEditTimes(prev => ({ ...prev, [k]: { ...t, start: ev.target.value } }))}
                        style={inputStyle} />
                      <span style={{ color: subText }}>〜</span>
                      <input type="time" value={t.end}
                        onChange={ev => setEditTimes(prev => ({ ...prev, [k]: { ...t, end: ev.target.value } }))}
                        style={inputStyle} />
                      {!has2 ? (
                        <button onClick={() => setEditTimes(prev => ({ ...prev, [k]: { ...t, start2: '00:00', end2: '00:00' } }))}
                          disabled={!valid}
                          style={{ background: 'none', border: `1px dashed ${borderColor}`, borderRadius: 6, cursor: valid ? 'pointer' : 'default', padding: '5px 8px', fontSize: 11, color: valid ? '#0d6efd' : subText, opacity: valid ? 1 : 0.5 }}>
                          ＋2つ目
                        </button>
                      ) : (
                        <>
                          <span style={{ color: subText, fontSize: 11 }}>2つ目</span>
                          <input type="time" value={t.start2}
                            onChange={ev => setEditTimes(prev => ({ ...prev, [k]: { ...t, start2: ev.target.value } }))}
                            style={inputStyle} />
                          <span style={{ color: subText }}>〜</span>
                          <input type="time" value={t.end2}
                            onChange={ev => setEditTimes(prev => ({ ...prev, [k]: { ...t, end2: ev.target.value } }))}
                            style={inputStyle} />
                          <button onClick={() => setEditTimes(prev => ({ ...prev, [k]: { ...t, start2: '', end2: '' } }))}
                            aria-label="2つ目の時間帯を削除" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: subText }}>🗑</button>
                        </>
                      )}
                      {valid && (
                        <input type="text" value={t.location}
                          onChange={ev => setEditTimes(prev => ({ ...prev, [k]: { ...t, location: ev.target.value } }))}
                          placeholder={DEFAULT_LOCATION}
                          style={{ ...inputStyle, width: 96 }} />
                      )}
                      {(t.start || t.end) && (
                        <button onClick={() => setEditTimes(prev => ({ ...prev, [k]: { start: '', end: '', start2: '', end2: '', location: '' } }))}
                          aria-label={`${DAY_KIND_LABELS[k]}を休みにする`}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: subText }}>休みにする</button>
                      )}
                      <span style={{ marginLeft: 'auto', fontSize: 11.5, color: subText, whiteSpace: 'nowrap' }}>
                        {valid ? `休憩${formatMin(breakMinutes)}・労働${formatMin(laborMinutes)}` : '休み'}
                      </span>
                    </div>
                  );
                })}
              </div>

              {(() => {
                const weekTotal = WEEK_DAYS.reduce((sum, k) => {
                  const t = editTimes[k] ?? { start: '', end: '', start2: '', end2: '', location: '' };
                  const { laborMinutes } = calcPatternFields(
                    { start: timeToMin(t.start), end: timeToMin(t.end) },
                    { start: timeToMin(t.start2), end: timeToMin(t.end2) },
                  );
                  return sum + laborMinutes;
                }, 0);
                return (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8, fontSize: 13, color: text }}>
                    <span style={{ color: subText }}>週の労働時間合計</span>
                    <span style={{ fontWeight: 'bold' }}>{formatMin(weekTotal)}</span>
                  </div>
                );
              })()}

              {patternErr && <p style={{ margin: '10px 0 0', fontSize: 13, color: '#dc3545' }}>{patternErr}</p>}
              {patternMsg && (
                <div style={{ background: isDarkMode ? '#1b3a1e' : '#d1e7dd', border: '1px solid #28a745', borderRadius: 8, padding: '8px 12px', marginTop: 10 }}>
                  <p style={{ margin: 0, fontSize: 13, color: isDarkMode ? '#8fd19e' : '#0f5132' }}>✅ {patternMsg}</p>
                </div>
              )}

              <button onClick={savePatterns} disabled={savingPattern}
                style={{ marginTop: 12, padding: '10px 24px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 'bold', background: '#007bff', color: '#fff', opacity: savingPattern ? 0.6 : 1 }}>
                {savingPattern ? '保存中…' : 'この内容で保存'}
              </button>

              {/* 過去の履歴 */}
              {patterns.some(p => p.valid_to !== null) && (
                <details style={{ marginTop: 14 }}>
                  <summary style={{ fontSize: 12.5, color: subText, cursor: 'pointer' }}>過去のパターン履歴を表示</summary>
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', color: subText, marginTop: 8 }}>
                    <tbody>
                      {patterns.filter(p => p.valid_to !== null).map(p => (
                        <tr key={p.id}>
                          <td style={{ padding: '3px 4px' }}>{DAY_KIND_LABELS[p.day_kind]}</td>
                          <td style={{ padding: '3px 4px' }}>{p.start_time ? `${p.start_time.slice(0, 5)}〜${p.end_time?.slice(0, 5)}` : '休み'}</td>
                          <td style={{ padding: '3px 4px' }}>{p.valid_from}〜{p.valid_to}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </>
          )}

          {/* いま適用されている曜日パターン一覧（全員） */}
          <div style={{ marginTop: 18, borderTop: `1px solid ${borderColor}`, paddingTop: 14 }}>
            <button onClick={() => { setShowOverview(v => !v); if (!showOverview) fetchOverview(); }}
              style={{ background: 'none', border: `1px solid ${borderColor}`, borderRadius: 8, cursor: 'pointer', padding: '8px 16px', fontSize: 13, fontWeight: 'bold', color: '#0d6efd' }}>
              📋 いま適用中のパターン一覧{showOverview ? ' を閉じる' : `（${overview.length}名）`}
            </button>

            {showOverview && (
              <div style={{ marginTop: 12 }}>
                <p style={{ margin: '0 0 8px', fontSize: 12, color: subText }}>本日（{todayJstStr()}）時点で有効な通常シフトです。</p>
                {overview.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 12.5, color: subText }}>まだ登録されたパターンはありません。</p>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse', color: text, minWidth: 720 }}>
                      <thead>
                        <tr>
                          <th style={{ padding: '6px 6px', borderBottom: `1px solid ${borderColor}`, textAlign: 'left', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: cardBg }}>名前</th>
                          {WEEK_DAYS.map(k => (
                            <th key={k} style={{ padding: '6px 4px', borderBottom: `1px solid ${borderColor}`, whiteSpace: 'nowrap' }}>{DAY_KIND_LABELS[k].replace(/（.*）/, '')}</th>
                          ))}
                          <th style={{ padding: '6px 6px', borderBottom: `1px solid ${borderColor}`, whiteSpace: 'nowrap', borderLeft: `1px solid ${borderColor}` }}>週合計</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overview.map(row => {
                          const weekTotal = WEEK_DAYS.reduce((sum, k) => sum + (row.days[k]?.labor_minutes ?? 0), 0);
                          return (
                          <tr key={row.staffId}>
                            <td style={{ padding: '5px 6px', borderBottom: `1px solid ${borderColor}`, whiteSpace: 'nowrap', position: 'sticky', left: 0, background: cardBg }}>{row.name}</td>
                            {WEEK_DAYS.map(k => {
                              const p = row.days[k];
                              return (
                                <td key={k} style={{ padding: '5px 4px', borderBottom: `1px solid ${borderColor}`, textAlign: 'center', whiteSpace: 'nowrap', color: p?.start_time ? text : subText }}>
                                  {p?.start_time ? (
                                    <>
                                      {p.start_time.slice(0, 5)}〜{p.end_time?.slice(0, 5)}
                                      {p.start_time2 && <><br />＋{p.start_time2.slice(0, 5)}〜{p.end_time2?.slice(0, 5)}</>}
                                      <br /><span style={{ fontSize: 10, color: subText }}>{p.location ?? DEFAULT_LOCATION}</span>
                                    </>
                                  ) : '休'}
                                </td>
                              );
                            })}
                            <td style={{ padding: '5px 6px', borderBottom: `1px solid ${borderColor}`, textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 'bold', borderLeft: `1px solid ${borderColor}` }}>{formatMin(weekTotal)}</td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── 会社カレンダー ─── */}
      {section === 'calendar' && (
        <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${borderColor}`, padding: '14px 16px' }}>
          <p style={{ margin: '0 0 10px', fontSize: 12.5, color: subText, lineHeight: 1.7 }}>
            曜日パターンより優先される特別な日を登録します。<br />
            「全員休み」＝会社休日（祝パターン適用）／「休館日だけど出勤日」＝出パターン適用
          </p>

          <div style={{ background: innerBg, borderRadius: 10, padding: '10px 12px', marginBottom: 14 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input type="date" value={calDate} onChange={e => setCalDate(e.target.value)} style={inputStyle} />
              <select value={calKind} onChange={e => setCalKind(e.target.value as CalendarKind)} style={inputStyle}>
                <option value="closed_all">全員休み</option>
                <option value="work_on_closed">休館日だけど出勤日</option>
              </select>
              <input type="text" value={calNote} onChange={e => setCalNote(e.target.value)} placeholder="メモ（任意）" style={{ ...inputStyle, minWidth: 140 }} />
              <button onClick={addCalendar}
                style={{ padding: '8px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 'bold', background: '#007bff', color: '#fff' }}>
                追加・更新
              </button>
            </div>
            {calErr && <p style={{ margin: '8px 0 0', fontSize: 13, color: '#dc3545' }}>{calErr}</p>}
            {calMsg && <p style={{ margin: '8px 0 0', fontSize: 13, color: isDarkMode ? '#8fd19e' : '#0f5132' }}>✅ {calMsg}</p>}
          </div>

          {calRows.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: subText }}>登録済みの特別日はありません</p>
          ) : (
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', color: text }}>
              <tbody>
                {calRows.map(r => (
                  <tr key={r.date}>
                    <td style={{ padding: '5px 4px', borderBottom: `1px solid ${borderColor}`, whiteSpace: 'nowrap' }}>{r.date}</td>
                    <td style={{ padding: '5px 4px', borderBottom: `1px solid ${borderColor}` }}>{CALENDAR_KIND_LABELS[r.kind]}</td>
                    <td style={{ padding: '5px 4px', borderBottom: `1px solid ${borderColor}`, color: subText }}>{r.note ?? ''}</td>
                    <td style={{ padding: '5px 4px', borderBottom: `1px solid ${borderColor}`, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {calDeleteTarget === r.date ? (
                        <>
                          <button onClick={() => deleteCalendar(r.date)}
                            style={{ padding: '4px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, background: '#dc3545', color: '#fff', marginRight: 4 }}>
                            削除する
                          </button>
                          <button onClick={() => setCalDeleteTarget(null)}
                            style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${borderColor}`, cursor: 'pointer', fontSize: 12, background: 'transparent', color: subText }}>
                            やめる
                          </button>
                        </>
                      ) : (
                        <button onClick={() => setCalDeleteTarget(r.date)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: subText }}>🗑</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ─── 設定 ─── */}
      {section === 'settings' && (
        <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${borderColor}`, padding: '14px 16px' }}>
          <div style={{ marginBottom: 16 }}>
            <p style={{ margin: '0 0 6px', fontSize: 13.5, fontWeight: 'bold', color: text }}>超過バナーのしきい値</p>
            <p style={{ margin: '0 0 8px', fontSize: 12, color: subText, lineHeight: 1.7 }}>
              今期の残業通算がこの時間を超えたスタッフについて、本人・リーダー（自チームのみ）・マネージャー以上にお知らせバナーを表示します。
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="number" inputMode="numeric" min={0} step={1} value={thresholdHours}
                onChange={e => setThresholdHours(e.target.value)} style={{ ...inputStyle, width: 70, textAlign: 'right' }} />
              <span style={{ fontSize: 13, color: text }}>時間</span>
              <input type="number" inputMode="numeric" min={0} max={59} step={1} value={thresholdMins}
                onChange={e => setThresholdMins(e.target.value)} style={{ ...inputStyle, width: 70, textAlign: 'right' }} />
              <span style={{ fontSize: 13, color: text }}>分</span>
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <p style={{ margin: '0 0 6px', fontSize: 13.5, fontWeight: 'bold', color: text }}>部門として扱うグループ</p>
            <p style={{ margin: '0 0 8px', fontSize: 12, color: subText, lineHeight: 1.7 }}>
              集計の部門分けと、リーダーの「自チーム」判定に使うグループを選びます。<br />
              役職系のグループ（例：マネージャー・リーダー）は選ばないでください。
            </p>
            {groupOptions.length === 0 ? (
              <p style={{ margin: 0, fontSize: 12.5, color: subText }}>グループが登録されていません（グループタブで作成できます）</p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {groupOptions.map(g => {
                  const on = bannerGroups.includes(g);
                  return (
                    <button key={g}
                      onClick={() => setBannerGroups(prev => on ? prev.filter(x => x !== g) : [...prev, g])}
                      style={{
                        padding: '6px 14px', borderRadius: 16, cursor: 'pointer', fontSize: 13,
                        border: on ? '2px solid #007bff' : `1px solid ${borderColor}`,
                        background: on ? (isDarkMode ? '#1e3a5f' : '#e7f1ff') : 'transparent',
                        color: on ? (isDarkMode ? '#8fc5f6' : '#0d6efd') : subText,
                        fontWeight: on ? 'bold' : 'normal',
                      }}>
                      {on ? '✓ ' : ''}{g}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {settingsErr && <p style={{ margin: '0 0 8px', fontSize: 13, color: '#dc3545' }}>{settingsErr}</p>}
          {settingsMsg && (
            <div style={{ background: isDarkMode ? '#1b3a1e' : '#d1e7dd', border: '1px solid #28a745', borderRadius: 8, padding: '8px 12px', marginBottom: 8 }}>
              <p style={{ margin: 0, fontSize: 13, color: isDarkMode ? '#8fd19e' : '#0f5132' }}>✅ {settingsMsg}</p>
            </div>
          )}
          <button onClick={saveSettings}
            style={{ padding: '10px 24px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 'bold', background: '#007bff', color: '#fff' }}>
            設定を保存
          </button>

          <p style={{ margin: '14px 0 0', fontSize: 11.5, color: subText, lineHeight: 1.7 }}>
            ※ バナーの本人向け文言：「今月（7/16〜8/15）の残業が◯時間を超えました。時間調整をお願いします。調整する日がわからない場合はリーダー・マネージャーにご相談ください。」（期間・時間は自動で入ります）
          </p>
        </div>
      )}
    </div>
  );
};

export default OvertimeAdminTab;
