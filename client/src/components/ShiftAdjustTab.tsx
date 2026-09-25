import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { teamsOf } from '../lib/staffTeam';
import { useRoles } from '../hooks/useRoles';
import { roleByName } from '../lib/roleAttrs';
import { compareByPlaceRole, firstWorkplace, usualWorkplace } from '../lib/shiftAdjustSort';
import { segmentsText } from '../lib/segmentsText';
import { todayJstStr } from '../lib/breakCalc';
import type { DayKind } from '../lib/breakCalc';
import { normalShiftTimeText } from '../lib/overtimeShift';
import { actedAtLabel } from '../lib/actedAt';
import { insertNotification } from '../lib/notifications';
import TimeInput from './TimeInput';
import { useScrollIntoViewWhen } from '../hooks/useScrollIntoViewWhen';
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
interface ProfileRow {
  id: string; name: string | null; employment_type: string | null;
  /** 候補に役職を出す（2026-09-14 ユーザー指示） */
  role_title: string | null;
  /** 所属チーム（こども／大人／管理部）の判定に使う。配信用グループも混ざるので lib/staffTeam.ts を通す */
  group_names: string[] | null;
}
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

interface PartReqRow {
  id: string; user_id: string;
  segments: { start: string; end: string; location?: string }[];
  location: string | null;
  sent_at: string; due_at: string | null;
  answer: string | null; answered_at: string | null; picked: boolean;
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
  /** 管理者（案を消すことだけは管理者もできる・2026-09-25） */
  isAdmin?: boolean;
  /** 欠勤の行の印から来たとき、その場をいきなり開く */
  initialSlotId?: string | null;
  onConsumedInitial?: () => void;
}> = ({ userId, isDark, isMobile, perms, isAdmin = false, initialSlotId, onConsumedInitial }) => {
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
  /** 所属チームの一覧（master_options の shift_report_group：こども／大人／管理部） */
  const [teams, setTeams] = useState<string[]>([]);
  // 🚨 開いている場は URL（?slot=）で持つ（2026-09-14 実機指摘）。
  //    画面の中だけで持っていたので、スマホの「戻る」で一覧ではなく前のページに飛んでいた。
  //    開くときに履歴を1段積み、戻る＝一覧に帰る、にする
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const openId = searchParams.get('slot');
  const openSlotById = useCallback((id: string) => {
    const sp = new URLSearchParams(searchParams);
    sp.set('tab', 'adjust');
    sp.set('slot', id);
    navigate({ search: `?${sp.toString()}` }, { state: { saPushed: true } });
  }, [searchParams, navigate]);
  // 「‹ 一覧へ」：この画面で開いた場なら履歴を1段戻す（戻るボタンと同じ動きにそろえる）。
  // 🚨 URL を直接開いた・再読み込みしたときは戻る先がサイトの外になりうるので、slot だけ外す
  const closeSlot = useCallback(() => {
    if ((location.state as { saPushed?: boolean } | null)?.saPushed) { navigate(-1); return; }
    const sp = new URLSearchParams(searchParams);
    sp.delete('slot');
    setSearchParams(sp, { replace: true });
  }, [location.state, navigate, searchParams, setSearchParams]);
  const [showDone, setShowDone] = useState(false);
  /** 場ごとの案の件数と、意見の期限を過ぎた案があるか（一覧に「案 2件」を出す・2026-09-25） */
  const [planCounts, setPlanCounts] = useState<Map<string, { n: number; overdue: boolean }>>(new Map());
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
    const [{ data: sData, error: sErr }, { data: pData, error: pErr }, { data: wData }, { data: tData }, { data: planData }] = await Promise.all([
      supabase.from('shift_adjust_slots')
        .select('id, target_user_id, target_date, cause, cause_leave_request_id, cause_attendance_exception_id, status, decided_by, decided_at')
        .gte('target_date', todayJstStr())
        .order('target_date', { ascending: true }),
      supabase.from('profiles').select('id, name, employment_type, role_title, group_names').eq('is_active', true),
      supabase.from('master_options').select('value').eq('category', 'workplace').order('sort_order'),
      supabase.from('master_options').select('value').eq('category', 'shift_report_group').order('sort_order'),
      // 🚨 読めなくても一覧は出す（「案 ◯件」の印が出ないだけ）
      supabase.from('shift_adjust_plans').select('slot_id, review_due_at'),
    ]);
    if (sErr) { setErr('調整の場を読み込めませんでした：' + sErr.message); setLoading(false); return; }
    if (pErr) { setErr('スタッフの一覧を読み込めませんでした：' + pErr.message); setLoading(false); return; }
    setSlots((sData as SlotRow[] | null) ?? []);
    setProfiles((pData as ProfileRow[] | null) ?? []);
    setWorkplaces(((wData as { value: string }[] | null) ?? []).map(r => r.value));
    // 🚨 チームが読めなくても調整はできる（絞り込みが「すべて」だけになる）ので止めない
    setTeams(((tData as { value: string }[] | null) ?? []).map(r => r.value));
    const counts = new Map<string, { n: number; overdue: boolean }>();
    const nowMs = Date.now();
    for (const r of (planData as { slot_id: string; review_due_at: string | null }[] | null) ?? []) {
      const c = counts.get(r.slot_id) ?? { n: 0, overdue: false };
      c.n += 1;
      if (r.review_due_at && new Date(r.review_due_at).getTime() < nowMs) c.overdue = true;
      counts.set(r.slot_id, c);
    }
    setPlanCounts(counts);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 欠勤の行の印から来たときは、その場をいきなり開く。
  // 🚨 一度使ったら親の値を消す（戻ったときにまた開いてしまうため）
  useEffect(() => {
    if (initialSlotId) { openSlotById(initialSlotId); onConsumedInitial?.(); }
  }, [initialSlotId, onConsumedInitial, openSlotById]);

  // 場を閉じたら（戻る・一覧へ）、状態が変わっているかもしれないので一覧を読み直す
  const prevOpenId = React.useRef<string | null>(openId);
  useEffect(() => {
    if (prevOpenId.current && !openId) void load();
    prevOpenId.current = openId;
  }, [openId, load]);

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
        key={openSlot.id}
        slot={openSlot} userId={userId} isDark={isDark} isMobile={isMobile}
        perms={perms} isAdmin={isAdmin} profiles={profiles} workplaces={workplaces} teams={teams} nameOf={nameOf}
        onBack={closeSlot}
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
              <button key={s.id} type="button" onClick={() => openSlotById(s.id)}
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
                {/* 案がある未調整・調整中の場（2026-09-25：件数と、意見の期限を過ぎた案があるか）。🚨 新しい色は足さない */}
                {undone && planCounts.has(s.id) && (
                  <span style={{ marginLeft: 'auto', fontSize: 10.5, padding: '1px 7px', borderRadius: 10, whiteSpace: 'nowrap',
                    color: subText, border: `1px solid ${border}` }}>
                    案 {planCounts.get(s.id)!.n}件{planCounts.get(s.id)!.overdue ? '・期限過ぎ' : ''}
                  </span>
                )}
                <span style={{
                  marginLeft: undone && planCounts.has(s.id) ? 0 : 'auto', fontSize: 10.5, fontWeight: 'bold', padding: '2px 8px', borderRadius: 10,
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
/** 入る時間帯1つ（開始・終了・校）。🚨 2026-09-14：午前は本校・午後は別の校、のように1人で複数持てる */
interface DraftSeg { start: string; end: string; location: string }
interface Draft { key: number; userId: string; segs: DraftSeg[] }
/**
 * 案（2026-09-25 ユーザー確定・docs/計画-シフト調整.md §6-2）。1つの場に何通りも作れる。
 * 直す・消すは作った本人だけ（消すことだけは管理者も）。決定・休みの取消・日の経過・現行シフトで対応で消える。
 * 🚨 案が持つのは 人・時間・校 と「確認する方へ」だけ。チェック2つと「出勤する方へのメモ」は決定のときに入れる
 */
interface PlanRow {
  id: string;
  slot_id: string;
  plan_no: number;
  created_by: string;
  assignments: { user_id: string; segs: DraftSeg[] }[];
  note: string | null;
  review_due_at: string | null;
  created_at: string;
  updated_at: string;
  reviews_reset_at: string | null;
  reviews_reset_count: number | null;
  reviews: { user_id: string; created_at: string }[] | null;
}
/** 入力欄のいまの使い方。🚨 先頭に1行で出し、ボタンも出し分ける（案を作っているのか、決定するのかを取り違えないため） */
type Editor =
  | { mode: 'new'; fromNo?: number }
  | { mode: 'edit'; plan: PlanRow }
  | { mode: 'decide'; fromPlan?: PlanRow };
/** 入力欄に入れる中身 */
interface EditorContent { assignments: { user_id: string; segs: DraftSeg[] }[]; note?: string | null; due?: string | null }

const SlotDetail: React.FC<{
  slot: SlotRow;
  userId: string;
  isDark: boolean;
  isMobile: boolean;
  perms: Perms;
  isAdmin: boolean;
  profiles: ProfileRow[];
  workplaces: string[];
  teams: string[];
  nameOf: (id: string | null | undefined) => string;
  onBack: () => void;
}> = ({ slot, userId, isDark, isMobile, perms, isAdmin, profiles, workplaces, teams, nameOf, onBack }) => {
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

  // 調整中の場を開いたときは、候補を最初から開いておく
  const [showCandidates, setShowCandidates] = useState(slot.status === 'working');
  /** この日の曜日の週の基本シフト */
  const [patterns, setPatterns] = useState<PatternRow[]>([]);
  /** その日に有効な週の基本シフト（全曜日）。「週のシフト未登録」の判定と「いつもの校」に使う */
  const [weekPatterns, setWeekPatterns] = useState<PatternRow[]>([]);
  const roles = useRoles();
  /** 出勤する人の枠（「＋ 入れる」を押したらここまで戻る・2026-09-14 ユーザー確定） */
  const workRef = React.useRef<HTMLDivElement>(null);
  /** いま入れた人（行を数秒だけ目立たせる） */
  const [flashUid, setFlashUid] = useState<string | null>(null);
  // チームの絞り込み。初期値は休んだ人と同じチーム（2026-09-14 ユーザー確定）。チームが無い人なら「すべて」
  const targetTeam = teamsOf(profiles.find(p => p.id === slot.target_user_id)?.group_names, teams)[0] ?? 'all';
  const [candTeam, setCandTeam] = useState<string>(targetTeam);
  const [partTeam, setPartTeam] = useState<string>(targetTeam);
  const [busy, setBusy] = useState<BusyMap>({});
  const [candLoaded, setCandLoaded] = useState(false);
  const [candErr, setCandErr] = useState('');
  const [where, setWhere] = useState('');

  const [partReqs, setPartReqs] = useState<PartReqRow[]>([]);
  const [pushUsers, setPushUsers] = useState<string[]>([]);
  /** スマホ通知の登録状況を「読めたか」。読めていないのに「通知なし」と出さないための印 */
  const [pushKnown, setPushKnown] = useState(false);
  const [pickedParts, setPickedParts] = useState<string[]>([]);
  const [reqStart, setReqStart] = useState('');
  const [reqEnd, setReqEnd] = useState('');
  const [reqLoc, setReqLoc] = useState('');
  const [dueAt, setDueAt] = useState('');

  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [memo, setMemo] = useState('');
  // 🚨 2026-09-13（手順8）：初期値は管理画面の「自動登録の開始日」で決まる。読むまでは OFF
  const [doAttendance, setDoAttendance] = useState(false);
  const [doRequest, setDoRequest] = useState(false);
  /** 利用者がチェックを触ったか。触ったあとに設定の読み込みが終わっても上書きしない */
  const touchedAuto = React.useRef(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  /** この場の案（案1・案2…） */
  const [plans, setPlans] = useState<PlanRow[]>([]);
  /** 入力欄（閉じているときは null）。押したときだけ開く */
  const [editor, setEditor] = useState<Editor | null>(null);
  /** 入力欄を開いたときの中身（変更したかを見るため） */
  const [editorBase, setEditorBase] = useState('');
  /** 案の「確認する方へ」（出勤する方には届かない） */
  const [planNote, setPlanNote] = useState('');
  /** 案の意見の期限（datetime-local の値・空なら付けない） */
  const [planDue, setPlanDue] = useState('');
  /** 入力中の内容を置き換える前の確認（黙って消さない） */
  const [confirmReplace, setConfirmReplace] = useState<{ e: Editor; c: EditorContent; label: string } | null>(null);
  /** 消す前の確認（案の id） */
  const [confirmDelPlan, setConfirmDelPlan] = useState<string | null>(null);
  /** 案がある場で「現行シフトで対応」を押したときの確認 */
  const [confirmNoChange, setConfirmNoChange] = useState(false);
  /** 決定したとき本人にお知らせ（ベル・スマホ）を送るか（2026-09-25 ユーザー確定・案A）。
   *  🚨 OFF でも依頼・勤怠の登録はする（事前に直接伝えて決まった場合に、突然お知らせが届かないように） */
  const [notifyStaff, setNotifyStaff] = useState(true);

  // 決定するときのチェックの初期値（ユーザー確定）：
  //   休みの日が開始日以降なら ON／それより前、または開始日が未設定なら OFF。押せば登録・依頼はできる
  // 🚨 パート（勤怠の登録）と正社員（残業申請の依頼）で開始日は別々
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data, error } = await supabase.from('shift_adjust_settings')
        .select('attendance_from, request_from').eq('id', 1).maybeSingle();
      if (!alive) return;
      // 🚨 読めなかったときは OFF のまま（押せば登録・依頼はできる）。
      // 🚨 2026-09-14 ユーザー確定：「初期値：…（開始日が未設定）」の説明は出さない（決める人には意味が伝わらないため）
      if (error || !data) return;
      const af = (data.attendance_from as string | null) ?? null;
      const rf = (data.request_from as string | null) ?? null;
      const onA = !!af && slot.target_date >= af;
      const onR = !!rf && slot.target_date >= rf;
      if (!touchedAuto.current) { setDoAttendance(onA); setDoRequest(onR); }
    })();
    return () => { alive = false; };
  }, [slot.target_date]);

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

  const loadPartReqs = useCallback(async () => {
    const { data, error } = await supabase.from('shift_adjust_part_requests')
      .select('id, user_id, segments, location, sent_at, due_at, answer, answered_at, picked')
      .eq('slot_id', slot.id)
      .order('sent_at', { ascending: true });
    if (error) { setErr('出勤のお願いを読み込めませんでした：' + error.message); return; }
    setPartReqs((data as PartReqRow[] | null) ?? []);
  }, [slot.id]);

  // 案を読む。🚨 error を見る（読めないのに「案はありません」と出すと画面が嘘をつく）
  const loadPlans = useCallback(async (): Promise<PlanRow[]> => {
    const { data, error } = await supabase.from('shift_adjust_plans')
      .select('id, slot_id, plan_no, created_by, assignments, note, review_due_at, created_at, updated_at, reviews_reset_at, reviews_reset_count, reviews:shift_adjust_plan_reviews(user_id, created_at)')
      .eq('slot_id', slot.id).order('plan_no', { ascending: true });
    if (error) { setErr('案を読み込めませんでした：' + error.message); return []; }
    const rows = (data as PlanRow[] | null) ?? [];
    setPlans(rows);
    return rows;
  }, [slot.id]);

  useEffect(() => { void loadComments(); void loadAssigns(); void loadPartReqs(); void loadPlans(); },
    [loadComments, loadAssigns, loadPartReqs, loadPlans]);

  // スマホ通知を登録している人。🚨 送る前に「この人は通知なし」と出すため
  //    （パート18人中6人しか登録していない。知らずに送ると、気づかれないまま待つことになる）
  // 🚨🚨 `push_subscriptions` は **管理者しか読めない**（RLS：管理者は閲覧可／本人は自分のぶんだけ）。
  //    読めなかったときに「全員 通知なし」と出すと**画面が嘘をつく**ので、
  //    読めたときだけ人ごとの印を出し、読めなければ全体の断り書きだけにする。
  useEffect(() => {
    if (!perms.request) return;
    supabase.from('push_subscriptions').select('user_id').then(({ data, error }) => {
      if (error || !data || data.length === 0) { setPushKnown(false); return; }
      setPushUsers([...new Set((data as { user_id: string }[]).map(r => r.user_id))]);
      setPushKnown(true);
    });
  }, [perms.request]);

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

  // 週の基本シフト・この日の休暇と勤怠の記録を読む。
  // 🚨 2026-09-14 から、場を開いたら状態に関係なく読む（見出しに休む方のこの日のシフトを出すため）
  const loadCandidates = useCallback(async () => {
    setCandErr('');
    const d = slot.target_date;
    const [{ data: pat, error: patErr }, { data: att }, { data: lv }] = await Promise.all([
      // 🚨 曜日で絞らずに読む（2026-09-14）。その日に有効な行が1つも無い人＝「週のシフト未登録」を見分けるため。
      //    曜日で絞っていたので、9/16 から登録したパートが 9/15 に全員「この日は休み」と出ていた
      supabase.from('weekly_shift_patterns')
        .select('user_id, day_kind, start_time, end_time, start_time2, end_time2, location, valid_from, valid_to')
        .lte('valid_from', d)
        // 🚨 その日に効いている行だけ。終わりの日で絞らないと、版が増えたときに1,000行で黙って欠ける（2026-09-15 レビュー R1）
        .or(`valid_to.is.null,valid_to.gte.${d}`),
      supabase.from('attendance_exceptions').select('user_id, type').eq('date', d),
      supabase.from('leave_requests').select('user_id, leave_dates, start_date, end_date, status')
        .in('status', ['manager_approved', 'admin_approved', 'approved'])
        .lte('start_date', d).gte('end_date', d),
    ]);
    if (patErr) {
      // 🚨 権限が無いと読めない。黙って0件にしない
      setCandErr('週の基本シフトを読み込めませんでした（「全員のシフト予定 閲覧」の権限が必要です）');
    }
    const valid = ((pat as (PatternRow & { valid_from: string; valid_to: string | null })[] | null) ?? [])
      .filter(p => p.valid_to === null || p.valid_to >= d);
    setWeekPatterns(valid);
    setPatterns(valid.filter(p => p.day_kind === dayKindOf(d)));

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

  // 🚨 開いたら1回読む。読み込みは失敗しても candLoaded を立てるので、繰り返し読みに行くことはない
  useEffect(() => {
    if (!candLoaded) void loadCandidates();
  }, [candLoaded, loadCandidates]);

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

  const setSlotStatus = async (next: 'pending' | 'working' | 'no_change'): Promise<boolean> => {
    setErr(''); setOkMsg(''); setBusyBtn(true);
    const { data, error } = await supabase.rpc('shift_adjust_set_status', { p_slot_id: slot.id, p_status: next });
    setBusyBtn(false);
    // 🚨 rpc は 4xx でも throw しない。error と ok の両方を見る
    if (error) { setErr('変更できませんでした：' + error.message); return false; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.ok) { setErr(row?.reason || '変更できませんでした'); return false; }
    setStatus(next);
    if (next === 'no_change') setOkMsg('現行シフトで対応として記録しました。');
    if (next === 'working') {
      setOkMsg('');
      if (!showCandidates) { setShowCandidates(true); if (!candLoaded) void loadCandidates(); }
      // 🚨 2026-09-25：入力欄は自動では開かない（案を作るのか、決めるのかを押して選ぶ）
    }
    if (next === 'pending') setOkMsg('未調整に戻しました。');
    return true;
  };

  // 「後で決める」：いま判断しない。調整中・現行シフトで対応から押したときは、未調整に戻してから一覧へ帰る
  const decideLater = async () => {
    if (status === 'pending') { onBack(); return; }
    if (await setSlotStatus('pending')) onBack();
  };

  /** 時間帯の初期値（校はこの場の校。分からなければ校の一覧の先頭） */
  const newSeg = (): DraftSeg => ({ start: '', end: '', location: where || workplaces[0] || '' });
  const addDraft = () => {
    setDrafts(d => [...d, { key: Date.now() + Math.random(), userId: '', segs: [newSeg()] }]);
  };
  const patchDraft = (key: number, p: Partial<Draft>) =>
    setDrafts(d => d.map(x => (x.key === key ? { ...x, ...p } : x)));
  const removeDraft = (key: number) => setDrafts(d => d.filter(x => x.key !== key));
  /** 時間帯を1つ書き換える */
  const patchSeg = (key: number, i: number, p: Partial<DraftSeg>) =>
    setDrafts(d => d.map(x => (x.key === key ? { ...x, segs: x.segs.map((s, j) => (j === i ? { ...s, ...p } : s)) } : x)));
  // 「＋ 時間帯を追加」：午前は本校・午後から別の校へ移る、など（2026-09-14 ユーザー依頼）。
  // 🚨 時間も校も空で始める（入る時間は手入力の決まり。前の校のまま決まってしまうのを防ぐ）
  const addSeg = (key: number) =>
    setDrafts(d => d.map(x => (x.key === key ? { ...x, segs: [...x.segs, { start: '', end: '', location: '' }] } : x)));
  /** 🚨 時間帯は最低1つ残す（0にすると決定できなくなる） */
  const removeSeg = (key: number, i: number) =>
    setDrafts(d => d.map(x => (x.key === key && x.segs.length > 1 ? { ...x, segs: x.segs.filter((_, j) => j !== i) } : x)));

  // ───── 案（2026-09-25 ユーザー確定・docs/計画-シフト調整.md §6-2）─────
  /** 入力欄の中身を1つの文字列に（変更したかを見るため） */
  const snapshotOf = (ds: Draft[], note: string, due: string, m: string): string =>
    JSON.stringify({ d: ds.map(d => [d.userId, d.segs]), note, due, m });
  const editorDirty = !!editor && snapshotOf(drafts, planNote, planDue, memo) !== editorBase;

  /** ISO の日時 → datetime-local の値（端末の時刻で "YYYY-MM-DDTHH:MM"） */
  const toLocalInput = (iso: string | null | undefined): string => {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  /** 意見の期限の表示「9/26（金）18:00」 */
  const dueLabel = (iso: string): string => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}（${DOW[d.getDay()]}）${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  /** 入力欄を開く（中身を入れる）。🚨 入力中の内容があるときは requestOpen から確認を挟む */
  const openEditor = (e: Editor, c: EditorContent) => {
    const ds: Draft[] = (c.assignments ?? []).map(a => ({
      key: Date.now() + Math.random(),
      userId: a.user_id,
      segs: (a.segs ?? []).length > 0 ? a.segs.map(sg => ({ start: sg.start ?? '', end: sg.end ?? '', location: sg.location ?? '' })) : [newSeg()],
    }));
    const note = e.mode === 'decide' ? '' : (c.note ?? '');
    const due = e.mode === 'edit' ? toLocalInput(c.due) : '';
    // 決定のメモは決定のときに入れる（🚨 案から写さない。案の「確認する方へ」を出勤する方に届けないため）
    const m = '';
    setDrafts(ds); setPlanNote(note); setPlanDue(due); setMemo(m); setNotifyStaff(true);
    setEditor(e);
    setEditorBase(snapshotOf(ds, note, due, m));
    setConfirmReplace(null);
    setErr(''); setOkMsg('');
    if (!showCandidates) { setShowCandidates(true); if (!candLoaded) void loadCandidates(); }
    window.requestAnimationFrame(() => workRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  /** 入力中の内容があれば、消してよいかを先に聞く */
  const requestOpen = (e: Editor, c: EditorContent, label: string) => {
    if (editorDirty) { setConfirmReplace({ e, c, label }); return; }
    openEditor(e, c);
  };
  const closeEditor = () => {
    setEditor(null); setDrafts([]); setPlanNote(''); setPlanDue(''); setMemo(''); setEditorBase(''); setConfirmReplace(null);
  };
  const confirmReplaceRef = useScrollIntoViewWhen<HTMLDivElement>(confirmReplace);
  const confirmNoChangeRef = useScrollIntoViewWhen<HTMLDivElement>(confirmNoChange);

  /** 相談の欄に残す文（例：森本さん 9:30〜17:30 四条本校） */
  const summaryOf = (rows: Draft[]): string => {
    const hhmm = (v: string) => (toDbTime(v) || v || '').slice(0, 5);
    return rows.map(d => {
      const band = segmentsText(d.segs.map(sg => ({ start: hhmm(sg.start), end: hhmm(sg.end), location: sg.location || null })));
      return `${nameOf(d.userId) || '（名前なし）'}${band ? ` ${band}` : ''}`;
    }).join('／');
  };

  /** 案を保存（新しい案／自分の案を直す） */
  const savePlanFromEditor = async () => {
    if (!editor || editor.mode === 'decide') return;
    setErr(''); setOkMsg('');
    const rows = drafts.filter(d => d.userId);
    if (rows.length === 0) { setErr('出勤する人を1人以上選んでください。'); return; }
    // 🚨 途中の案なので、時間が空でも保存できる（決定のときに初めて確かめる）
    const assignments = rows.map(d => ({ user_id: d.userId, segs: d.segs }));
    const dueIso = planDue ? new Date(planDue).toISOString() : null;
    setBusyBtn(true);
    const res = editor.mode === 'new'
      ? await supabase.rpc('shift_adjust_plan_create', {
          p_slot_id: slot.id, p_assignments: assignments, p_note: planNote.trim() || null,
          p_review_due_at: dueIso, p_summary: summaryOf(rows),
        })
      : await supabase.rpc('shift_adjust_plan_update', {
          p_plan_id: editor.plan.id, p_assignments: assignments, p_note: planNote.trim() || null,
          p_review_due_at: dueIso, p_summary: summaryOf(rows),
          // 🚨 開いたときの更新日時。別の画面で直されていたら上書きしない
          p_expected_updated_at: editor.plan.updated_at,
        });
    setBusyBtn(false);
    // 🚨 rpc は 4xx でも throw しない。error と ok の両方を見る
    if (res.error) { setErr('案を保存できませんでした：' + res.error.message); return; }
    const row = Array.isArray(res.data) ? res.data[0] : res.data;
    if (!row?.ok && row?.reason === 'conflict') {
      setErr('この案は、別の画面で直されています。読み込み直しました。もう一度「直す」から直してください。');
      closeEditor(); void loadPlans();
      return;
    }
    if (!row?.ok) { setErr(row?.reason || '案を保存できませんでした'); return; }
    const no = editor.mode === 'new' ? row.out_plan_no : editor.plan.plan_no;
    closeEditor();
    if (status === 'pending') setStatus('working');   // DB も未調整→調整中に進めている
    await loadPlans();
    void loadComments();
    setOkMsg(`案${no}を保存しました。${dueIso ? '意見の期限を付けたので、確認する方にお知らせしました。' : ''}`);
  };

  const deletePlan = async (p: PlanRow) => {
    setErr(''); setOkMsg(''); setBusyBtn(true);
    const { data, error } = await supabase.rpc('shift_adjust_plan_delete', { p_plan_id: p.id, p_expected_updated_at: p.updated_at });
    setBusyBtn(false); setConfirmDelPlan(null);
    if (error) { setErr('案を消せませんでした：' + error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.ok && row?.reason === 'conflict') { setErr('この案は、別の画面で直されています。読み込み直しました。'); void loadPlans(); return; }
    if (!row?.ok) { setErr(row?.reason || '案を消せませんでした'); return; }
    if (editor?.mode === 'edit' && editor.plan.id === p.id) closeEditor();
    await loadPlans();
    void loadComments();
    setOkMsg(`案${p.plan_no}を消しました。`);
  };

  const reviewPlan = async (p: PlanRow) => {
    setErr(''); setOkMsg(''); setBusyBtn(true);
    // 🚨 見ていた案の更新日時を渡す。直されたあとなら断られる（古い中身への「確認した」を付けない）
    const { data, error } = await supabase.rpc('shift_adjust_plan_review', { p_plan_id: p.id, p_expected_updated_at: p.updated_at });
    setBusyBtn(false);
    if (error) { setErr('「確認した」を付けられませんでした：' + error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.ok && row?.reason === 'conflict') { setErr(`案${p.plan_no}は直されています。読み込み直したので、中身を見てからもう一度押してください。`); void loadPlans(); return; }
    if (!row?.ok) { setErr(row?.reason || '「確認した」を付けられませんでした'); return; }
    void loadPlans();
  };

  const unreviewPlan = async (p: PlanRow) => {
    setErr(''); setOkMsg(''); setBusyBtn(true);
    const { data, error } = await supabase.rpc('shift_adjust_plan_unreview', { p_plan_id: p.id });
    setBusyBtn(false);
    if (error) { setErr('取り消せませんでした：' + error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.ok) { setErr(row?.reason || '取り消せませんでした'); void loadPlans(); return; }
    void loadPlans();
  };

  /** 「案を作らずに決める」「この案で決定へ」：未調整なら先に調整中にする（決定は調整中の場で行う） */
  const startDecide = async (fromPlan?: PlanRow) => {
    if (status === 'pending' && !(await setSlotStatus('working'))) return;
    const e: Editor = { mode: 'decide', fromPlan };
    const c: EditorContent = { assignments: fromPlan?.assignments ?? [] };
    requestOpen(e, c, fromPlan ? `案${fromPlan.plan_no}（${nameOf(fromPlan.created_by) || '名前なし'}さん）の内容` : '空の入力欄');
  };

  // 「＋ 入れる」：出勤する人に入れて、上の「出勤する人」まで戻る（2026-09-14 ユーザー確定）。
  // 🚨 入る時間は入れない（手入力）。昼から移動などがあるため（ユーザー確定）。校は今までの「＋ 出勤する人を追加」と同じ初期値
  // 🚨 同じ人は二重に入れない。空の行（「シフトを調整する」を押したときにできる）があればそこに入れる
  const addCandidate = (uid: string) => {
    // 入力欄が閉じていたら開く（案を作れる人は新しい案、決めるだけの人は決定）。2026-09-25
    if (!editor) {
      const e: Editor = canPlan ? { mode: 'new' } : { mode: 'decide' };
      openEditor(e, { assignments: [{ user_id: uid, segs: [] }] });
      setFlashUid(uid);
      window.setTimeout(() => setFlashUid(v => (v === uid ? null : v)), 2500);
      if (!canPlan && status === 'pending') void setSlotStatus('working');
      return;
    }
    setDrafts(d => {
      if (d.some(x => x.userId === uid)) return d;
      const empty = d.find(x => !x.userId);
      if (empty) return d.map(x => (x.key === empty.key ? { ...x, userId: uid } : x));
      return [...d, { key: Date.now() + Math.random(), userId: uid, segs: [newSeg()] }];
    });
    setFlashUid(uid);
    window.setTimeout(() => setFlashUid(v => (v === uid ? null : v)), 2500);
    window.requestAnimationFrame(() => workRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const kindOf = (uid: string): 'attendance' | 'overtime_request' =>
    profiles.find(p => p.id === uid)?.employment_type === 'パート' ? 'attendance' : 'overtime_request';

  const decide = async () => {
    setErr(''); setOkMsg('');
    if (drafts.length === 0) { setErr('出勤する人を選んでください。'); return; }
    for (const d of drafts) {
      if (!d.userId) { setErr('出勤する人を選んでください。'); return; }
      const who = nameOf(d.userId) || 'この方';
      let prevEnd = '';
      for (const sg of d.segs) {
        const s = toDbTime(sg.start); const e = toDbTime(sg.end);
        if (!s || !e) { setErr(`${who}さんの開始時刻と終了時刻を入力してください。`); return; }
        if (e <= s) { setErr(`${who}さんの終了時刻は開始時刻より後にしてください。`); return; }
        // 🚨 時間帯を複数入れたとき：上から時刻の順に並び、重ならないこと。
        //    校も時間帯ごとに必ず選ぶ（どこへ移るのかが相手に伝わらなくなるため）
        if (prevEnd && s < prevEnd) { setErr(`${who}さんの時間帯が重なっています。上の時間帯の終了より後から始めてください。`); return; }
        if (d.segs.length > 1 && !sg.location) { setErr(`${who}さんの時間帯ごとに校を選んでください。`); return; }
        prevEnd = e;
      }
    }
    if (new Set(drafts.map(d => d.userId)).size !== drafts.length) {
      setErr('同じ方が2回選ばれています。'); return;
    }
    setBusyBtn(true);
    /** DBへ送る形に直した時間帯（"HH:MM"）。通知の文もこれから作る */
    const segsOf = (d: Draft) => d.segs.map(sg => ({
      start: (toDbTime(sg.start) || '').slice(0, 5), end: (toDbTime(sg.end) || '').slice(0, 5), location: sg.location || null,
    }));
    const payload = drafts.map(d => ({
      user_id: d.userId,
      kind: kindOf(d.userId),
      segments: segsOf(d),
    }));
    const { data, error } = await supabase.rpc('shift_adjust_decide', {
      p_slot_id: slot.id, p_assignments: payload,
      // 🚨 お知らせを送らないときはメモも送らない（メモ欄は送るときだけ出している）
      p_do_attendance: doAttendance, p_do_request: doRequest, p_memo: notifyStaff ? (memo.trim() || null) : null,
    });
    if (error) { setBusyBtn(false); setErr('決定できませんでした：' + error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.ok) { setBusyBtn(false); setErr(row?.reason || '決定できませんでした'); return; }

    // 🚨 お知らせは画面から送る（DBからは Edge Function を呼べない）。
    //    文面は既存の申請依頼（ApplicationRequestSheet）と同じ形に揃える
    // 🚨 2026-09-14 ユーザー確定：2行目に「入る時間と校」を入れる。
    //    それまでは日付とメモしか届かず、相手に時間が伝わっていなかった（依頼の記録にも時間の欄が無い）。
    //    スマホの通知の文は push-dispatch の決まった文（申請の依頼が届いています）のままで、2行目は出ない
    // 🚨 文は lib/segmentsText.ts の1か所で作る（時間帯が複数なら「 ＋ 」でつなぐ）
    const bandOf = (d: Draft): string => segmentsText(segsOf(d));
    const memoText = memo.trim();
    const reqIds: string[] = row.request_ids ?? [];
    // 🚨 「本人にお知らせを送る」を外したときは、ベル・スマホを送らない（依頼と勤怠の登録はしている）
    if (notifyStaff && reqIds.length > 0) {
      const dl = `${Number(slot.target_date.slice(5, 7))}/${Number(slot.target_date.slice(8, 10))}`;
      const me = nameOf(userId) || '担当者';
      const targets = drafts.filter(d => kindOf(d.userId) === 'overtime_request');
      for (let i = 0; i < targets.length && i < reqIds.length; i++) {
        await insertNotification(
          targets[i].userId,
          `📩 ${me}さんより申請依頼：${dl} 残業・時間管理`,
          // 🚨 時間とメモの間は全角スペース。そのまま書くと ESLint（no-irregular-whitespace）に止められるので \u3000 で書く
          `${bandOf(targets[i])}${memoText ? `\u3000メモ：${memoText}` : ''}`,
          'application_request:received',
          reqIds[i],
          'application_request:received',
        );
      }
    }
    // パートを入れて決定したとき、本人にベルで知らせる（2026-09-14 ユーザー確定）。
    // 🚨 それまでは何も届かなかった（出勤のお願いで選ばれた人だけ、返事のページに結果が出ていた）。
    //    選ばれた人にもベルは出ていなかったので、全員に1通ずつ送っても二重にはならない
    // 🚨 ベルだけ（event_key を付けない＝スマホは鳴らさない）。メモは入れない（勤怠の記録に残る）
    // 🚨 誰の代わりかは書かない（計画書の決まり）
    for (const d of notifyStaff ? drafts.filter(x => kindOf(x.userId) === 'attendance') : []) {
      await insertNotification(
        d.userId,
        `📅 ${dateLabel(slot.target_date)}の出勤が決まりました`,
        bandOf(d),
        'shift_adjust:decided',
        slot.id,
      );
    }
    // どの案で決めたかを相談の欄に残す（案は決定で消えるので、経緯はここにしか残らない・2026-09-25）。
    // 🚨 失敗しても決定は成立している。赤にはせず console に出す
    const fromPlan = editor?.mode === 'decide' ? editor.fromPlan : undefined;
    const { error: cErr } = await supabase.from('shift_adjust_comments').insert({
      slot_id: slot.id, user_id: userId,
      body: fromPlan
        ? `案${fromPlan.plan_no}（${nameOf(fromPlan.created_by) || '名前なし'}さん）をもとに決定しました${editorDirty ? '（変更あり）' : ''}：${summaryOf(drafts)}`
        : `決定しました：${summaryOf(drafts)}`,
    });
    if (cErr) console.error('[シフト調整] 決定の記録を相談に残せませんでした', cErr.message);
    setBusyBtn(false);
    setStatus('decided');
    // 決定すると案は消える（DBのトリガーが消す）
    closeEditor();
    setPlans([]);
    setOkMsg('決定しました。');
    void loadAssigns();
    void loadComments();
  };

  const sendParts = async () => {
    setErr(''); setOkMsg('');
    const s = toDbTime(reqStart); const e = toDbTime(reqEnd);
    if (!s || !e) { setErr('開始時刻と終了時刻を入力してください。'); return; }
    if (e <= s) { setErr('終了時刻は開始時刻より後にしてください。'); return; }
    setBusyBtn(true);
    const segs = [{ start: s.slice(0, 5), end: e.slice(0, 5), location: reqLoc || null }];
    const { data, error } = await supabase.rpc('shift_adjust_send_part_requests', {
      p_slot_id: slot.id, p_user_ids: pickedParts, p_segments: segs,
      p_location: reqLoc || null,
      // 🚨 datetime-local は端末の時刻。new Date(…) で日本時間として解釈され、
      //    toISOString() で正しい瞬間に変換される
      p_due_at: dueAt ? new Date(dueAt).toISOString() : null,
    });
    if (error) { setBusyBtn(false); setErr('送信できませんでした：' + error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.ok) { setBusyBtn(false); setErr(row?.reason || '送信できませんでした'); return; }

    // 🚨 お知らせは画面から送る。文面に「誰の代わりか」は入れない
    // 🚨 event_key を付けると、DBのトリガーが push_queue に積む＝スマホが鳴る。
    //    受け取るのはパートで、スマホ通知の登録は18人中6人しかいない。
    //    鳴らない人のためにホームのバナーも出している
    const ids: string[] = row.request_ids ?? [];
    const dl = dateLabel(slot.target_date);
    const band = `${s.slice(0, 5)}〜${e.slice(0, 5)}`;
    for (let i = 0; i < ids.length && i < pickedParts.length; i++) {
      await insertNotification(
        pickedParts[i],
        `📅 ${dl}の出勤のお願いが届いています`,
        `${band}${reqLoc ? ` / ${reqLoc}` : ''}`,
        'shift_adjust:part_request',
        ids[i],
        'shift_adjust:part_request',
      );
    }
    setBusyBtn(false);
    setPickedParts([]);
    setStatus(st => (st === 'pending' ? 'working' : st));
    setOkMsg(`${ids.length}人に出勤のお願いを送りました。`);
    void loadPartReqs();
  };

  const undecide = async () => {
    setErr(''); setOkMsg(''); setBusyBtn(true);
    // 取り消す前に、決まっていた人を控える（取り消すと割り当ての行が消える）
    const decidedBefore = assigns;
    const { data, error } = await supabase.rpc('shift_adjust_undecide', { p_slot_id: slot.id });
    setBusyBtn(false); setConfirmUndo(false);
    if (error) { setErr('取り消せませんでした：' + error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.ok) { setErr(row?.reason || '取り消せませんでした'); return; }
    // 決まっていた本人に、取り消しを知らせる（2026-09-25 ユーザー確定の文面）。
    // 🚨 それまでは何も届かず、「出勤が決まりました」を見た人が出勤するつもりのままになっていた。
    // 🚨 正社員は、依頼を受けて申請まで済ませていると申請が残る（取り消しの関数は applied の依頼を触らない）ので、一言添える
    // 🚨 スマホは push-dispatch の決まった文（出勤の予定についてお知らせがあります）。日付と本文はベルで読む
    for (const a of decidedBefore) {
      const isOt = a.kind === 'overtime_request';
      await insertNotification(
        a.user_id,
        `📅 ${dateLabel(slot.target_date)}の出勤についてのお知らせ`,
        '出勤の予定は取り消しとなりました。ご調整いただいていたところ、申し訳ございません。'
          + (isOt ? '残業の申請がお済みの場合は、お手数ですが取り消しをお願いいたします。' : ''),
        isOt ? 'shift_adjust:cancelled_ot' : 'shift_adjust:cancelled',
        slot.id,
        isOt ? 'shift_adjust:cancelled:ot' : 'shift_adjust:cancelled',
      );
    }
    setStatus('working');
    setAssigns([]);
    setOkMsg('決定を取り消しました。');
    void loadAssigns();
    void loadPartReqs();   // 「この方に決定」の印が外れたのを出す（DB で picked を戻している）
  };

  // 候補の並び
  const teamText = (p: ProfileRow): string => teamsOf(p.group_names, teams).join('・');
  const inTeam = (p: ProfileRow, t: string): boolean => t === 'all' || teamsOf(p.group_names, teams).includes(t);
  const roleRankOf = (p: ProfileRow): number => roleByName(roles, p.role_title)?.sort_order ?? 0;
  const worksToday = (uid: string): boolean => patterns.some(x => x.user_id === uid && !!x.start_time);
  /** いつもの校（週の基本シフトでいちばん多く入っている校） */
  const usualOf = (uid: string): string =>
    usualWorkplace(weekPatterns.filter(x => x.user_id === uid && x.start_time).map(x => x.location), workplaces);
  const byPlaceRole = (placeOf: (uid: string) => string) => (a: ProfileRow, b: ProfileRow): number =>
    compareByPlaceRole(
      { place: placeOf(a.id), roleRank: roleRankOf(a), name: a.name || '' },
      { place: placeOf(b.id), roleRank: roleRankOf(b), name: b.name || '' },
      workplaces,
    );
  // この日に勤務予定がある人：その日の校 → 役職 → 名前（2026-09-14 ユーザー確定）
  const todayPlaceOf = (uid: string): string => firstWorkplace(patterns.find(x => x.user_id === uid)?.location);
  const working = profiles
    .filter(p => p.id !== slot.target_user_id && worksToday(p.id))
    .sort(byPlaceRole(todayPlaceOf));
  const workingShown = working.filter(p => inTeam(p, candTeam));
  // この日に勤務予定がない人：いつもの校 → 役職 → 名前。パートと正社員に分ける（2026-09-14 ユーザー確定）
  const resting = profiles
    .filter(p => p.id !== slot.target_user_id && !worksToday(p.id))
    .sort(byPlaceRole(usualOf));
  const restingPart = resting.filter(p => p.employment_type === 'パート');
  /** 🚨 正社員には出勤のお願いを送れない（DB が断る）。個別に連絡して「＋ 入れる」で入れてもらう */
  const restingStaff = resting.filter(p => p.employment_type !== 'パート');
  /** まだお願いを送っていない相手（送った相手は下の「送ったお願い」に出す） */
  const restingUnsent = restingPart.filter(p => !partReqs.some(q => q.user_id === p.id));
  const restingShown = restingUnsent.filter(p => inTeam(p, partTeam));
  const restingStaffShown = restingStaff.filter(p => inTeam(p, partTeam));
  /** 🚨 「この日は休み」とだけ書くと、休暇なのか週のシフトが未登録なのか分からない（2026-09-14 実機指摘）。
   *     休暇・欠勤などの記録があればそれを、なければ「この曜日は勤務なし」か「週のシフト未登録」を出す */
  const restNoteOf = (uid: string): string =>
    busy[uid] ?? (weekPatterns.some(x => x.user_id === uid) ? 'この曜日は勤務なし' : '週のシフト未登録');
  /** 勤務予定がない人の補足（いつもの校・休みの理由） */
  const restLineOf = (uid: string): string => [usualOf(uid), restNoteOf(uid)].filter(Boolean).join('・');
  // 案を作れる／決められる（2026-09-25）。🚨 まだ決まっていない、未調整か調整中の場だけ。休む本人は DB でも断る
  const openStatus = ['pending', 'working'].includes(status) && assigns.length === 0 && slot.target_user_id !== userId;
  const canPlan = perms.plan && openStatus;
  const canDecideNow = perms.decide && openStatus;
  // 出勤する人に入れられるのは、入力欄が開いているか、案を作れる／決められるとき
  const canAdd = openStatus && (!!editor || canPlan || canDecideNow);
  const inDrafts = (uid: string): boolean => drafts.some(x => x.userId === uid);
  // 絞り込みを変えたら、見えなくなった人の選択は外す（見えないまま送られないように）
  const changePartTeam = (t: string) => {
    setPartTeam(t);
    setPickedParts(v => v.filter(id => {
      const p = profiles.find(x => x.id === id);
      return !!p && inTeam(p, t);
    }));
  };

  const shiftTextOf = (uid: string): string => {
    const p = patterns.find(x => x.user_id === uid);
    return p ? normalShiftTimeText({
      start_time: p.start_time, end_time: p.end_time,
      start_time2: p.start_time2, end_time2: p.end_time2,
    }) : '';
  };
  const locOf = (uid: string): string => patterns.find(x => x.user_id === uid)?.location ?? '';
  /** その人のこの日のシフトを1行で（出勤する人の欄・見出しで使う。2026-09-14 ユーザー指示） */
  const dayShiftOf = (uid: string): string => {
    const s = shiftTextOf(uid);
    return s ? `${s}${locOf(uid) ? ` ${locOf(uid)}` : ''}` : `勤務予定なし（${restNoteOf(uid)}）`;
  };
  /** 休む方のこの日のシフト。🚨 見出しと「出勤する人」の枠の2か所に出すので、文はここ1か所で作る */
  const targetShiftText: string = shiftTextOf(slot.target_user_id)
    ? `${shiftTextOf(slot.target_user_id)}${locOf(slot.target_user_id) ? ` ${locOf(slot.target_user_id)}` : ''}`
    : weekPatterns.some(x => x.user_id === slot.target_user_id) ? 'この曜日は勤務なし' : '週のシフト未登録';
  /** メモの文例。日付と校はこの場から入れる（校が分からなければ日付だけ） */
  const memoPlace = `${dateLabel(slot.target_date)}${where}`;
  // 🚨 2026-09-14 ユーザー確定：「時間は上記のとおりです」の文例は削除した
  //    （相手の画面に「上記」の時間は無い。時間はベルの2行目と依頼カードで届ける）
  // 🚨 2026-09-14 ユーザー確定（案A・いつも3つ出す）：もともとこの日に出勤予定の人に頼むときの
  //    「校の移動」（勤務の途中から移る）と「校の変更」（この日の勤務校を変える）を足した。
  //    メモは決定する全員に同じ文が届くので、選んだ人で出し分けない。
  //    校が分からない場は、行き先の校を書かない言い回しにする（「〜から への移動」と崩れないように）
  const memoExamples = [
    `${memoPlace}の欠員のため、出勤をお願いします。`,
    where
      ? `${memoPlace}の欠員のため、勤務の途中から${where}への移動をお願いします。`
      : `${memoPlace}の欠員のため、勤務の途中で校の移動をお願いします。`,
    where
      ? `${memoPlace}の欠員のため、この日の勤務校を${where}へ変更をお願いします。`
      : `${memoPlace}の欠員のため、この日の勤務校の変更をお願いします。`,
  ];

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

  // 🎨🔒 択一トグル（青で固定）。未選択＝薄い青／選択中＝濃い青。枠は常に2px（押しても大きさが変わらない）
  // 🚨 2026-09-14 実機指摘：「シフトを調整する」だけを濃い青で塗っていたため、最初から選ばれているように見えた
  const toggleBtn = (on: boolean, large: boolean, locked = false): React.CSSProperties => ({
    padding: large ? '11px 16px' : '5px 12px', borderRadius: large ? 10 : 16,
    fontSize: large ? 14 : 12, fontWeight: 'bold', whiteSpace: 'nowrap',
    border: `2px solid ${on ? '#1565c0' : '#90caf9'}`,
    background: on ? '#1976d2' : '#e3f2fd', color: on ? '#fff' : '#1565c0',
    cursor: locked || on ? 'default' : 'pointer', opacity: locked && !on ? 0.5 : 1,
  });
  const note: React.CSSProperties = { margin: '8px 0 0', fontSize: 11.5, color: subText, lineHeight: 1.7 };

  // 「対応の選択」は、決められる人には、出勤する人が決まるまでずっと出す（選び直せる・2026-09-14 ユーザー確定）
  const canFork = perms.decide && assigns.length === 0 && ['pending', 'working', 'no_change'].includes(status);
  // 🚨 出勤のお願いを送ったあとは選び直せない（パートの画面が「現在調整中です」のまま残るため）。
  //    DB の shift_adjust_set_status も同じ条件で断る
  const forkLocked = partReqs.length > 0;
  // 出勤する人・候補・出勤のお願いを出すか（未調整のうちは、決められる人にはまず選択だけを見せる）
  const showWork = status !== 'no_change' && !(perms.decide && status === 'pending' && assigns.length === 0);

  // 「＋ 入れる」のボタン（すでに入っている人は印だけ）
  const addBtn = (uid: string) => !canAdd ? null : inDrafts(uid) ? (
    <span style={{ marginLeft: 'auto', fontSize: 11.5, color: subText, whiteSpace: 'nowrap', alignSelf: 'center' }}>✓ 入っています</span>
  ) : (
    <button type="button" onClick={e => { e.preventDefault(); addCandidate(uid); }}
      style={{ ...toggleBtn(false, false), marginLeft: 'auto', alignSelf: 'center' }}>
      ＋ 入れる
    </button>
  );
  // この日のシフトを目立たせる帯（🚨 新しい色は足さない。月の切り替えボタンの選択中と同じ薄い青）
  const shiftBand: React.CSSProperties = {
    marginTop: 6, padding: '6px 10px', borderRadius: 8, fontSize: 12.5,
    background: isDark ? '#1a3a5c' : '#e8f4fd', color: isDark ? '#e9ecef' : '#1565c0',
  };

  const teamChips = (value: string, onChange: (t: string) => void) => (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
      {['all', ...teams].map(t => (
        <button key={t} type="button" onClick={() => onChange(t)} style={toggleBtn(value === t, false)}>
          {t === 'all' ? 'すべて' : t}
        </button>
      ))}
    </div>
  );

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
        {/* 休む方のこの日のシフト（2026-09-14 ユーザー指示）。🚨 週の基本シフトが読めなかったときは出さない（嘘をつかない） */}
        {candLoaded && !candErr && (
          <div style={shiftBand}>
            休む方のこの日のシフト：{targetShiftText}
          </div>
        )}
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

      {/* 対応の選択（まず決めることを最初に出す。出勤する人が決まるまでは何度でも選び直せる） */}
      {canFork && (
        <div style={box}>
          <div style={head}>対応の選択</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button onClick={() => { if (status !== 'working') void setSlotStatus('working'); }}
              disabled={busyBtn || (forkLocked && status !== 'working')}
              style={toggleBtn(status === 'working', true, forkLocked)}>
              シフトを調整する
            </button>
            <button onClick={() => {
                if (status === 'no_change') return;
                // 案があるときは消えることを先に断る（2026-09-25）
                if (plans.length > 0) { setConfirmNoChange(true); return; }
                void setSlotStatus('no_change');
              }}
              disabled={busyBtn || forkLocked}
              style={toggleBtn(status === 'no_change', true, forkLocked)}>
              現行シフトで対応
            </button>
            {/* 🚨 3つとも同じ見た目（2026-09-14 ユーザー確定）。押すと未調整に戻して一覧へ帰る */}
            <button onClick={() => void decideLater()} disabled={busyBtn || forkLocked}
              style={toggleBtn(false, true, forkLocked)}>
              後で決める
            </button>
          </div>
          {forkLocked && (
            <p style={note}>出勤のお願いを送ったため、選び直せません。決定するか、お願いの返事を待ってください。</p>
          )}
          {confirmNoChange && (
            <div ref={confirmNoChangeRef} style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, background: '#fff3cd', border: '2px solid #ffc107', color: '#856404' }}>
              <p style={{ margin: '0 0 8px', fontSize: 12.5, lineHeight: 1.7 }}>案が{plans.length}件あります。現行シフトで対応にすると、案は消えます。</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => { setConfirmNoChange(false); closeEditor(); void setSlotStatus('no_change').then(ok => { if (ok) setPlans([]); }); }}
                  disabled={busyBtn} style={subBtn}>現行シフトで対応にする</button>
                <button type="button" onClick={() => setConfirmNoChange(false)} style={quietBtn}>やめる</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 相談（🚨 対応を決める前から見せる。隠すと、すでにある書き込みが埋もれる）。
          🚨 2026-09-14 ユーザー確定：対応の選択のすぐ下に移した（以前はいちばん下） */}
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

      {/* 案（2026-09-25 ユーザー確定・docs/計画-シフト調整.md §6-2）。相談のすぐ下・入力欄の上 */}
      {assigns.length === 0 && (plans.length > 0 || (showWork && (canPlan || canDecideNow))) && (
        <div style={box}>
          <div style={head}>案{plans.length > 0 ? `（${plans.length}件）` : ''}</div>
          {plans.length === 0 && (
            <p style={{ margin: '0 0 8px', fontSize: 12.5, color: subText }}>まだ案はありません。</p>
          )}
          {plans.map(p => {
            const mine = p.created_by === userId;
            const reviews = p.reviews ?? [];
            const reviewedByMe = reviews.some(r => r.user_id === userId);
            const overdue = !!p.review_due_at && new Date(p.review_due_at).getTime() < Date.now();
            const edited = new Date(p.updated_at).getTime() - new Date(p.created_at).getTime() > 1000;
            const canReview = perms.review && !mine && openStatus;
            const canDel = openStatus && ((mine && perms.plan) || isAdmin);
            const editingThis = editor?.mode === 'edit' && editor.plan.id === p.id;
            return (
              <div key={p.id} style={{ padding: '10px 12px', marginBottom: 8, borderRadius: 10, border: `1px solid ${editingThis ? '#1976d2' : border}` }}>
                <div style={{ fontSize: 13.5, fontWeight: 'bold', color: text }}>
                  案{p.plan_no}
                  <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 'normal', color: subText }}>
                    {mine ? 'あなた' : `${nameOf(p.created_by) || '（名前なし）'}さん`}・{actedAtLabel(p.created_at)}
                    {edited ? `（${actedAtLabel(p.updated_at)} に直しました）` : ''}
                  </span>
                </div>
                {(p.assignments ?? []).map((a, i) => (
                  <div key={i} style={{ fontSize: 13, color: text, marginTop: 4 }}>
                    ・{nameOf(a.user_id) || '（名前なし）'}
                    {profiles.find(x => x.id === a.user_id)?.employment_type === 'パート' ? '（パート）' : ''}
                    <span style={{ marginLeft: 8, color: subText, fontSize: 12.5 }}>{segmentsText(a.segs)}</span>
                  </div>
                ))}
                {p.note && (
                  <div style={{ fontSize: 12.5, color: text, marginTop: 6, whiteSpace: 'pre-wrap' }}>
                    <span style={{ color: subText }}>確認する方へ：</span>{p.note}
                  </div>
                )}
                {p.review_due_at && (
                  <div style={{ fontSize: 12, marginTop: 6, color: overdue ? warnFg : subText }}>
                    {overdue
                      ? `意見の期限を過ぎました（${dueLabel(p.review_due_at)}・確認 ${reviews.length}人）`
                      : `意見の期限 ${dueLabel(p.review_due_at)}`}
                  </div>
                )}
                <div style={{ fontSize: 12, color: subText, marginTop: 4 }}>
                  確認 {reviews.length}人{reviews.length > 0 ? `：${reviews.map(r => nameOf(r.user_id) || '（名前なし）').join('・')}` : ''}
                </div>
                {/* 直したら確認はやり直し（カードに残す・2026-09-25 ユーザー確定） */}
                {p.reviews_reset_at && (
                  <div style={{ fontSize: 12, color: warnFg, marginTop: 2 }}>
                    {actedAtLabel(p.reviews_reset_at)} に直したため、確認はやり直しです（前回 {p.reviews_reset_count ?? 0}人）
                  </div>
                )}
                {canReview && (
                  <div style={{ marginTop: 8 }}>
                    {reviewedByMe ? (
                      <span style={{ fontSize: 12.5, color: text }}>
                        ✓ 確認済み
                        <button type="button" onClick={() => void unreviewPlan(p)} disabled={busyBtn} style={{ ...quietBtn, marginLeft: 8 }}>取り消す</button>
                      </span>
                    ) : (
                      <>
                        <button type="button" onClick={() => void reviewPlan(p)} disabled={busyBtn} style={toggleBtn(false, true)}>確認した</button>
                        <span style={{ marginLeft: 8, fontSize: 11.5, color: subText }}>内容を見ました、の印です。意見は相談へ</span>
                      </>
                    )}
                  </div>
                )}
                {confirmDelPlan === p.id ? (
                  <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: '#fff3cd', border: '2px solid #ffc107', color: '#856404' }}>
                    <p style={{ margin: '0 0 6px', fontSize: 12.5, lineHeight: 1.7 }}>
                      案{p.plan_no}を消します。{reviews.length > 0 ? `確認した${reviews.length}人の記録も消えます。` : ''}
                    </p>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" onClick={() => void deletePlan(p)} disabled={busyBtn} style={subBtn}>消す</button>
                      <button type="button" onClick={() => setConfirmDelPlan(null)} style={quietBtn}>やめる</button>
                    </div>
                  </div>
                ) : (openStatus && (canDecideNow || canPlan || canDel)) && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                    {canDecideNow && (
                      <button type="button" onClick={() => void startDecide(p)} disabled={busyBtn} style={subBtn}>この案で決定へ</button>
                    )}
                    {mine && canPlan && (
                      <button type="button" onClick={() => requestOpen({ mode: 'edit', plan: p }, { assignments: p.assignments, note: p.note, due: p.review_due_at }, `案${p.plan_no}の内容`)}
                        disabled={busyBtn} style={quietBtn}>直す</button>
                    )}
                    {canPlan && (
                      <button type="button" onClick={() => requestOpen({ mode: 'new', fromNo: p.plan_no }, { assignments: p.assignments, note: p.note }, `案${p.plan_no}の内容`)}
                        disabled={busyBtn} style={quietBtn}>この案をもとに新しい案</button>
                    )}
                    {canDel && (
                      <button type="button" onClick={() => setConfirmDelPlan(p.id)} disabled={busyBtn} style={quietBtn}>消す</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {/* 入力中の内容を置き換える前の確認（🚨 黙って消さない） */}
          {confirmReplace && (
            <div ref={confirmReplaceRef} style={{ marginBottom: 8, padding: '10px 12px', borderRadius: 8, background: '#fff3cd', border: '2px solid #ffc107', color: '#856404' }}>
              <p style={{ margin: '0 0 8px', fontSize: 12.5, lineHeight: 1.7 }}>入力中の内容は消えます。{confirmReplace.label}を入れますか。</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => openEditor(confirmReplace.e, confirmReplace.c)} style={subBtn}>入れる</button>
                <button type="button" onClick={() => setConfirmReplace(null)} style={quietBtn}>やめる</button>
              </div>
            </div>
          )}
          {(canPlan || canDecideNow) && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              {canPlan && (
                <button type="button" onClick={() => requestOpen({ mode: 'new' }, { assignments: [] }, '空の入力欄')} disabled={busyBtn} style={subBtn}>＋ 新しい案を作る</button>
              )}
              {canDecideNow && (
                <button type="button" onClick={() => void startDecide()} disabled={busyBtn} style={quietBtn}>案を作らずに決める</button>
              )}
            </div>
          )}
        </div>
      )}

      {/* 出勤する人（決定の内容／入力欄） */}
      {(assigns.length > 0 || editor) && (
        <div ref={workRef} style={{ ...box, scrollMarginTop: 70 }}>
          {assigns.length > 0 ? (
            <>
              <div style={head}>出勤する人</div>
              {assigns.map(a => (
                <div key={a.id} style={{ padding: '6px 0', fontSize: 13.5, color: text }}>
                  <span style={{ fontWeight: 'bold' }}>{nameOf(a.user_id) || '（名前なし）'}</span>
                  <span style={{ marginLeft: 10, color: subText, fontSize: 12.5 }}>
                    {/* 🚨 時間帯ごとに校を出す（以前は最初の校だけで、午後に移る先が見えなかった） */}
                    {segmentsText(a.segments)}
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
          ) : editor && (
            <>
              {/* 🚨 いまの使い方を先頭に1行で出す（案を作っているのか、決定するのかを取り違えないため） */}
              <div style={{ marginBottom: 10, padding: '8px 12px', borderRadius: 8, fontSize: 13, fontWeight: 'bold',
                background: isDark ? '#1a3a5c' : '#e8f4fd', color: isDark ? '#e9ecef' : '#1565c0' }}>
                {editor.mode === 'new'
                  ? `■ 新しい案を作っています${editor.fromNo ? `（案${editor.fromNo}をもとに）` : ''}`
                  : editor.mode === 'edit'
                    ? `■ 案${editor.plan.plan_no}（あなたの案）を直しています`
                    : editor.fromPlan
                      ? `■ 案${editor.fromPlan.plan_no}（${editor.fromPlan.created_by === userId ? 'あなた' : `${nameOf(editor.fromPlan.created_by) || '名前なし'}さん`}）の内容で決定します${editorDirty ? '（変更あり）' : ''}`
                      : '■ 案を作らずに決定します'}
                {editor.mode === 'edit' && (editor.plan.reviews ?? []).length > 0 && (
                  <div style={{ fontSize: 11.5, fontWeight: 'normal', marginTop: 2 }}>直して保存すると、確認はやり直しになります（いま {(editor.plan.reviews ?? []).length}人）</div>
                )}
              </div>
              <div style={head}>
                出勤する人
                {drafts.filter(d => d.userId).length > 0 && (
                  <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 'normal', color: subText }}>
                    {drafts.filter(d => d.userId).length}人
                  </span>
                )}
              </div>
              {/* 🚨 2026-09-14 ユーザー指示：相談が増えると見出しが画面の外に出るので、選ぶ位置にも休む方のシフトを出す */}
              {candLoaded && !candErr && (
                <div style={{ ...shiftBand, marginTop: 0, marginBottom: 8 }}>休む方のこの日のシフト：{targetShiftText}</div>
              )}
              {drafts.length === 0 && (
                <p style={{ margin: '0 0 8px', fontSize: 12.5, color: subText }}>下の候補の「＋ 入れる」か、「＋ 出勤する人を追加」で選んでください。</p>
              )}
              {drafts.map(d => {
                const k = d.userId ? kindOf(d.userId) : null;
                const flashing = !!d.userId && d.userId === flashUid;
                return (
                  <div key={d.key} style={{ padding: '8px 6px', margin: '0 -6px', borderBottom: `1px solid ${border}`, borderRadius: 8,
                    background: flashing ? (isDark ? '#1a3a5c' : '#e8f4fd') : 'transparent', transition: 'background .4s' }}>
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
                    {/* 選んだ人のこの日のシフト（2026-09-14 ユーザー指示）。入る時間は手入力 */}
                    {d.userId && candLoaded && !candErr && (
                      <div style={shiftBand}>この日のシフト：{dayShiftOf(d.userId)}</div>
                    )}
                    {/* 入る時間帯。🚨 2026-09-14：1人で複数持てる（午前は本校・午後から別の校へ移る、など） */}
                    {d.segs.map((sg, i) => (
                      <div key={i} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
                        <span style={{ fontSize: 12, color: subText }}>{d.segs.length > 1 ? `入る時間${i + 1}` : '入る時間'}</span>
                        <TimeInput value={sg.start} onChange={v => patchSeg(d.key, i, { start: v })} isDark={isDark} ariaLabel="開始時刻" />
                        <span style={{ color: subText }}>〜</span>
                        <TimeInput value={sg.end} onChange={v => patchSeg(d.key, i, { end: v })} isDark={isDark} ariaLabel="終了時刻" />
                        <select value={sg.location} onChange={e => patchSeg(d.key, i, { location: e.target.value })} style={sel}>
                          <option value="">校を選択</option>
                          {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
                        </select>
                        {d.segs.length > 1 && (
                          <button type="button" onClick={() => removeSeg(d.key, i)} style={{ ...quietBtn, marginLeft: 0 }}>この時間帯を削除</button>
                        )}
                      </div>
                    ))}
                    <button type="button" onClick={() => addSeg(d.key)} style={{ ...quietBtn, marginLeft: 0, marginTop: 4 }}>
                      ＋ 時間帯を追加（午後から別の校へ移る場合など）
                    </button>
                    {k && editor.mode === 'decide' && (
                      <div style={{ fontSize: 11.5, color: subText, marginTop: 4 }}>
                        {k === 'attendance' ? '勤怠に休日出勤として登録します。' : '残業申請を依頼します。'}
                      </div>
                    )}
                  </div>
                );
              })}
              <button onClick={addDraft} style={{ ...quietBtn, marginLeft: 0, marginTop: 8 }}>＋ 出勤する人を追加</button>

              {editor.mode === 'decide' ? (
                <>
                  {/* ─ 決定の設定 ─（🚨 案には持たせない。決定のときだけ入れる） */}
                  <div style={{ marginTop: 12, display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5, color: text }}>
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                      <input type="checkbox" checked={doAttendance}
                        onChange={e => { touchedAuto.current = true; setDoAttendance(e.target.checked); }} />
                      勤怠に登録する
                    </label>
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                      <input type="checkbox" checked={doRequest}
                        onChange={e => { touchedAuto.current = true; setDoRequest(e.target.checked); }} />
                      残業申請を依頼する
                    </label>
                  </div>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', marginTop: 10, fontSize: 12.5, color: text }}>
                    <input type="checkbox" checked={notifyStaff} onChange={e => setNotifyStaff(e.target.checked)} />
                    本人にお知らせを送る
                  </label>
                  {!notifyStaff && (
                    <p style={note}>依頼・勤怠の登録はしますが、ベル・スマホのお知らせは送りません（事前に直接伝えた場合）。</p>
                  )}
                  {notifyStaff && (<>
                  {/* メモの文例（2026-09-14 ユーザー確定・案1）。押すとメモを置き換える。
                      🚨 休む方の名前は入れない。メモは正社員には残業申請の依頼とベルでそのまま届き、
                         パートは勤怠カレンダーの休日出勤の記録に残るため（計画書「誰の代わりかは載せない」） */}
                  <div style={{ fontSize: 12, color: subText, marginTop: 14 }}>文例（押すとメモに入ります）</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                    {memoExamples.map(ex => (
                      <button key={ex} type="button" onClick={() => setMemo(ex)}
                        style={{ textAlign: 'left', fontSize: 12, fontWeight: 'bold', padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
                          border: `1px solid ${isDark ? '#3d5166' : '#90caf9'}`, background: isDark ? '#2c3e50' : '#e8f4fd', color: isDark ? '#fff' : '#1565c0' }}>
                        文例 ー「{ex}」
                      </button>
                    ))}
                  </div>
                  <div style={{ fontSize: 12, color: subText, marginTop: 10 }}>出勤する方へのメモ（届きます）</div>
                  <textarea value={memo} onChange={e => setMemo(e.target.value)} placeholder="メモ（任意）" rows={2}
                    style={{ ...sel, width: '100%', boxSizing: 'border-box', marginTop: 4, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }} />
                  </>)}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
                    <button onClick={() => void decide()} disabled={busyBtn} style={mainBtn}>決定する</button>
                    <button type="button" onClick={closeEditor} disabled={busyBtn} style={quietBtn}>やめる</button>
                  </div>
                </>
              ) : (
                <>
                  {/* ─ 案の設定 ─（確認する方へ・意見の期限）。🚨 出勤する方には届かない */}
                  <div style={{ fontSize: 12, color: subText, marginTop: 12 }}>確認する方へ（出勤する方には届きません）</div>
                  <textarea value={planNote} onChange={e => setPlanNote(e.target.value)} placeholder="例：西陣が手薄なので" rows={2}
                    style={{ ...sel, width: '100%', boxSizing: 'border-box', marginTop: 4, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }} />
                  <div style={{ fontSize: 12, color: subText, marginTop: 10 }}>意見の期限（任意）</div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
                    <input type="datetime-local" value={planDue} onChange={e => setPlanDue(e.target.value)} style={sel} aria-label="意見の期限" />
                    {planDue && <button type="button" onClick={() => setPlanDue('')} style={{ ...quietBtn, marginLeft: 0 }}>期限を外す</button>}
                  </div>
                  <p style={note}>期限を付けると、確認する方にお知らせが届きます。期限を過ぎたら、あなたにお知らせします。</p>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
                    <button onClick={() => void savePlanFromEditor()}
                      disabled={busyBtn || (editor.mode === 'new' && !!editor.fromNo && !editorDirty)} style={mainBtn}>案を保存</button>
                    <button type="button" onClick={closeEditor} disabled={busyBtn} style={quietBtn}>やめる</button>
                  </div>
                  {editor.mode === 'new' && !!editor.fromNo && !editorDirty && (
                    <p style={note}>もとの案から1か所も変えていないため、まだ保存できません。</p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* 候補（この日に勤務予定がある人）。
          🚨 勤務予定がないパートは、下の「出勤のお願い」にだけ出す（2026-09-14 ユーザー確定・案2）。
             以前は「休みのパート」として両方に同じ人を並べていた */}
      {showWork && (
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
                  {teamChips(candTeam, setCandTeam)}
                  <div style={{ fontSize: 12, color: subText, margin: '0 0 4px' }}>この日に勤務予定がある人（校・役職の順）</div>
                  {workingShown.length === 0 ? (
                    <p style={{ margin: '0 0 10px', fontSize: 12.5, color: subText }}>
                      {working.length === 0 ? '該当者はいません。' : 'このチームには該当者がいません。'}
                    </p>
                  ) : workingShown.map((p, i) => {
                    const place = todayPlaceOf(p.id);
                    const prev = i > 0 ? todayPlaceOf(workingShown[i - 1].id) : null;
                    return (
                      <React.Fragment key={p.id}>
                        {place !== prev && (
                          <div style={{ fontSize: 12, fontWeight: 'bold', color: subText, margin: i === 0 ? '4px 0 2px' : '12px 0 2px' }}>
                            {place || '校の登録なし'}
                          </div>
                        )}
                        <CandidateRow name={p.name || ''} team={teamText(p)}
                          role={p.role_title || (p.employment_type === 'パート' ? 'パート' : '')}
                          shift={shiftTextOf(p.id)} loc={locOf(p.id) !== place ? locOf(p.id) : ''} note={busy[p.id] ?? ''} isDark={isDark}
                          action={busy[p.id] ? null : addBtn(p.id)} />
                      </React.Fragment>
                    );
                  })}
                  <p style={{ margin: '10px 0 0', fontSize: 11, color: subText, lineHeight: 1.7 }}>
                    ※ 週の基本シフトが未登録の方は表示されません。
                    <br />
                    ※ この日に勤務予定がない人は、下の「この日に勤務予定がない人」に表示します。
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* この日に勤務予定がない人（2026-09-14 ユーザー確定。以前の見出しは「出勤のお願い（パート・アルバイトへ）」）
          ・パート … 出勤のお願いを送れる（チェック）＋ 個別に連絡して「＋ 入れる」
          ・正社員 … 🚨 出勤のお願いは送れない（DB が断る。正社員は決定のときに「残業申請の依頼」が出る）。
                     LINE などで個別に連絡して「＋ 入れる」で出勤する人に入れる
          🚨 呼び名「出勤のお願い」は既存の「申請の依頼」と紛れないように（ユーザー確定） */}
      {showWork && (perms.request || canAdd || partReqs.length > 0) && (
        <div style={box}>
          <div style={head}>この日に勤務予定がない人</div>

          {(perms.request || canAdd) && (
            !candLoaded ? (
              <p style={{ margin: 0, fontSize: 12.5, color: subText }}>読み込んでいます…</p>
            ) : (
              <>
                {teamChips(partTeam, changePartTeam)}
                <div style={{ fontSize: 12, fontWeight: 'bold', color: subText, margin: '4px 0 2px' }}>
                  パート{perms.request ? '（出勤のお願いを送れます）' : ''}
                </div>
                {restingShown.length === 0 ? (
                  <p style={{ margin: '0 0 8px', fontSize: 12.5, color: subText }}>
                    {restingUnsent.length === 0 ? '該当するパートはいません。' : 'このチームには該当者がいません。'}
                  </p>
                ) : restingShown.map(p => {
                  // 🚨 休暇・欠勤などの記録がある人は選べない（opacity 0.5・新しい色は足さない）
                  const blocked = !!busy[p.id];
                  const t = teamText(p);
                  return (
                    <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', padding: '5px 0',
                      fontSize: 13, color: text, opacity: blocked ? 0.5 : 1 }}>
                      {perms.request && (
                        <input type="checkbox" checked={pickedParts.includes(p.id)} disabled={blocked}
                          aria-label={`${p.name}に出勤のお願いを送る`}
                          style={{ alignSelf: 'center', cursor: blocked ? 'default' : 'pointer' }}
                          onChange={e => setPickedParts(v => e.target.checked ? [...v, p.id] : v.filter(x => x !== p.id))} />
                      )}
                      <span style={{ fontWeight: 'bold' }}>{p.name}</span>
                      {t && <TeamTag team={t} isDark={isDark} />}
                      <span style={{ fontSize: 11, color: subText }}>{restLineOf(p.id)}</span>
                      {/* 🚨 スマホ通知を登録していない人は、アプリを開くまで気づかない。
                          🚨 ただし登録状況が読めたときだけ出す（読めないのに「なし」と書かない） */}
                      {perms.request && pushKnown && !pushUsers.includes(p.id) && (
                        <span style={{ fontSize: 11, color: subText }}>スマホ通知なし</span>
                      )}
                      {!blocked && addBtn(p.id)}
                    </div>
                  );
                })}

                {perms.request && pickedParts.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <TimeInput value={reqStart} onChange={setReqStart} isDark={isDark} ariaLabel="開始時刻" />
                      <span style={{ color: subText }}>〜</span>
                      <TimeInput value={reqEnd} onChange={setReqEnd} isDark={isDark} ariaLabel="終了時刻" />
                      <select value={reqLoc} onChange={e => setReqLoc(e.target.value)} style={sel}>
                        <option value="">校を選択</option>
                        {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
                      </select>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, color: subText }}>返事の期限（任意）</span>
                      <input type="datetime-local" value={dueAt} onChange={e => setDueAt(e.target.value)} style={sel} />
                    </div>
                    <p style={{ margin: '8px 0 0', fontSize: 11, color: subText, lineHeight: 1.7 }}>
                      ※ 送る内容は「日付・時間帯・校」だけです。誰の代わりかは相手に表示されません。
                      <br />
                      ※ スマホ通知を登録していない方には、アプリを開くまで届きません。
                      <br />
                      ※ お願いを送ると、上の「対応の選択」は選び直せなくなります。
                    </p>
                    <button onClick={() => void sendParts()} disabled={busyBtn}
                      style={{ ...mainBtn, marginTop: 10 }}>
                      {pickedParts.length}人に出勤のお願いを送る
                    </button>
                  </div>
                )}
              </>
            )
          )}

          {partReqs.length > 0 && (
            <div style={{ marginTop: perms.request || canAdd ? 14 : 0 }}>
              <div style={{ fontSize: 12, color: subText, margin: '0 0 4px' }}>送ったお願い（パート）</div>
              {partReqs.map(q => (
                <div key={q.id} style={{ padding: '6px 0', fontSize: 13, color: text, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 'bold' }}>{nameOf(q.user_id) || '（名前なし）'}</span>
                  <span style={{ fontSize: 12, color: subText }}>
                    {(q.segments ?? []).map(s => `${s.start}〜${s.end}`).join(' ＋ ')}
                  </span>
                  <span style={{ fontSize: 12, color: q.answer === 'yes' ? text : subText, fontWeight: q.answer === 'yes' ? 'bold' : 'normal' }}>
                    {q.answer === 'yes' ? '入れます'
                      : q.answer === 'no' ? '入れません'
                      : q.due_at && new Date(q.due_at).getTime() < Date.now() ? '返事なし（期限を過ぎました）'
                      : '返事待ち'}
                  </span>
                  {q.picked && <span style={{ fontSize: 11, color: subText }}>この方に決定</span>}
                  <span style={{ fontSize: 11, color: subText }}>
                    {actedAtLabel(q.sent_at)}に送信
                  </span>
                  {!busy[q.user_id] && addBtn(q.user_id)}
                </div>
              ))}
            </div>
          )}

          {/* 正社員（2026-09-14 ユーザー確定：パートの下に区切って出す） */}
          {canAdd && candLoaded && (
            <>
              <div style={{ borderTop: `1px dashed ${border}`, margin: '14px 0 4px' }} />
              <div style={{ fontSize: 12, fontWeight: 'bold', color: subText, margin: '4px 0 2px' }}>
                正社員（出勤のお願いは送れません。LINE などで個別に連絡して「＋ 入れる」を押してください）
              </div>
              {restingStaffShown.length === 0 ? (
                <p style={{ margin: 0, fontSize: 12.5, color: subText }}>
                  {restingStaff.length === 0 ? '該当する正社員はいません。' : 'このチームには該当者がいません。'}
                </p>
              ) : restingStaffShown.map(p => {
                const blocked = !!busy[p.id];
                const t = teamText(p);
                return (
                  <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', padding: '5px 0',
                    fontSize: 13, color: text, opacity: blocked ? 0.5 : 1 }}>
                    <span style={{ fontWeight: 'bold' }}>{p.name}</span>
                    {t && <TeamTag team={t} isDark={isDark} />}
                    {p.role_title && <span style={{ fontSize: 11, color: subText }}>{p.role_title}</span>}
                    <span style={{ fontSize: 11, color: subText }}>{restLineOf(p.id)}</span>
                    {!blocked && addBtn(p.id)}
                  </div>
                );
              })}
            </>
          )}

        </div>
      )}

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

/** 所属チームの小さな札（こども／大人／管理部）。🚨 新しい色は足さない（既存の枠線・補足の文字色） */
const TeamTag: React.FC<{ team: string; isDark: boolean }> = ({ team, isDark }) => (
  <span style={{
    fontSize: 10.5, padding: '0 6px', borderRadius: 8, whiteSpace: 'nowrap',
    border: `1px solid ${isDark ? '#6c757d' : '#ced4da'}`, color: isDark ? '#adb5bd' : '#666',
  }}>{team}</span>
);

const CandidateRow: React.FC<{
  name: string; team: string; role: string; shift: string; loc: string; note: string; isDark: boolean;
  /** 右端のボタン（「＋ 入れる」など） */
  action?: React.ReactNode;
}> = ({ name, team, role, shift, loc, note, isDark, action }) => {
  const text = isDark ? '#e9ecef' : '#333';
  const subText = isDark ? '#adb5bd' : '#666';
  // 🚨 選べない人は opacity で薄くする（新しい色を足さない）
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
      padding: '5px 0', opacity: note ? 0.5 : 1 }}>
      <span style={{ fontSize: 13, color: text, fontWeight: 'bold' }}>{name || '（名前なし）'}</span>
      {/* チームと役職（2026-09-14 ユーザー指示：どこのチームの人か分からない） */}
      {team && <TeamTag team={team} isDark={isDark} />}
      {role && <span style={{ fontSize: 11, color: subText }}>{role}</span>}
      {shift && <span style={{ fontSize: 12, color: subText }}>{shift}</span>}
      {loc && <span style={{ fontSize: 11, color: subText }}>{loc}</span>}
      {note && <span style={{ fontSize: 11, color: subText }}>（{note}）</span>}
      {action}
    </div>
  );
};

export default ShiftAdjustTab;
