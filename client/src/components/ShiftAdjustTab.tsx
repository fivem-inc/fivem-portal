import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../lib/supabaseClient';
import { todayJstStr } from '../lib/breakCalc';
import type { DayKind } from '../lib/breakCalc';
import { normalShiftTimeText } from '../lib/overtimeShift';
import { actedAtLabel } from '../lib/actedAt';
import { insertNotification } from '../lib/notifications';
import TimeInput from './TimeInput';
import { toDbTime } from '../lib/timeInput';

// ───────────────────────────────────────────────────────────────
// シフト調整の作業場（勤怠カレンダーの中のタブ）
//
// 設計は docs/計画-シフト調整.md。
// 🚨 CalendarPage.tsx は 2,400行を超えているので、中身はこの別ファイルに置く。
//    あちらに足すのは「タブ」と「この部品を呼ぶ1行」だけ。
// 🚨 休んだ本人には見えない。判定はDB（RLS）が持っていて、画面は何もしない
//    （画面で隠すと、DBを直接見られたときに素通りする）。
// 🚨 文体は「見出しは体言止め・文はです・ます」（2026-09-13 ユーザー確定）。
//    このアプリの他の画面と同じ形にしてある。
// ───────────────────────────────────────────────────────────────

interface Perms {
  view: boolean;
  review: boolean;
  plan: boolean;
  request: boolean;
  decide: boolean;
}

interface SlotRow {
  id: string;
  target_user_id: string;
  target_date: string;
  cause: string;
  cause_leave_request_id: string | null;
  cause_attendance_exception_id: string | null;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
}

interface CommentRow { id: string; user_id: string; body: string; created_at: string }
interface ProfileRow { id: string; name: string | null; employment_type: string | null }
interface PatternRow {
  user_id: string; day_kind: string;
  start_time: string | null; end_time: string | null;
  start_time2: string | null; end_time2: string | null;
  location: string | null;
}
interface AssignRow {
  id: string; user_id: string; kind: string;
  segments: { start: string; end: string; location?: string }[];
  attendance_exception_id: string | null;
  application_request_id: string | null;
}

/** その日に「もう働けない」人と、その理由 */
type BusyMap = Record<string, string>;

const DAY_KINDS: DayKind[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DOW = ['日', '月', '火', '水', '木', '金', '土'];

/** "2026-09-19" → "9/19（土）"。🚨 new Date(文字列) に頼らず日本時間で組み立てる */
const dateLabel = (d: string): string => {
  const [y, m, dd] = d.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
  return `${m}/${dd}（${DOW[w]}）`;
};
const dayKindOf = (d: string): DayKind => {
  const [y, m, dd] = d.split('-').map(Number);
  return DAY_KINDS[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
};
const daysUntil = (d: string): number => {
  const [y, m, dd] = d.split('-').map(Number);
  const [ty, tm, td] = todayJstStr().split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, dd) - Date.UTC(ty, tm - 1, td)) / 86400000);
};

const STATUS_LABEL: Record<string, string> = {
  pending: '未調整',
  working: '調整中',
  decided: '調整済み',
  no_change: '確認済み（変更なし）',
  closed_past: '過ぎた日',
  cause_cancelled: '休みが取り消されました',
};

