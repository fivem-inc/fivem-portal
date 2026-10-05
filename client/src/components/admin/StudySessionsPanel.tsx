import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { todayJstStr } from '../../lib/breakCalc';
import {
  AREA_COLORS, ROSTER_DAY_LABEL, ROSTER_WEEK, minText, rowOnDate, rowToDay, sortSegments, toMin,
  type RosterDayKind, type WorkArea,
} from '../../lib/shiftRoster';
import { loadRosterData, type RosterPatternRow } from '../../lib/shiftRosterApi';
import { fullName, shortNameMap } from '../../lib/staffName';
import {
  STUDY_DURATIONS, dayIssue, mdText, studyCellText, studyEndMin, studyIssues, studyLabel, studyStartMin, versionsOnDate,
  type StudyVersion,
} from '../../lib/studySessions';
import {
  ackStudyIssue, loadStudyData, loadStudyToken, saveStudy, setStudyShowSelf, type StudyData,
} from '../../lib/studySessionsApi';
import { loadDisplayNames } from '../../lib/cleaningRosterApi';

// ③ 勉強会（2026-09-15）。設計・決めたことは docs/計画-管理画面の開放.md の 5-5・5-6。
// ・毎週の定例。修正は「いつから」で版を足す／終わらせるときは先の変更も取り消す
// ・入力のプレビュー：曜日と校で、その日その校にいる人を時間の帯で並べる（パートも含む）
// ・⚠️ 印は保存しない（週のシフトから計算）。「確認した」だけ残す。ずれ方が変わればまた出る
// ・本人に見せる切り替えは管理者だけ
// 🚨 判定は lib/studySessions.ts の1か所。勤務表の画面も同じものを使う

interface Editor {
  sessionId: string | null;
  applyFrom: string;
  day: RosterDayKind;
  start: string;
  duration: number;
  location: string;
  floor: string;
  memo: string;
  members: string[];
  /** 講師（members のうちの何人か・2026-10-06） */
  teachers: string[];
  /** 部門（shift_work_areas の id・''＝決めない・2026-10-06） */
  areaId: string;
  /** いつまで（入れたいときだけ・''＝決めない・2026-10-06）。入れると保存のあとその日で終わらせる */
  until: string;
}

const TL_START = 8 * 60;
const TL_END = 22 * 60;
const pct = (m: number) => `${Math.max(0, Math.min(100, ((m - TL_START) / (TL_END - TL_START)) * 100))}%`;