const ShiftAdjustTab: React.FC<{
  userId: string;
  isDark: boolean;
  isMobile: boolean;
  perms: Perms;
  /** 欠勤の行の印から来たとき、その場をいきなり開く */
  initialSlotId?: string | null;
  onConsumedInitial?: () => void;
}> = ({ userId, isDark, isMobile, perms, initialSlotId, onConsumedInitial }) => {
  const text = isDark ? '#e9ecef' : '#333';
  const subText = isDark ? '#adb5bd' : '#666';
  const cardBg = isDark ? '#343a40' : '#fff';
  const border = isDark ? '#495057' : '#e0e0e0';
  // 🚨 新しい色は足さない。未＝既存の橙／済んだもの＝グレー
  const warnFg = isDark ? '#ffcf8f' : '#b7770d';
  const warnBg = isDark ? '#4a3a1a' : '#fff8e1';
  const warnBd = isDark ? '#7a5a1a' : '#f0c36d';

  const [slots, setSlots] = useState<SlotRow[]>([]);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [workplaces, setWorkplaces] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const nameOf = useCallback(
    (id: string | null | undefined): string => (id ? (profiles.find(p => p.id === id)?.name || '') : ''),
    [profiles],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    // 🚨 error を必ず見る。読めないまま「0件」と出すと、画面が嘘をつく
    const [{ data: sData, error: sErr }, { data: pData, error: pErr }, { data: wData }] = await Promise.all([
      supabase.from('shift_adjust_slots')
        .select('id, target_user_id, target_date, cause, cause_leave_request_id, cause_attendance_exception_id, status, decided_by, decided_at')
        .gte('target_date', todayJstStr())
        .order('target_date', { ascending: true }),
      supabase.from('profiles').select('id, name, employment_type').eq('is_active', true),
      supabase.from('master_options').select('value').eq('category', 'workplace').order('sort_order'),
    ]);
    if (sErr) { setErr('調整の場を読み込めませんでした：' + sErr.message); setLoading(false); return; }
    if (pErr) { setErr('スタッフの一覧を読み込めませんでした：' + pErr.message); setLoading(false); return; }
    setSlots((sData as SlotRow[] | null) ?? []);
    setProfiles((pData as ProfileRow[] | null) ?? []);
    setWorkplaces(((wData as { value: string }[] | null) ?? []).map(r => r.value));
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 欠勤の行の印から来たときは、その場をいきなり開く。
  // 🚨 一度使ったら親の値を消す（戻ったときにまた開いてしまうため）
  useEffect(() => {
    if (initialSlotId) { setOpenId(initialSlotId); onConsumedInitial?.(); }
  }, [initialSlotId, onConsumedInitial]);

  // 🚨 過ぎた日・休みが取り消されたものは出さない（片付けようがない）
  const shown = useMemo(() => {
    const live = slots.filter(s => !['closed_past', 'cause_cancelled'].includes(s.status));
    return showDone ? live : live.filter(s => ['pending', 'working'].includes(s.status));
  }, [slots, showDone]);

  const pendingCount = useMemo(
    () => slots.filter(s => ['pending', 'working'].includes(s.status)).length, [slots],
  );

  const openSlot = slots.find(s => s.id === openId) ?? null;

  if (openSlot) {
    return (
      <SlotDetail
        slot={openSlot} userId={userId} isDark={isDark} isMobile={isMobile}
        perms={perms} profiles={profiles} workplaces={workplaces} nameOf={nameOf}
        onBack={() => { setOpenId(null); void load(); }}
      />
    );
  }

  return (
    <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${border}`, padding: isMobile ? 14 : 18, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 'bold', color: text }}>未調整（本日以降）</span>
        <span style={{ fontSize: 12, color: subText }}>{pendingCount}件</span>
        <button onClick={() => setShowDone(v => !v)}
          style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 12, color: isDark ? '#64b5f6' : '#0d6efd', textDecoration: 'underline' }}>
          {showDone ? '未調整のみ表示' : '対応済みも表示'}
        </button>
      </div>

      {err && (
        <p style={{ margin: '0 0 10px', padding: '8px 10px', borderRadius: 8, fontSize: 12.5,
          background: '#f8d7da', color: '#842029' }}>{err}</p>
      )}

      {loading ? (
        <p style={{ margin: 0, fontSize: 12.5, color: subText }}>読み込んでいます…</p>
      ) : shown.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12.5, color: subText, lineHeight: 1.8 }}>
          {showDone ? '本日以降の調整はありません。' : '未調整はありません。'}
        </p>
      ) : (
        <div>
          {shown.map(s => {
            const soon = s.status !== 'decided' && s.status !== 'no_change' && daysUntil(s.target_date) <= 7;
            const undone = ['pending', 'working'].includes(s.status);
            return (
              <button key={s.id} type="button" onClick={() => setOpenId(s.id)}
                style={{
                  width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8,
                  padding: '10px 8px', border: 'none', borderBottom: `1px solid ${border}`,
                  background: 'transparent', cursor: 'pointer', color: text, fontSize: isMobile ? 13 : 14,
                }}>
                <span style={{ color: soon ? warnFg : subText, fontSize: isMobile ? 12 : 13, whiteSpace: 'nowrap', fontWeight: soon ? 'bold' : 'normal' }}>
                  {dateLabel(s.target_date)}
                </span>
                <span style={{ fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {nameOf(s.target_user_id) || '（名前を読み込めませんでした）'}
                </span>
                <span style={{ fontSize: 11, color: subText, whiteSpace: 'nowrap' }}>
                  {s.cause === 'absent' ? '欠勤' : '休暇'}
                </span>
                <span style={{
                  marginLeft: 'auto', fontSize: 10.5, fontWeight: 'bold', padding: '2px 8px', borderRadius: 10,
                  whiteSpace: 'nowrap',
                  color: undone ? warnFg : subText,
                  background: s.status === 'pending' ? warnBg : 'transparent',
                  border: `1px solid ${undone ? warnBd : border}`,
                }}>
                  {STATUS_LABEL[s.status] ?? s.status}
                </span>
                <span style={{ color: subText, fontSize: 14 }}>›</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ───────────────────────────────────────────────────────────────
// 調整の場（1件）
// ───────────────────────────────────────────────────────────────
interface Draft { key: number; userId: string; start: string; end: string; location: string }

const SlotDetail: React.FC<{
  slot: SlotRow;
  userId: string;
  isDark: boolean;
  isMobile: boolean;
  perms: Perms;
  profiles: ProfileRow[];
  workplaces: string[];
  nameOf: (id: string | null | undefined) => string;
  onBack: () => void;
}> = ({ slot, userId, isDark, isMobile, perms, profiles, workplaces, nameOf, onBack }) => {
  const text = isDark ? '#e9ecef' : '#333';
  const subText = isDark ? '#adb5bd' : '#666';
  const cardBg = isDark ? '#343a40' : '#fff';
  const border = isDark ? '#495057' : '#e0e0e0';
  const warnFg = isDark ? '#ffcf8f' : '#b7770d';
  const inputBg = isDark ? '#2b3035' : '#fff';

  const [status, setStatus] = useState(slot.status);
  const [assigns, setAssigns] = useState<AssignRow[]>([]);
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const [okMsg, setOkMsg] = useState('');
  const [busyBtn, setBusyBtn] = useState(false);

  const [showCandidates, setShowCandidates] = useState(false);
  const [patterns, setPatterns] = useState<PatternRow[]>([]);
  const [busy, setBusy] = useState<BusyMap>({});
  const [candLoaded, setCandLoaded] = useState(false);
  const [candErr, setCandErr] = useState('');
  const [where, setWhere] = useState('');

  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [memo, setMemo] = useState('');
  const [doAttendance, setDoAttendance] = useState(true);
  const [doRequest, setDoRequest] = useState(true);
  const [confirmUndo, setConfirmUndo] = useState(false);

  const loadComments = useCallback(async () => {
    const { data, error } = await supabase.from('shift_adjust_comments')
      .select('id, user_id, body, created_at').eq('slot_id', slot.id)
      .order('created_at', { ascending: true });
    if (error) { setErr('相談を読み込めませんでした：' + error.message); return; }
    setComments((data as CommentRow[] | null) ?? []);
  }, [slot.id]);

  const loadAssigns = useCallback(async () => {
    const { data, error } = await supabase.from('shift_adjust_assignments')
      .select('id, user_id, kind, segments, attendance_exception_id, application_request_id')
      .eq('slot_id', slot.id);
    if (error) { setErr('決定の内容を読み込めませんでした：' + error.message); return; }
    setAssigns((data as AssignRow[] | null) ?? []);
  }, [slot.id]);

  useEffect(() => { void loadComments(); void loadAssigns(); }, [loadComments, loadAssigns]);

  // 見出しに出す校。休暇なら日ごとの勤務校、欠勤なら記録の校
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (slot.cause_leave_request_id) {
        const { data } = await supabase.from('leave_requests').select('leave_locations')
          .eq('id', slot.cause_leave_request_id).maybeSingle();
        if (!alive || !data) return;
        try {
          const map = JSON.parse((data as { leave_locations: string | null }).leave_locations || '{}') as Record<string, string>;
          setWhere(map[slot.target_date] ?? '');
        } catch { setWhere(''); }
      } else if (slot.cause_attendance_exception_id) {
        const { data } = await supabase.from('attendance_exceptions').select('location')
          .eq('id', slot.cause_attendance_exception_id).maybeSingle();
        if (!alive || !data) return;
        setWhere((data as { location: string | null }).location ?? '');
      }
    })();
    return () => { alive = false; };
  }, [slot.cause_leave_request_id, slot.cause_attendance_exception_id, slot.target_date]);

  // 候補は押したときに初めて読む（見ない人のぶんまで通信しない）
  const loadCandidates = useCallback(async () => {
    setCandErr('');
    const d = slot.target_date;
    const [{ data: pat, error: patErr }, { data: att }, { data: lv }] = await Promise.all([
      supabase.from('weekly_shift_patterns')
        .select('user_id, day_kind, start_time, end_time, start_time2, end_time2, location, valid_from, valid_to')
        .eq('day_kind', dayKindOf(d)).lte('valid_from', d),
      supabase.from('attendance_exceptions').select('user_id, type').eq('date', d),
      supabase.from('leave_requests').select('user_id, leave_dates, start_date, end_date, status')
        .in('status', ['manager_approved', 'admin_approved', 'approved'])
        .lte('start_date', d).gte('end_date', d),
    ]);
    if (patErr) {
      // 🚨 権限が無いと読めない。黙って0件にしない
      setCandErr('週の基本シフトを読み込めませんでした（「全員のシフト予定 閲覧」の権限が必要です）');
    }
    setPatterns(((pat as (PatternRow & { valid_from: string; valid_to: string | null })[] | null) ?? [])
      .filter(p => p.valid_to === null || p.valid_to >= d));

    const b: BusyMap = {};
    for (const a of ((att as { user_id: string; type: string }[] | null) ?? [])) {
      if (a.type === 'absent') b[a.user_id] = 'この日は欠勤';
      else if (a.type === 'holiday_work') b[a.user_id] = 'この日は休日出勤';
    }
    for (const l of ((lv as { user_id: string; leave_dates: string | null }[] | null) ?? [])) {
      let hit = true;
      try {
        const arr = JSON.parse(l.leave_dates || '[]') as string[];
        if (Array.isArray(arr) && arr.length > 0) hit = arr.includes(d);
      } catch { hit = true; }
      if (hit) b[l.user_id] = 'この日は休み';
    }
    setBusy(b);
    setCandLoaded(true);
  }, [slot.target_date]);

  const toggleCandidates = () => {
    const next = !showCandidates;
    setShowCandidates(next);
    if (next && !candLoaded) void loadCandidates();
  };

  const send = async () => {
    const t = body.trim();
    if (!t || sending) return;
    setSending(true); setErr('');
    // 🚨 error を必ず見る。投げっぱなしにすると、書けていないのに消えたように見える
    const { error } = await supabase.from('shift_adjust_comments')
      .insert({ slot_id: slot.id, user_id: userId, body: t });
    setSending(false);
    if (error) { setErr('送信できませんでした：' + error.message); return; }
    setBody('');
    void loadComments();
  };

  const setSlotStatus = async (next: 'pending' | 'working' | 'no_change') => {
    setErr(''); setOkMsg(''); setBusyBtn(true);
    const { data, error } = await supabase.rpc('shift_adjust_set_status', { p_slot_id: slot.id, p_status: next });
    setBusyBtn(false);
    // 🚨 rpc は 4xx でも throw しない。error と ok の両方を見る
    if (error) { setErr('変更できませんでした：' + error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.ok) { setErr(row?.reason || '変更できませんでした'); return; }
    setStatus(next);
    if (next === 'no_change') setOkMsg('現行シフトで対応として記録しました。');
    if (next === 'working') {
      setOkMsg('');
      if (!showCandidates) { setShowCandidates(true); if (!candLoaded) void loadCandidates(); }
      if (drafts.length === 0) addDraft();
    }
    if (next === 'pending') setOkMsg('未調整に戻しました。');
  };

  const addDraft = () => {
    setDrafts(d => [...d, {
      key: Date.now() + Math.random(), userId: '', start: '', end: '',
      location: where || workplaces[0] || '',
    }]);
  };
  const patchDraft = (key: number, p: Partial<Draft>) =>
    setDrafts(d => d.map(x => (x.key === key ? { ...x, ...p } : x)));
  const removeDraft = (key: number) => setDrafts(d => d.filter(x => x.key !== key));

  const kindOf = (uid: string): 'attendance' | 'overtime_request' =>
    profiles.find(p => p.id === uid)?.employment_type === 'パート' ? 'attendance' : 'overtime_request';

  const decide = async () => {
    setErr(''); setOkMsg('');
    if (drafts.length === 0) { setErr('出勤する人を選んでください。'); return; }
    for (const d of drafts) {
      if (!d.userId) { setErr('出勤する人を選んでください。'); return; }
      const s = toDbTime(d.start); const e = toDbTime(d.end);
      if (!s || !e) { setErr('開始時刻と終了時刻を入力してください。'); return; }
      if (e <= s) { setErr('終了時刻は開始時刻より後にしてください。'); return; }
    }
    if (new Set(drafts.map(d => d.userId)).size !== drafts.length) {
      setErr('同じ方が2回選ばれています。'); return;
    }
    setBusyBtn(true);
    const payload = drafts.map(d => ({
      user_id: d.userId,
      kind: kindOf(d.userId),
      segments: [{ start: (toDbTime(d.start) || '').slice(0, 5), end: (toDbTime(d.end) || '').slice(0, 5), location: d.location || null }],
    }));
    const { data, error } = await supabase.rpc('shift_adjust_decide', {
      p_slot_id: slot.id, p_assignments: payload,
      p_do_attendance: doAttendance, p_do_request: doRequest, p_memo: memo.trim() || null,
    });
    if (error) { setBusyBtn(false); setErr('決定できませんでした：' + error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.ok) { setBusyBtn(false); setErr(row?.reason || '決定できませんでした'); return; }

    // 🚨 お知らせは画面から送る（DBからは Edge Function を呼べない）。
    //    文面は既存の申請依頼（ApplicationRequestSheet）と同じ形に揃える
    const reqIds: string[] = row.request_ids ?? [];
    if (reqIds.length > 0) {
      const dl = `${Number(slot.target_date.slice(5, 7))}/${Number(slot.target_date.slice(8, 10))}`;
      const me = nameOf(userId) || '担当者';
      const targets = drafts.filter(d => kindOf(d.userId) === 'overtime_request');
      for (let i = 0; i < targets.length && i < reqIds.length; i++) {
        await insertNotification(
          targets[i].userId,
          `📩 ${me}さんより申請依頼：${dl} 残業・時間管理`,
          memo.trim() || undefined,
          'application_request:received',
          reqIds[i],
          'application_request:received',
        );
      }
    }
    setBusyBtn(false);
    setStatus('decided');
    setDrafts([]);
    setOkMsg('決定しました。');
    void loadAssigns();
  };

  const undecide = async () => {
    setErr(''); setOkMsg(''); setBusyBtn(true);
    const { data, error } = await supabase.rpc('shift_adjust_undecide', { p_slot_id: slot.id });
    setBusyBtn(false); setConfirmUndo(false);
    if (error) { setErr('取り消せませんでした：' + error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.ok) { setErr(row?.reason || '取り消せませんでした'); return; }
    setStatus('working');
    setAssigns([]);
    setOkMsg('決定を取り消しました。');
    void loadAssigns();
  };

  // 候補の並び
  const working = profiles
    .filter(p => p.id !== slot.target_user_id && patterns.some(x => x.user_id === p.id && x.start_time))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
  const restingPart = profiles
    .filter(p => p.id !== slot.target_user_id && p.employment_type === 'パート'
      && !patterns.some(x => x.user_id === p.id && x.start_time))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));

  const shiftTextOf = (uid: string): string => {
    const p = patterns.find(x => x.user_id === uid);
    return p ? normalShiftTimeText({
      start_time: p.start_time, end_time: p.end_time,
      start_time2: p.start_time2, end_time2: p.end_time2,
    }) : '';
  };
  const locOf = (uid: string): string => patterns.find(x => x.user_id === uid)?.location ?? '';

  const box: React.CSSProperties = {
    background: cardBg, borderRadius: 12, border: `1px solid ${border}`,
    padding: isMobile ? 14 : 18, marginBottom: 12,
  };
  const head: React.CSSProperties = { fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 8 };
  const mainBtn: React.CSSProperties = {
    padding: '12px 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
    fontSize: 14, fontWeight: 'bold', background: '#1976d2', color: '#fff',
  };
  const subBtn: React.CSSProperties = {
    padding: '12px 18px', borderRadius: 10, cursor: 'pointer', fontSize: 14, fontWeight: 'bold',
    border: `1px solid ${border}`, background: isDark ? '#495057' : '#f8f9fa', color: text,
  };
  const quietBtn: React.CSSProperties = {
    marginLeft: 'auto', padding: '6px 4px', fontSize: 12.5, cursor: 'pointer',
    border: 'none', background: 'transparent', color: subText, textDecoration: 'underline',
  };
  const sel: React.CSSProperties = {
    padding: '8px 10px', borderRadius: 8, fontSize: 13.5,
    border: `1px solid ${border}`, background: inputBg, color: text,
  };

  // 「対応の選択」を出すのは、決められる人で、まだ未調整で、決まっていないとき
  const showFork = perms.decide && status === 'pending' && assigns.length === 0;

  return (
    <div>
      <button onClick={onBack}
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13,
          color: isDark ? '#64b5f6' : '#0d6efd', padding: '4px 0', marginBottom: 8 }}>
        ‹ 一覧へ
      </button>

      {/* 見出し */}
      <div style={box}>
        <div style={{ fontSize: isMobile ? 16 : 18, fontWeight: 'bold', color: text }}>
          {dateLabel(slot.target_date)}
          {where && <span style={{ marginLeft: 10, fontSize: isMobile ? 13 : 14, color: subText }}>{where}</span>}
        </div>
        <div style={{ fontSize: 13.5, color: text, marginTop: 4 }}>
          {nameOf(slot.target_user_id) || '（名前を読み込めませんでした）'}さんの
          {slot.cause === 'absent' ? '欠勤' : '休み'}
        </div>
        <div style={{ fontSize: 12, color: ['pending', 'working'].includes(status) ? warnFg : subText, marginTop: 6 }}>
          状態：{STATUS_LABEL[status] ?? status}
          {slot.decided_at && status === 'no_change' && (
            <span style={{ color: subText, marginLeft: 10 }}>
              {nameOf(slot.decided_by) ? `${nameOf(slot.decided_by)}・` : ''}
              {actedAtLabel(slot.decided_at)}
            </span>
          )}
        </div>
      </div>

      {/* 対応の選択（まず決めることを最初に出す） */}
      {showFork && (
        <div style={box}>
          <div style={head}>対応の選択</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button onClick={() => void setSlotStatus('working')} disabled={busyBtn} style={mainBtn}>
              シフトを調整する
            </button>
            <button onClick={() => void setSlotStatus('no_change')} disabled={busyBtn} style={subBtn}>
              現行シフトで対応
            </button>
            {/* 🚨 いま判断できないときの逃げ道。枠線なし・下線のみで右端へ離し、
                「3つ目の選択肢」に見えないようにする（シフト調整の「閉じる」と同じ形） */}
            <button onClick={onBack} style={quietBtn}>後で決める</button>
          </div>
        </div>
      )}

      {/* 出勤する人 */}
      {!showFork && status !== 'no_change' && (
        <div style={box}>
          <div style={head}>出勤する人</div>

          {assigns.length > 0 ? (
            <>
              {assigns.map(a => (
                <div key={a.id} style={{ padding: '6px 0', fontSize: 13.5, color: text }}>
                  <span style={{ fontWeight: 'bold' }}>{nameOf(a.user_id) || '（名前なし）'}</span>
                  <span style={{ marginLeft: 10, color: subText, fontSize: 12.5 }}>
                    {(a.segments ?? []).map(s => `${s.start}〜${s.end}`).join(' ＋ ')}
                    {a.segments?.[0]?.location ? ` / ${a.segments[0].location}` : ''}
                  </span>
                  <span style={{ marginLeft: 10, color: subText, fontSize: 11.5 }}>
                    {a.kind === 'attendance'
                      ? (a.attendance_exception_id ? '勤怠に登録済み' : '勤怠には未登録')
                      : (a.application_request_id ? '残業申請を依頼済み' : '依頼なし')}
                  </span>
                </div>
              ))}
              {perms.decide && (
                <div style={{ marginTop: 12 }}>
                  {confirmUndo ? (
                    <div style={{ padding: '10px 12px', borderRadius: 8, border: `1px solid ${border}`,
                      background: isDark ? '#3a3f44' : '#f8f9fa' }}>
                      <p style={{ margin: '0 0 8px', fontSize: 12.5, color: text, lineHeight: 1.8 }}>
                        決定を取り消します。登録した勤怠は削除し、残業申請の依頼は取り下げます。
                        （申請が済んでいる依頼はそのまま残ります）
                      </p>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <button onClick={() => void undecide()} disabled={busyBtn} style={subBtn}>取り消す</button>
                        <button onClick={() => setConfirmUndo(false)} style={quietBtn}>やめる</button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => setConfirmUndo(true)} style={subBtn}>決定を取り消す</button>
                  )}
                </div>
              )}
            </>
          ) : perms.decide && status === 'working' ? (
            <>
              {drafts.length === 0 && (
                <p style={{ margin: '0 0 8px', fontSize: 12.5, color: subText }}>まだ決まっていません。</p>
              )}
              {drafts.map(d => {
                const k = d.userId ? kindOf(d.userId) : null;
                return (
                  <div key={d.key} style={{ padding: '8px 0', borderBottom: `1px solid ${border}` }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <select value={d.userId} onChange={e => patchDraft(d.key, { userId: e.target.value })}
                        style={{ ...sel, minWidth: 150 }}>
                        <option value="">出勤する人を選択</option>
                        {profiles
                          .filter(p => p.id !== slot.target_user_id)
                          .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'))
                          .map(p => (
                            <option key={p.id} value={p.id}>
                              {p.name}{p.employment_type === 'パート' ? '（パート）' : ''}
                            </option>
                          ))}
                      </select>
                      <button onClick={() => removeDraft(d.key)} style={{ ...quietBtn, marginLeft: 0 }}>削除</button>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
                      <TimeInput value={d.start} onChange={v => patchDraft(d.key, { start: v })} isDark={isDark} ariaLabel="開始時刻" />
                      <span style={{ color: subText }}>〜</span>
                      <TimeInput value={d.end} onChange={v => patchDraft(d.key, { end: v })} isDark={isDark} ariaLabel="終了時刻" />
                      <select value={d.location} onChange={e => patchDraft(d.key, { location: e.target.value })} style={sel}>
                        <option value="">校を選択</option>
                        {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
                      </select>
                    </div>
                    {k && (
                      <div style={{ fontSize: 11.5, color: subText, marginTop: 4 }}>
                        {k === 'attendance' ? '勤怠に休日出勤として登録します。' : '残業申請を依頼します。'}
                      </div>
                    )}
                  </div>
                );
              })}
              <button onClick={addDraft} style={{ ...quietBtn, marginLeft: 0, marginTop: 8 }}>＋ 出勤する人を追加</button>

              <div style={{ marginTop: 12, display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5, color: text }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={doAttendance} onChange={e => setDoAttendance(e.target.checked)} />
                  勤怠に登録する
                </label>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={doRequest} onChange={e => setDoRequest(e.target.checked)} />
                  残業申請を依頼する
                </label>
              </div>
              <input type="text" value={memo} onChange={e => setMemo(e.target.value)} placeholder="メモ（任意）"
                style={{ ...sel, width: '100%', boxSizing: 'border-box', marginTop: 10 }} />

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
                <button onClick={() => void decide()} disabled={busyBtn} style={mainBtn}>決定する</button>
                <button onClick={() => void setSlotStatus('no_change')} disabled={busyBtn} style={quietBtn}>
                  現行シフトで対応にする
                </button>
              </div>
            </>
          ) : (
            <p style={{ margin: 0, fontSize: 12.5, color: subText }}>まだ決まっていません。</p>
          )}
        </div>
      )}

      {/* 現行シフトで対応（確認済み） */}
      {status === 'no_change' && (
        <div style={box}>
          <div style={head}>対応</div>
          <p style={{ margin: 0, fontSize: 13, color: text }}>現行シフトで対応します。</p>
          {perms.decide && (
            <button onClick={() => void setSlotStatus('pending')} disabled={busyBtn}
              style={{ ...quietBtn, marginLeft: 0, marginTop: 10, display: 'block' }}>
              未調整に戻す
            </button>
          )}
        </div>
      )}

      {/* 候補 */}
      {!showFork && status !== 'no_change' && (
        <div style={box}>
          <button onClick={toggleCandidates}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, ...head, marginBottom: 0 }}>
            {showCandidates ? '▼' : '▶'} 候補
          </button>
          {showCandidates && (
            <div style={{ marginTop: 10 }}>
              {candErr && (
                <p style={{ margin: '0 0 8px', fontSize: 12, color: '#842029',
                  background: '#f8d7da', padding: '6px 8px', borderRadius: 6 }}>{candErr}</p>
              )}
              {!candLoaded ? (
                <p style={{ margin: 0, fontSize: 12.5, color: subText }}>読み込んでいます…</p>
              ) : (
                <>
                  <div style={{ fontSize: 12, color: subText, margin: '0 0 4px' }}>勤務予定あり</div>
                  {working.length === 0 ? (
                    <p style={{ margin: '0 0 10px', fontSize: 12.5, color: subText }}>該当者はいません。</p>
                  ) : working.map(p => (
                    <CandidateRow key={p.id} name={p.name || ''} part={p.employment_type === 'パート'}
                      shift={shiftTextOf(p.id)} loc={locOf(p.id)} note={busy[p.id] ?? ''} isDark={isDark} />
                  ))}
                  <div style={{ fontSize: 12, color: subText, margin: '12px 0 4px' }}>休みのパート</div>
                  {restingPart.length === 0 ? (
                    <p style={{ margin: 0, fontSize: 12.5, color: subText }}>該当者はいません。</p>
                  ) : restingPart.map(p => (
                    <CandidateRow key={p.id} name={p.name || ''} part shift="" loc=""
                      note={busy[p.id] ?? 'この日は休み'} isDark={isDark} />
                  ))}
                  <p style={{ margin: '10px 0 0', fontSize: 11, color: subText }}>
                    ※ 週の基本シフトが未登録の方は「勤務予定あり」に表示されません。
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* 相談（🚨 対応を決める前から見せる。隠すと、すでにある書き込みが埋もれる） */}
      <div style={box}>
        <div style={head}>相談</div>
        {comments.length === 0 ? (
          <p style={{ margin: '0 0 10px', fontSize: 12.5, color: subText }}>まだ書き込みはありません。</p>
        ) : comments.map(c => (
          <div key={c.id} style={{ padding: '8px 0', borderBottom: `1px solid ${border}` }}>
            <div style={{ fontSize: 11.5, color: subText }}>
              {nameOf(c.user_id) || '（名前なし）'}・{actedAtLabel(c.created_at)}
            </div>
            <div style={{ fontSize: 13.5, color: text, whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{c.body}</div>
          </div>
        ))}
        {perms.view && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 10 }}>
            <textarea value={body} onChange={e => setBody(e.target.value)} rows={2} placeholder="相談を入力"
              style={{ flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 13.5, resize: 'vertical',
                border: `1px solid ${border}`, background: inputBg, color: text,
                boxSizing: 'border-box', fontFamily: 'inherit' }} />
            <button onClick={() => void send()} disabled={!body.trim() || sending}
              style={{ padding: '9px 16px', borderRadius: 8, border: 'none', cursor: body.trim() ? 'pointer' : 'default',
                fontSize: 13, fontWeight: 'bold', whiteSpace: 'nowrap',
                background: body.trim() ? '#1976d2' : (isDark ? '#495057' : '#e9ecef'),
                color: body.trim() ? '#fff' : subText }}>
              {sending ? '送信中' : '送信'}
            </button>
          </div>
        )}
      </div>

      {err && (
        <p style={{ margin: '0 0 24px', padding: '8px 10px', borderRadius: 8, fontSize: 12.5,
          background: '#f8d7da', color: '#842029', whiteSpace: 'pre-wrap' }}>{err}</p>
      )}
      {okMsg && (
        <p style={{ margin: '0 0 24px', padding: '8px 10px', borderRadius: 8, fontSize: 12.5,
          background: '#f0fdf4', border: '1px solid #86efac', color: '#166534' }}>✓ {okMsg}</p>
      )}
      {!err && !okMsg && <div style={{ height: 24 }} />}
    </div>
  );
};

const CandidateRow: React.FC<{
  name: string; part: boolean; shift: string; loc: string; note: string; isDark: boolean;
}> = ({ name, part, shift, loc, note, isDark }) => {
  const text = isDark ? '#e9ecef' : '#333';
  const subText = isDark ? '#adb5bd' : '#666';
  // 🚨 選べない人は opacity で薄くする（新しい色を足さない）
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
      padding: '5px 0', opacity: note ? 0.5 : 1 }}>
      <span style={{ fontSize: 13, color: text, fontWeight: 'bold' }}>{name || '（名前なし）'}</span>
      {part && <span style={{ fontSize: 10.5, color: subText }}>パート</span>}
      {shift && <span style={{ fontSize: 12, color: subText }}>{shift}</span>}
      {loc && <span style={{ fontSize: 11, color: subText }}>{loc}</span>}
      {note && <span style={{ fontSize: 11, color: subText }}>（{note}）</span>}
    </div>
  );
};

export default ShiftAdjustTab;