const StudySessionsPanel: React.FC<{ isDarkMode: boolean; isAdminUser: boolean }> = ({ isDarkMode, isAdminUser }) => {
  const text = isDarkMode ? '#f8f9fa' : '#212529';
  const subText = isDarkMode ? '#adb5bd' : '#6c757d';
  const borderColor = isDarkMode ? '#495057' : '#dee2e6';
  const cardBg = isDarkMode ? '#343a40' : '#fff';
  const innerBg = isDarkMode ? '#2b3035' : '#f8f9fa';
  const red = isDarkMode ? '#ff8a80' : '#c62828';
  const green = isDarkMode ? '#8fd19e' : '#1b5e20';
  const inputStyle: React.CSSProperties = { padding: '5px 7px', borderRadius: 6, border: `1px solid ${borderColor}`, background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 13 };
  const toggle = (on: boolean): React.CSSProperties => ({
    padding: '5px 11px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12.5,
    fontWeight: on ? 'bold' : 'normal', background: on ? '#1976d2' : (isDarkMode ? '#495057' : '#e9ecef'), color: on ? '#fff' : text,
  });
  const primaryBtn: React.CSSProperties = { padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 'bold', background: '#1976d2', color: '#fff' };

  const today = todayJstStr();
  const [baseDate, setBaseDate] = useState(today);
  const [data, setData] = useState<StudyData | null>(null);
  const [rosterRows, setRosterRows] = useState<RosterPatternRow[]>([]);
  const [workplaces, setWorkplaces] = useState<string[]>([]);
  const [rosterSince, setRosterSince] = useState(today);
  const [token, setToken] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirmPast, setConfirmPast] = useState(false);
  const [ending, setEnding] = useState<{ sessionId: string; date: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [stale, setStale] = useState(false);
  const [showSelfConfirm, setShowSelfConfirm] = useState(false);
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  // 2026-10-06：部門（こども・大人・管理部…）と、メインの部門（講師を選んだときの初期値）
  const [areas, setAreas] = useState<WorkArea[]>([]);
  const [mainAreas, setMainAreas] = useState<Record<string, string>>({});
  /** 一覧の絞り込み：'all'／部門の id／'none'（部門なし） */
  const [areaFilter, setAreaFilter] = useState<string>('all');
  /** 一覧で開いている勉強会（版の id） */
  const [openId, setOpenId] = useState<string | null>(null);

  const earliest = [baseDate, editor?.applyFrom ?? baseDate, ending?.date ?? baseDate].sort()[0];

  const load = useCallback(async (since: string) => {
    setLoading(true); setLoadErr('');
    const [s, r, t, dn] = await Promise.all([loadStudyData(since), loadRosterData(since), loadStudyToken(), loadDisplayNames()]);
    if (s.error || !s.data) { setLoadErr(s.error ?? '読み込めませんでした'); setLoading(false); return; }
    if (r.error || !r.data) { setLoadErr(r.error ?? '週のシフトを読み込めませんでした'); setLoading(false); return; }
    if (t.error || t.token == null) { setLoadErr(`保存の準備ができませんでした：${t.error ?? ''}`); setLoading(false); return; }
    setLabels(dn.labels); setData(s.data); setRosterRows(r.data.patterns); setWorkplaces(r.data.workplaces);
    setAreas(r.data.areas.filter(a => a.active)); setMainAreas(r.data.mainAreas); setToken(t.token); setRosterSince(since); setStale(false);
    setLoading(false);
  }, []);

  useEffect(() => { void load(earliest); }, [load, earliest]);

  const fullNames = useMemo(() => new Map((data?.staff ?? []).map(s => [s.id, fullName(s.name)])), [data]);
  const shortNames = useMemo(() => shortNameMap(data?.staff ?? [], labels), [data, labels]);
  const inactive = useMemo(() => new Set((data?.staff ?? []).filter(s => !s.is_active).map(s => s.id)), [data]);
  const rowsByUser = useMemo(() => {
    const m = new Map<string, RosterPatternRow[]>();
    for (const r of rosterRows) m.set(r.user_id, [...(m.get(r.user_id) ?? []), r]);
    return m;
  }, [rosterRows]);

  const versions = data?.versions ?? [];
  const onBase = versionsOnDate(versions, baseDate);
  const upcoming = versions.filter(v => v.valid_from > baseDate && !onBase.some(o => o.session_id === v.session_id));
  const upcomingFirst = [...new Map(upcoming.sort((a, b) => a.valid_from.localeCompare(b.valid_from)).map(v => [v.session_id, v])).values()];
  const shown = [...onBase, ...upcomingFirst.filter(v => !onBase.some(o => o.session_id === v.session_id))];
  const nextChange = (v: StudyVersion) => versions.filter(x => x.session_id === v.session_id && x.valid_from > v.valid_from).map(x => x.valid_from).sort()[0];

  const issuesOf = (v: StudyVersion) => studyIssues(v, rowsByUser, baseDate, fullNames, inactive);
  const isAcked = (v: StudyVersion, key: string) => (data?.acks ?? []).some(a => a.version_id === v.id && a.issue_key === key);
  const allIssues = shown.flatMap(v => issuesOf(v).map(i => ({ v, i })));
  const unacked = allIssues.filter(x => !isAcked(x.v, x.i.key)).length;

  // ─── 本人に見せる ───
  const todayVersions = versionsOnDate(versions, today);
  const memberIds = [...new Set(todayVersions.flatMap(v => v.members))].filter(id => !inactive.has(id));
  const partNames = memberIds.filter(id => data?.staff.find(s => s.id === id)?.employment_type === 'パート').map(id => fullNames.get(id) ?? '');
  const fullTimeCount = memberIds.length - partNames.length;

  const toggleShowSelf = async (on: boolean) => {
    setErr(''); setMsg('');
    const e = await setStudyShowSelf(on);
    setShowSelfConfirm(false);
    if (e) { setErr(e); return; }
    setMsg(on ? '参加する本人に見せるようにしました' : '本人に見せるのをやめました');
    await load(earliest);
  };

  // ─── 保存 ───
  const startNew = () => {
    setMsg(''); setErr(''); setEnding(null); setConfirmPast(false);
    setEditor({ sessionId: null, applyFrom: baseDate, day: 'mon', start: '12:30', duration: 30, location: workplaces[0] ?? '', floor: '', memo: '', members: [], teachers: [], areaId: '', until: '' });
  };
  const startEdit = (v: StudyVersion) => {
    setMsg(''); setErr(''); setEnding(null); setConfirmPast(false);
    setEditor({
      sessionId: v.session_id, applyFrom: baseDate > v.valid_from ? baseDate : v.valid_from, day: v.day_kind,
      start: minText(studyStartMin(v)).padStart(5, '0'), duration: v.duration_minutes, location: v.location ?? '',
      floor: v.floor ?? '', memo: v.memo ?? '', members: [...v.members],
      teachers: [...v.teachers], areaId: v.area_id ?? '', until: '',
    });
  };

  const handleResult = async (result: Awaited<ReturnType<typeof saveStudy>>, okMsg: string) => {
    setSaving(false);
    if (result.error || !result.result) { setErr(`保存できませんでした：${result.error ?? ''}`); return false; }
    if (!result.result.ok && result.result.reason === 'stale') {
      setStale(true);
      setErr('開いたあとに、別の人が勉強会を保存しました。上書きしないよう保存を止めました。「読み込み直す」を押してから、もう一度保存してください（入力はそのまま残ります）。');
      return false;
    }
    if (!result.result.ok) { setErr('今日より前の日付です。確認してから保存してください'); return false; }
    setMsg(result.result.changed ? okMsg : '変更はありませんでした');
    await load(earliest);
    return true;
  };

  const doSave = async () => {
    if (!editor || token == null) return;
    if (editor.applyFrom < today && !confirmPast) { setConfirmPast(true); return; }
    setSaving(true); setErr(''); setMsg('');
    const r = await saveStudy({
      action: 'upsert', session_id: editor.sessionId, apply_from: editor.applyFrom, confirm_past: editor.applyFrom < today,
      base_token: token, day_kind: editor.day, start: editor.start, duration_minutes: editor.duration,
      location: editor.location || null, floor: editor.floor || null, memo: editor.memo || null,
      // 講師が先（勤務表の欄も講師が先に出る）
      members: [...editor.teachers, ...editor.members.filter(id => !editor.teachers.includes(id))],
      teachers: editor.teachers, area_id: editor.areaId || null,
    });
    // いつまで（入れたときだけ）：保存のあと、その日で終わらせる。🚨 保存で目印が変わるので、新しい目印を読み直してから送る
    if (editor.until && !r.error && r.result?.ok && r.result.session_id) {
      const t = await loadStudyToken();
      if (t.error || t.token == null) { setSaving(false); setErr(`保存はしましたが、終わりの日を入れられませんでした：${t.error ?? ''}（一覧の［終わらせる］から入れてください）`); await load(earliest); return; }
      const r2 = await saveStudy({ action: 'end', session_id: r.result.session_id, apply_from: editor.until, confirm_past: editor.until < today, base_token: t.token });
      if (r2.error || !r2.result?.ok) { setSaving(false); setErr(`保存はしましたが、終わりの日を入れられませんでした：${r2.error ?? ''}（一覧の［終わらせる］から入れてください）`); await load(earliest); return; }
      if (await handleResult(r2, `${mdText(editor.applyFrom)} から ${mdText(editor.until)} まで保存しました`)) { setEditor(null); setConfirmPast(false); }
      return;
    }
    if (await handleResult(r, `${mdText(editor.applyFrom)} から保存しました`)) { setEditor(null); setConfirmPast(false); }
  };

  const doEnd = async () => {
    if (!ending || token == null) return;
    setSaving(true); setErr(''); setMsg('');
    const r = await saveStudy({ action: 'end', session_id: ending.sessionId, apply_from: ending.date, confirm_past: ending.date < today, base_token: token });
    if (await handleResult(r, `${mdText(ending.date)} で終わらせました`)) setEnding(null);
  };

  const ack = async (v: StudyVersion, key: string) => {
    setErr('');
    const e = await ackStudyIssue(v.id, key);
    if (e) { setErr(e); return; }
    await load(earliest);
  };

  // ─── プレビュー（C） ───
  const preview = (() => {
    if (!editor || !data) return null;
    const s = toMin(editor.start) ?? 0;
    const e = s + editor.duration;
    const people = data.staff.filter(st => st.is_active).map(st => {
      const rows = (rowsByUser.get(st.id) ?? []).filter(r => r.day_kind === editor.day);
      const row = rowOnDate(rows, editor.applyFrom);
      // 🚨 ほかの曜日の行があれば、この曜日は「休み」（studyIssues と同じ扱い）。1行も無ければ「未登録」
      const hasAny = (rowsByUser.get(st.id) ?? []).some(r => r.valid_from <= editor.applyFrom && (r.valid_to === null || r.valid_to >= editor.applyFrom));
      const day = row ? rowToDay(row) : (hasAny ? { segments: [], note: '' } : null);
      const segs = day ? sortSegments(day.segments).filter(x => !editor.location || x.location.split('→').map(p => p.trim()).includes(editor.location)) : [];
      return { st, day, segs };
    });
    const present = people.filter(p => p.segs.length > 0);
    const selected = editor.members.map(id => people.find(p => p.st.id === id)).filter((p): p is typeof people[number] => !!p);
    // 選んだ全員がこの校にいる時間（区切りの重なり）
    let common: [number, number][] = [[0, 1440]];
    for (const p of selected) {
      const ivs = p.segs.map(x => [toMin(x.start) ?? 0, toMin(x.end) ?? 0] as [number, number]);
      const next: [number, number][] = [];
      for (const [a, b] of common) for (const [c, d] of ivs) { const lo = Math.max(a, c); const hi = Math.min(b, d); if (lo < hi) next.push([lo, hi]); }
      common = next;
    }
    if (selected.length < 2) common = [];
    const dup = versionsOnDate(versions, editor.applyFrom).filter(v => v.session_id !== editor.sessionId && v.day_kind === editor.day
      && [...v.members].sort().join(',') === [...editor.members].sort().join(',') && studyStartMin(v) !== s);
    const label = studyLabel({ start_time: editor.start, duration_minutes: editor.duration, members: [...editor.teachers, ...editor.members.filter(id => !editor.teachers.includes(id))] }, shortNames);
    const memberNotes = editor.members.map(id => {
      const p = people.find(x => x.st.id === id);
      const issue = dayIssue({ start_time: editor.start, duration_minutes: editor.duration, location: editor.location || null }, p?.day ?? null);
      return { id, issue };
    });
    return { s, e, present, common, dup, label, memberNotes };
  })();

  // 2026-10-06：講師と参加を分けた。帯の名前を押したときは、講師がまだいなければ講師、いれば参加に入る
  const addMember = (id: string, asTeacher?: boolean) => setEditor(ed => {
    if (!ed || ed.members.includes(id)) return ed;
    const teacher = asTeacher ?? ed.teachers.length === 0;
    return {
      ...ed, members: [...ed.members, id],
      teachers: teacher ? [...ed.teachers, id] : ed.teachers,
      // 部門が空なら、最初の講師のメインの部門を入れておく（あとで選び直せる）
      areaId: teacher && !ed.areaId ? (mainAreas[id] ?? '') : ed.areaId,
    };
  });
  const removeMember = (id: string) => setEditor(ed => ed ? { ...ed, members: ed.members.filter(x => x !== id), teachers: ed.teachers.filter(x => x !== id) } : ed);

  if (loading && !data) return <p style={{ color: subText }}>読み込んでいます...</p>;
  if (loadErr && !data) return <p style={{ color: red }}>{loadErr}</p>;
  if (!data) return null;

  const editorErrors = editor ? [
    editor.teachers.length < 1 ? '講師を選んでください' : null,
    editor.members.length - editor.teachers.length < 1 ? '参加する人を選んでください' : null,
    !/^\d{1,2}:\d{2}$/.test(editor.start) ? '開始の時刻を入れてください' : null,
    editor.duration < 5 || editor.duration > 240 ? '長さは5〜240分です' : null,
    (toMin(editor.start) ?? 0) + editor.duration > 1440 ? '日をまたぐ勉強会は入れられません' : null,
    editor.until && editor.until < editor.applyFrom ? '「いつまで」は「いつから」より後の日にしてください' : null,
  ].filter((x): x is string => !!x) : [];
  const floorOptions = editor ? (data.floors[editor.location] ?? []) : [];

  return (
    <div>
      {/* 本人に見せる切り替え */}
      <div style={{ padding: '8px 12px', borderRadius: 10, background: innerBg, marginBottom: 10, fontSize: 13, color: text }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>参加する本人に見せる</span>
          {isAdminUser ? (
            <>
              <button type="button" onClick={() => void toggleShowSelf(false)} style={toggle(!data.showSelf)}>オフ</button>
              <button type="button" onClick={() => { if (!data.showSelf) setShowSelfConfirm(true); }} style={toggle(data.showSelf)}>オン</button>
            </>
          ) : (
            <b>{data.showSelf ? 'オン' : 'オフ'}</b>
          )}
          {!isAdminUser && <span style={{ fontSize: 12, color: subText }}>（切り替えは管理者）</span>}
        </div>
        <div style={{ fontSize: 11.5, color: subText, marginTop: 4 }}>オンにすると、正社員の参加者の「残業・時間管理」のページに、自分の勉強会が出ます（パートには出ません）</div>
        {showSelfConfirm && (
          <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: '#fff3cd', border: '1px solid #ffc107', color: '#856404', lineHeight: 1.7 }}>
            オンにすると、正社員の参加者{fullTimeCount}人の「残業・時間管理」のページに、自分の勉強会（備考も）が出ます。<br />
            {partNames.length > 0 ? `パートの${partNames.length}人（${partNames.join('・')}）はこのページに入れないため、見えません。` : ''}
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button type="button" onClick={() => void toggleShowSelf(true)} style={primaryBtn}>オンにする</button>
              <button type="button" onClick={() => setShowSelfConfirm(false)} style={{ ...inputStyle, cursor: 'pointer' }}>やめる</button>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <label style={{ fontSize: 12.5, color: subText, display: 'flex', alignItems: 'center', gap: 6 }}>
          表示する日
          <input type="date" value={baseDate} onChange={e => { if (e.target.value) setBaseDate(e.target.value); }} style={inputStyle} />
        </label>
        <span style={{ fontSize: 13, color: unacked > 0 ? red : subText, fontWeight: unacked > 0 ? 'bold' : 'normal' }}>
          ⚠️ {unacked}件{allIssues.length - unacked > 0 ? `（確認済み ${allIssues.length - unacked}）` : ''}
        </span>
        <button type="button" onClick={startNew} style={{ ...primaryBtn, marginLeft: 'auto' }}>＋ 勉強会を追加</button>
      </div>

      {stale && (
        <div style={{ padding: '10px 12px', borderRadius: 10, background: '#fff3cd', border: '1px solid #ffc107', color: '#856404', fontSize: 13, marginBottom: 10 }}>
          {err}
          <div style={{ marginTop: 8 }}><button type="button" onClick={() => { setErr(''); void load(earliest); }} style={primaryBtn}>読み込み直す</button></div>
        </div>
      )}
      {!stale && err && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029', fontSize: 13, marginBottom: 10 }}>{err}</div>}
      {msg && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#d1e7dd', border: '1px solid #28a745', color: '#0f5132', fontSize: 13, marginBottom: 10 }}>✓ {msg}</div>}

      {/* 追加・修正 */}
      {editor && preview && (
        <div style={{ padding: '12px 14px', borderRadius: 10, border: '2px solid #1976d2', background: cardBg, marginBottom: 12, fontSize: 13, color: text }}>
          <b>{editor.sessionId ? '勉強会を直す' : '勉強会を追加'}</b>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
            <label style={{ color: subText }}>いつから <input type="date" value={editor.applyFrom} style={inputStyle} onChange={e => { if (e.target.value) { setEditor({ ...editor, applyFrom: e.target.value }); setConfirmPast(false); } }} /></label>
            <label style={{ color: subText }}>いつまで <input type="date" value={editor.until} style={inputStyle} onChange={e => setEditor({ ...editor, until: e.target.value })} /></label>
            <span style={{ color: subText, fontSize: 11.5 }}>（決まっていれば）</span>
            <span style={{ color: subText }}>曜日</span>
            {ROSTER_WEEK.map(k => <button key={k} type="button" onClick={() => setEditor({ ...editor, day: k })} style={toggle(editor.day === k)}>{ROSTER_DAY_LABEL[k]}</button>)}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
            <label style={{ color: subText }}>開始 <input type="time" step={300} value={editor.start} style={inputStyle} onChange={e => setEditor({ ...editor, start: e.target.value })} /></label>
            <span style={{ color: subText }}>長さ</span>
            {STUDY_DURATIONS.map(d => <button key={d} type="button" onClick={() => setEditor({ ...editor, duration: d })} style={toggle(editor.duration === d)}>{d}分</button>)}
            <input type="number" min={5} max={240} value={editor.duration} style={{ ...inputStyle, width: 64 }} onChange={e => setEditor({ ...editor, duration: Number(e.target.value) || 0 })} />
            <span style={{ color: subText }}>校</span>
            <select value={editor.location} style={inputStyle} onChange={e => setEditor({ ...editor, location: e.target.value, floor: '' })}>
              <option value="">決めない</option>
              {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
            </select>
            {floorOptions.length > 0 && (
              <select value={editor.floor} style={inputStyle} onChange={e => setEditor({ ...editor, floor: e.target.value })}>
                <option value="">階（任意）</option>
                {floorOptions.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            )}
            <span style={{ color: subText }}>部門</span>
            <select value={editor.areaId} style={inputStyle} onChange={e => setEditor({ ...editor, areaId: e.target.value })}>
              <option value="">決めない</option>
              {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          {([['講師', true], ['参加', false]] as const).map(([label, asTeacher]) => {
            const ids = asTeacher ? editor.teachers : editor.members.filter(id => !editor.teachers.includes(id));
            return (
              <div key={label} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                <span style={{ color: subText, width: 30 }}>{label}</span>
                {ids.length === 0 && <span style={{ color: subText, fontSize: 12 }}>{asTeacher ? '名前から選ぶか、下の帯の名前を押すと入ります' : '名前から選ぶか、下の帯の名前を押すと入ります'}</span>}
                {ids.map(id => (
                  <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 12, background: isDarkMode ? '#1a3a5c' : '#e8f4fd', color: isDarkMode ? '#90caf9' : '#1565c0', fontWeight: asTeacher ? 'bold' : 'normal' }}>
                    {fullNames.get(id)}
                    <button type="button" aria-label={`${label}から外す`} onClick={() => removeMember(id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 12 }}>✕</button>
                  </span>
                ))}
                <select value="" style={inputStyle} onChange={e => { if (e.target.value) addMember(e.target.value, asTeacher); }}>
                  <option value="">名前から選ぶ</option>
                  {data.staff.filter(s => s.is_active && !editor.members.includes(s.id)).map(s => <option key={s.id} value={s.id}>{fullName(s.name)}</option>)}
                </select>
              </div>
            );
          })}
          <div style={{ marginTop: 8 }}>
            <input type="text" value={editor.memo} maxLength={200} placeholder="備考（任意）例：授業がないときは30分" style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} onChange={e => setEditor({ ...editor, memo: e.target.value })} />
            {data.showSelf && <div style={{ fontSize: 11.5, color: subText, marginTop: 2 }}>本人に見せる設定がオンなので、この備考も参加者本人に見えます。勤務表と PDF にも「※」で出ます</div>}
          </div>

          {/* プレビュー */}
          <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, background: innerBg }}>
            <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>
              {mdText(editor.applyFrom)}（{ROSTER_DAY_LABEL[editor.day]}）に{editor.location || 'いずれかの校'}にいる人（保存済みの週のシフト・パートも含む）。名前を押すと入ります（講師がまだいなければ講師、いれば参加）。
              <span style={{ color: '#1565c0' }}> 青</span>＝選んだ全員がそろう時間／<span style={{ color: red }}>赤い枠</span>＝勉強会の時間
            </div>
            <div style={{ position: 'relative', marginLeft: 130, height: 14, fontSize: 11, color: subText }}>
              {[8, 10, 12, 14, 16, 18, 20, 22].map(h => <span key={h} style={{ position: 'absolute', left: pct(h * 60) }}>{h}</span>)}
            </div>
            {preview.present.length === 0 && <div style={{ fontSize: 12, color: subText, padding: '6px 0' }}>この日この校にいる人はいません。</div>}
            {preview.present.map(p => {
              const on = editor.members.includes(p.st.id);
              return (
                <div key={p.st.id} style={{ display: 'flex', alignItems: 'center', height: 24 }}>
                  <button type="button" onClick={() => (on ? removeMember(p.st.id) : addMember(p.st.id))}
                    style={{ width: 130, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: on ? '#1565c0' : text, fontWeight: on ? 'bold' : 'normal', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                    {on ? (editor.teachers.includes(p.st.id) ? '講 ' : '✓ ') : ''}{fullName(p.st.name)}{p.st.employment_type === 'パート' ? '（パ）' : ''}
                  </button>
                  <div style={{ position: 'relative', flex: 1, height: 14, background: isDarkMode ? '#1f2327' : '#eef0f2', borderRadius: 3 }}>
                    {on && preview.common.map(([a, b], i) => <div key={i} style={{ position: 'absolute', left: pct(a), width: `calc(${pct(b)} - ${pct(a)})`, top: -3, bottom: -3, background: '#bbdefb', opacity: 0.7, borderRadius: 3 }} />)}
                    {p.segs.map((x, i) => (
                      <div key={i} style={{ position: 'absolute', left: pct(toMin(x.start) ?? 0), width: `calc(${pct(toMin(x.end) ?? 0)} - ${pct(toMin(x.start) ?? 0)})`, height: 14, borderRadius: 3, background: on ? '#c8e6c9' : '#e1f5ee', color: '#085041', fontSize: 10.5, lineHeight: '14px', paddingLeft: 3, overflow: 'hidden', whiteSpace: 'nowrap', boxSizing: 'border-box' }}>
                        {minText(toMin(x.start) ?? 0)}-{minText(toMin(x.end) ?? 0)}
                      </div>
                    ))}
                    {on && <div style={{ position: 'absolute', left: pct(preview.s), width: `calc(${pct(preview.e)} - ${pct(preview.s)})`, top: -5, bottom: -5, border: `2px solid ${red}`, borderRadius: 3 }} />}
                  </div>
                </div>
              );
            })}
            <div style={{ marginTop: 8, fontSize: 13 }}>
              勤務表の欄：<b style={{ color: green }}>{preview.label}</b>
              {preview.common.length > 0 && <span style={{ color: subText, marginLeft: '1em' }}>そろう時間：{preview.common.map(([a, b]) => `${minText(a)}〜${minText(b)}`).join('・')}</span>}
              {editor.members.length >= 2 && preview.common.length === 0 && <span style={{ color: red, marginLeft: '1em' }}>選んだ人がこの校でそろう時間がありません</span>}
            </div>
            {preview.memberNotes.filter(m => m.issue).map(m => (
              <div key={m.id} style={{ fontSize: 12.5, color: red }}>
                ⚠️ {fullNames.get(m.id)}さん：{m.issue!.kind === 'no_shift' ? '週のシフトが未登録です' : m.issue!.kind === 'off' ? 'この曜日は休みです'
                  : m.issue!.kind === 'outside' ? 'この時間に勤務していません' : m.issue!.kind === 'partial' ? '一部の時間が勤務時間外です'
                  : m.issue!.kind === 'other_school' ? `この時間 ${m.issue!.detail}` : `校を確かめられません（${m.issue!.detail}）`}（保存はできます）
              </div>
            ))}
            {preview.dup.map(v => (
              <div key={v.id} style={{ fontSize: 12.5, color: '#856404' }}>⚠️ 同じ曜日・同じ参加者で時刻だけ違う勉強会があります（{studyLabel(v, shortNames)}）</div>
            ))}
          </div>

          {editorErrors.length > 0 && <div style={{ color: red, marginTop: 6 }}>{editorErrors.map(x => <div key={x}>・{x}</div>)}</div>}
          {confirmPast && (
            <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 8, background: '#fff3cd', color: '#856404' }}>
              ⚠️ 今日より前の日付（{mdText(editor.applyFrom)}）からさかのぼって保存します。
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" disabled={saving || editorErrors.length > 0} onClick={() => void doSave()}
              style={{ ...primaryBtn, opacity: saving || editorErrors.length > 0 ? 0.5 : 1, cursor: editorErrors.length > 0 ? 'default' : 'pointer' }}>
              {saving ? '保存中…' : confirmPast ? 'さかのぼって保存する' : '保存する'}
            </button>
            <button type="button" disabled={saving} onClick={() => { setEditor(null); setConfirmPast(false); }} style={{ ...inputStyle, cursor: 'pointer' }}>やめる</button>
          </div>
        </div>
      )}

      {/* 一覧（2026-10-06 作り直し・ユーザー確定）：1件1行の表。部門で絞る。行を押すと中身・⚠️・［修正］［終わらせる］が開く */}
      {(() => {
        const areaOf = (id: string | null) => areas.find(a => a.id === id) ?? null;
        const usedAreaIds = new Set(shown.map(v => v.area_id ?? 'none'));
        const list0 = shown.filter(v => areaFilter === 'all' || (areaFilter === 'none' ? !v.area_id : v.area_id === areaFilter));
        // 始まる日がみんな同じなら、上に1回だけ書く（行ごとには出さない）
        const startsAll = [...new Set(list0.map(v => (v.valid_from > baseDate ? v.valid_from : '')))];
        const commonStart = startsAll.length === 1 && startsAll[0] ? startsAll[0] : null;
        const names = (ids: string[]) => ids.map(id => fullNames.get(id) ?? '（不明）').join('・');
        const th: React.CSSProperties = { textAlign: 'left', fontSize: 11.5, fontWeight: 'normal', color: subText, padding: '4px 8px', whiteSpace: 'nowrap' };
        const td: React.CSSProperties = { padding: '7px 8px', fontSize: 13, color: text, borderTop: `1px solid ${borderColor}`, verticalAlign: 'top' };
        return (
          <>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
              <button type="button" onClick={() => setAreaFilter('all')} style={toggle(areaFilter === 'all')}>すべて</button>
              {areas.filter(a => usedAreaIds.has(a.id)).map(a => (
                <button key={a.id} type="button" onClick={() => setAreaFilter(a.id)} style={toggle(areaFilter === a.id)}>{a.name}</button>
              ))}
              {usedAreaIds.has('none') && <button type="button" onClick={() => setAreaFilter('none')} style={toggle(areaFilter === 'none')}>部門なし</button>}
              {commonStart && <span style={{ fontSize: 12.5, color: subText, marginLeft: 6 }}>{mdText(commonStart)} から始まる勉強会です（{list0.length}件）</span>}
            </div>
            {list0.length === 0 && <p style={{ color: subText, fontSize: 13 }}>{mdText(baseDate)} に効いている勉強会はありません。</p>}
            {list0.length > 0 && (
              <div style={{ overflowX: 'auto', border: `1px solid ${borderColor}`, borderRadius: 8, background: cardBg }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 620, fontVariantNumeric: 'tabular-nums', textAlign: 'left' }}>
                  <thead>
                    <tr><th style={th}>時刻</th><th style={th}>長さ</th><th style={th}>部門</th><th style={th}>校</th><th style={th}>講師</th><th style={th}>参加</th><th style={th} /></tr>
                  </thead>
                  <tbody>
                    {ROSTER_WEEK.map(k => {
                      const list = list0.filter(v => v.day_kind === k).sort((a, b) => studyStartMin(a) - studyStartMin(b));
                      if (list.length === 0) return null;
                      return (
                        <React.Fragment key={k}>
                          <tr><td colSpan={7} style={{ padding: '6px 8px', fontSize: 12.5, fontWeight: 'bold', color: subText, background: innerBg, borderTop: `1px solid ${borderColor}` }}>{ROSTER_DAY_LABEL[k]}曜</td></tr>
                          {list.map(v => {
                            const issues = issuesOf(v);
                            const open = openId === v.id;
                            const unackedHere = issues.filter(i => !isAcked(v, i.key)).length;
                            const next = nextChange(v);
                            const ownStart = !commonStart && v.valid_from > baseDate;
                            const area = areaOf(v.area_id);
                            const c = area ? (AREA_COLORS[area.color] ?? AREA_COLORS.gray) : null;
                            const futureVersions = ending?.sessionId === v.session_id ? versions.filter(x => x.session_id === v.session_id && x.valid_from > ending.date) : [];
                            const others = v.members.filter(id => !v.teachers.includes(id));
                            return (
                              <React.Fragment key={v.id}>
                                <tr onClick={() => setOpenId(open ? null : v.id)} style={{ cursor: 'pointer', background: open ? innerBg : undefined }}>
                                  <td style={{ ...td, whiteSpace: 'nowrap', fontWeight: 'bold' }}>{minText(studyStartMin(v))}〜{minText(studyEndMin(v))}</td>
                                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{v.duration_minutes}分</td>
                                  <td style={td}>{area && c ? <span style={{ fontSize: 11.5, padding: '1px 6px', borderRadius: 4, background: c.bg, color: c.fg, whiteSpace: 'nowrap' }}>{area.name}</span> : <span style={{ color: subText }}>—</span>}</td>
                                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{v.location ?? '—'}{v.floor ? ` ${v.floor}` : ''}</td>
                                  <td style={{ ...td, fontWeight: 'bold' }}>{names(v.teachers)}</td>
                                  <td style={td}>
                                    {names(others)}
                                    {v.memo && <div style={{ fontSize: 11.5, color: subText, marginTop: 1 }}>備考：{v.memo}</div>}
                                    {ownStart && <span style={{ marginLeft: 6, fontSize: 11, padding: '0 6px', borderRadius: 8, background: '#e8f4fd', color: '#1565c0', whiteSpace: 'nowrap' }}>{mdText(v.valid_from)}から</span>}
                                    {next && <span style={{ marginLeft: 6, fontSize: 11, padding: '0 6px', borderRadius: 8, background: '#fff3cd', color: '#856404', whiteSpace: 'nowrap' }}>{mdText(next)}から変わる</span>}
                                    {v.valid_to && !next && <span style={{ marginLeft: 6, fontSize: 11, color: subText, whiteSpace: 'nowrap' }}>{mdText(v.valid_to)}まで</span>}
                                  </td>
                                  <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right', color: subText }}>
                                    {unackedHere > 0 && <span style={{ color: red, marginRight: 6 }}>⚠️</span>}{open ? '▲' : '›'}
                                  </td>
                                </tr>
                                {open && (
                                  <tr><td colSpan={7} style={{ padding: '8px 10px 10px', background: innerBg, fontSize: 13, color: text }}>
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontSize: 12, color: subText }}>勤務表の欄：<span style={{ color: green }}>{studyCellText(v, shortNames)}</span></div>
                                        {v.memo && <div style={{ fontSize: 12.5, marginTop: 2 }}>備考：{v.memo}</div>}
                                        {issues.length === 0 && <div style={{ fontSize: 12, color: subText, marginTop: 2 }}>勤務時間・校との食い違いはありません</div>}
                                        {issues.map(i => {
                                          const acked = isAcked(v, i.key);
                                          return (
                                            <div key={i.key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, color: acked ? subText : red, marginTop: 4 }}>
                                              <span>{acked ? '✓' : '⚠️'} {i.since > baseDate ? `${mdText(i.since)}から ` : ''}{i.text}{acked ? '（確認済み）' : ''}</span>
                                              {!acked && <button type="button" onClick={() => void ack(v, i.key)} style={{ ...inputStyle, cursor: 'pointer', fontSize: 12, padding: '2px 8px' }}>確認した</button>}
                                            </div>
                                          );
                                        })}
                                      </div>
                                      <span style={{ display: 'flex', gap: 6 }}>
                                        <button type="button" onClick={() => startEdit(v)} style={{ ...inputStyle, cursor: 'pointer' }}>修正</button>
                                        <button type="button" onClick={() => { setEditor(null); setMsg(''); setErr(''); setEnding({ sessionId: v.session_id, date: baseDate > v.valid_from ? baseDate : v.valid_from }); }} style={{ ...inputStyle, cursor: 'pointer' }}>終わらせる</button>
                                      </span>
                                    </div>
                                    {ending?.sessionId === v.session_id && (
                                      <div style={{ marginTop: 6, padding: '8px 10px', borderRadius: 8, background: '#fff3cd', border: '1px solid #ffc107', color: '#856404' }}>
                                        <label>この日まで <input type="date" value={ending.date} style={inputStyle} onChange={e => { if (e.target.value) setEnding({ ...ending, date: e.target.value }); }} /></label>
                                        <span> で終わらせます。</span>
                                        {futureVersions.map(f => <div key={f.id}>・{mdText(f.valid_from)}からの変更（{minText(studyStartMin(f))}）も取り消します</div>)}
                                        {ending.date < today && <div>⚠️ 今日より前の日付です。</div>}
                                        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                                          <button type="button" disabled={saving} onClick={() => void doEnd()} style={primaryBtn}>{saving ? '保存中…' : '終わらせる'}</button>
                                          <button type="button" disabled={saving} onClick={() => setEnding(null)} style={{ ...inputStyle, cursor: 'pointer' }}>やめる</button>
                                        </div>
                                      </div>
                                    )}
                                  </td></tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        );
      })()}
      {loading && <p style={{ color: subText, fontSize: 12 }}>読み込んでいます...</p>}
      <p style={{ margin: '8px 0 0', fontSize: 11.5, color: subText }}>
        ⚠️ は保存済みの週のシフト（{mdText(rosterSince)} 以降）から計算しています。休憩の時刻は持っていないので、休憩と重なるかは分かりません。
      </p>
    </div>
  );
};

export default StudySessionsPanel;
