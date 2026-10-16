import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import SearchableSelect from '../common/SearchableSelect';
import { resolveNormalShift, normalShiftBands, normalShiftTimeText, normalShiftEdges } from '../../lib/overtimeShift';
import type { PatternRow } from '../../lib/overtimeShift';
import type { CalendarKind } from '../../lib/breakCalc';
import { todayJstStr, calcPayPeriodStartJst, shiftPayPeriod, payPeriodLabel } from '../../lib/breakCalc';
import { dispatchEmail, getUserEmail } from '../../lib/notificationDispatch';
import {
  loadDayStates, answerLabel, segmentsText, reportKindText, diffFromShift, signedText, followUpOf,
  isEarlyClockIn, defaultAskSide, ASK_SIDE_LABEL, clockText, lastClockOut,
} from '../../lib/clockInquiry';
import type { InquiryAnswer, DayStateRow, DayState, AskSide } from '../../lib/clockInquiry';
import { STATUS_INFO } from '../../lib/overtimeStatus';
import type { OvertimeStatus } from '../../lib/overtimeStatus';
import type { WorkSegment } from '../../lib/breakCalc';
import { editFigures, editChanges, saveAdminOvertimeEdit, segsLabel, currentSegsOf } from '../../lib/overtimeAdminEdit';
import { notifyOvertimeAdminCancelled } from '../../lib/overtimeNotify';
import { primaryBtn, backBtn, tintBtn } from '../../lib/buttonStyles';
import OvertimeEditModal, { type OvertimeRecord } from './OvertimeEditModal';

// 経理（管理者）が「この日の打刻が遅いが残業か」を本人に確認する画面。
// ・1人 × 複数日をまとめて送る（給与計算で1人ぶんのタイムカードを見ながら拾うため）
// ・通常シフトは自動表示。経理が入れるのは打刻だけ（転記を減らすのが最大の時短）
// ・送信すると、その日だけ締め後でも報告できる許可が自動で付く（RPC側）
// ・申請がある日にも送れる（2026-10-13・経理担当の意見）。その日の申請の中身を横に出す。
//   本人の答えは申請の状態で変わる（lib/clockInquiry.ts・DB の answer_overtime_clock_inquiry）
// ・段階2（2026-10-13 ユーザー確定）：答えのカードから経理が対応する
//   ［この時刻で申請を直す］…カードの中で「前→後」を見せて［直す］（計算と保存は lib/overtimeAdminEdit・［📋修正］と共用）
//   ［取り消して定時にする］…本人の正しい時間が残業なし（±0:00）で、残業・早出だけの申請のとき。DB の resolve_clock_inquiry_cancel 1回
//   ［直さずに終える］（理由必須）／［この日をもう一度聞く］（上の送る欄に入れる。送ったら前の日は「このまま」）

interface StaffRow { id: string; name: string; role_title: string | null }

/** ask_side：何について聞くか（2026-10-13）。null＝打刻を見て自動（defaultAskSide）。出勤が早い日だけ経理が選べる */
interface DayInput {
  work_date: string; clock_in: string; clock_out: string; ask_side: AskSide | null;
  /** 2組目の打刻（外出・戻りなど・2026-10-13）。two＝2組目の欄を出しているか */
  two: boolean; clock_in2: string; clock_out2: string;
}
interface InquiryDay {
  id: string; work_date: string; shift_start: string | null; shift_end: string | null;
  // 第2の時間帯（テレワーク・中抜けなど）。無い日は null
  shift_start2: string | null; shift_end2: string | null;
  clock_in: string | null; clock_out: string | null;
  clock_in2: string | null; clock_out2: string | null;
  answer: InquiryAnswer;
  answer_reason: string | null; answer_note: string | null; result_report_id: string | null;
  existing_report_id: string | null; report_state: DayState | null;
  answer_segments: { start_min: number; end_min: number }[] | null;
  resolved_kind: 'edited' | 'cancelled' | 'kept' | null;
  ask_side: AskSide | null;
  resolved_at: string | null; resolved_by: string | null; resolved_note: string | null;
}
/** 答えの一覧で出す申請の中身（いまの状態） */
interface ReportBrief {
  id: string; status: string; is_post_hoc: boolean; application_types: string[] | null; diff_minutes: number | null;
  normal_shift: { labor_minutes?: number } | null; furikae_origin_date: string | null; work_date: string;
  segments: { phase: string; start_min: number; end_min: number }[] | null;
}
/** 残業・早出だけの申請か（定時にしてよいのはこれだけ。DB の resolve_clock_inquiry_cancel と同じ条件） */
const onlyOvertimeTypes = (types: string[] | null) => (types ?? []).every(t => t === 'overtime' || t === 'early_start');
/** カードの中の［直す］の確認に出すもの */
interface EditDraft {
  dayId: string; record: OvertimeRecord; segs: WorkSegment[];
  fig: ReturnType<typeof editFigures>; changes: Record<string, { old: unknown; new: unknown }>; summary: string;
}
interface InquiryRow {
  id: string; user_id: string; sender_id: string; message: string | null;
  status: 'open' | 'answered' | 'withdrawn'; answered_at: string | null; created_at: string;
  days: InquiryDay[];
}
interface ClockOnlyRow {
  id: string; applicant_id: string; work_date: string; reason: string | null;
  clock_in_reported: string | null; clock_out_reported: string | null;
  accounting_checked_at: string | null;
}

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const dowOf = (d: string) => DOW[new Date(d + 'T00:00:00').getDay()];
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const hm = (t: string | null) => (t ? t.slice(0, 5) : '—');

// 一言の文例。
// ⚠️ 「残業ではないですよね」のように、答えを誘導する書き方は入れないこと。
//    経理（立場が上）から届く確認なので、押し付けに読めるとサービス残業の同意記録になる。
const MESSAGE_EXAMPLES = [
  'この日の打刻について確認させてください',
  '業務をしていた場合は、残業として報告してください',
  '給与計算のため確認させてください',
];

// ［直さずに終える］の理由の文例（押すと入る）
const KEEP_NOTE_EXAMPLES = ['申請の通りで問題なし', '本人と話して確認済み'];

interface Props { staff: StaffRow[]; isDark: boolean }

const OvertimeClockInquiryPanel: React.FC<Props> = ({ staff, isDark }) => {
  const text = isDark ? '#e9ecef' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#5a6268' : '#dee2e6';
  const cardBg = isDark ? '#343a40' : '#fff';
  const innerBg = isDark ? '#495057' : '#f8f9fa';
  const inputStyle: React.CSSProperties = {
    padding: '6px 8px', borderRadius: 6, border: `1px solid ${border}`,
    background: isDark ? '#495057' : '#fff', color: text, fontSize: 13,
  };

  const [targetId, setTargetId] = useState('');
  const [rows, setRows] = useState<DayInput[]>([]);
  const [newDate, setNewDate] = useState('');
  const [message, setMessage] = useState('');
  const [patterns, setPatterns] = useState<PatternRow[]>([]);
  const [calendarKinds, setCalendarKinds] = useState<Record<string, CalendarKind | null>>({});
  // 送る日の申請の状態（2026-10-13・申請がある日も送れる。中身を出して見比べてもらう）
  const [dayStates, setDayStates] = useState<Record<string, DayStateRow>>({});
  const [dayStateErr, setDayStateErr] = useState('');
  // 送った確認の一覧：申請の今の中身・対応待ちだけの絞り込み
  const [reportBriefs, setReportBriefs] = useState<Record<string, ReportBrief>>({});
  const [onlyAction, setOnlyAction] = useState(false);
  // 本人が「定時」（シフト通り勤務した）と記録している日 → 記録した日時（2026-10-12）。問い合わせを送る前に分かるように
  const [dayCheckAt, setDayCheckAt] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const [inquiries, setInquiries] = useState<InquiryRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  // 一言の「よく使う履歴」（過去に自分が送った一言・重複除去・新しい順）。
  // 残業フォームの理由履歴と同じ作り：押すと入力／✕でその候補だけ端末に記憶して出さない
  const [myId, setMyId] = useState('');
  const [pastMessages, setPastMessages] = useState<string[]>([]);
  const [hiddenMessages, setHiddenMessages] = useState<string[]>([]);
  const [showAllMessages, setShowAllMessages] = useState(false);
  const [withdrawTarget, setWithdrawTarget] = useState<string | null>(null);
  const [clockRows, setClockRows] = useState<ClockOnlyRow[]>([]);
  // 打刻の確認への答え（業務はしていません）でできた記録（自動で確認済みになる・2026-10-14）。一覧に「打刻の確認から」と出す
  const [fromInquiryIds, setFromInquiryIds] = useState<Set<string>>(new Set());
  // 段階2：答えのカードでの対応（開いている操作は1つだけ）
  const [op, setOp] = useState<{ dayId: string; kind: 'cancel' | 'keep' } | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [keepNote, setKeepNote] = useState('');
  const [opBusy, setOpBusy] = useState(false);
  const [opErr, setOpErr] = useState<{ dayId: string; msg: string } | null>(null);
  const [modal, setModal] = useState<{ record: OvertimeRecord; clockInquiry: { dayId: string; segments: { start_min: number; end_min: number }[] | null; note: string | null } } | null>(null);
  // ［この日をもう一度聞く］で上の欄に入れた日（送れたら前の確認を「このまま」にする）
  const [reask, setReask] = useState<{ dayId: string; userId: string; workDate: string }[]>([]);
  const sendRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => { setNames(Object.fromEntries(staff.map(s => [s.id, s.name]))); }, [staff]);

  // 自分が過去に送った一言を集める（重複除去・新しい順・空は除く）
  useEffect(() => {
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id ?? '';
      setMyId(uid);
      if (!uid) return;
      try {
        const v = JSON.parse(localStorage.getItem(`fivem_hidden_msgs_clock_inquiry_${uid}`) || '[]');
        setHiddenMessages(Array.isArray(v) ? v : []);
      } catch { /* 読めなくても履歴は出す */ }
      const { data } = await supabase.from('overtime_clock_inquiries')
        .select('message').eq('sender_id', uid).not('message', 'is', null)
        .order('created_at', { ascending: false }).limit(60);
      const seen = new Set<string>();
      const list: string[] = [];
      (data ?? []).forEach((r: { message: string | null }) => {
        const m = (r.message ?? '').trim();
        if (m && !seen.has(m)) { seen.add(m); list.push(m); }
      });
      setPastMessages(list.slice(0, 10));
    })();
  }, []);

  const hideMessage = (m: string) => {
    setHiddenMessages(prev => {
      const next = [...prev, m];
      try { localStorage.setItem(`fivem_hidden_msgs_clock_inquiry_${myId}`, JSON.stringify(next)); } catch { /* 保存できなくても表示は消す */ }
      return next;
    });
  };
  const visiblePastMessages = useMemo(
    () => pastMessages.filter(m => !hiddenMessages.includes(m)),
    [pastMessages, hiddenMessages],
  );

  // 対象者を選んだら曜日パターンを取得（通常シフトの自動表示に使う）
  useEffect(() => {
    if (!targetId) { setPatterns([]); setDayStates({}); return; }
    (async () => {
      const { data } = await supabase.from('weekly_shift_patterns').select('*').eq('user_id', targetId);
      setPatterns((data ?? []) as PatternRow[]);
    })();
  }, [targetId]);

  // 選んだ日の会社カレンダーと、すでに残業の記録がある日を取得
  useEffect(() => {
    const dates = rows.map(r => r.work_date);
    if (!targetId || dates.length === 0) { setDayStates({}); setDayCheckAt({}); return; }
    (async () => {
      const { data: cal } = await supabase.from('company_calendar').select('date, kind').in('date', dates);
      setCalendarKinds(Object.fromEntries((cal ?? []).map(c => [c.date, c.kind as CalendarKind])));
      const st = await loadDayStates(targetId, dates);
      setDayStates(st.map); setDayStateErr(st.error ?? '');
      const { data: chk, error: chkErr } = await supabase.from('overtime_day_checks')
        .select('work_date, created_at').eq('user_id', targetId).in('work_date', dates);
      if (chkErr) console.error('[打刻の確認] 定時の記録を読めませんでした', chkErr.message);
      setDayCheckAt(Object.fromEntries((chk ?? []).map(c => [c.work_date as string, c.created_at as string])));
    })();
  }, [targetId, rows]);

  const loadInquiries = useCallback(async () => {
    const { data } = await supabase.from('overtime_clock_inquiries')
      .select('*').order('created_at', { ascending: false }).limit(40);
    const list = (data ?? []) as InquiryRow[];
    if (list.length > 0) {
      const { data: ds } = await supabase.from('overtime_clock_inquiry_days')
        .select('*').in('inquiry_id', list.map(i => i.id)).order('work_date');
      const byId: Record<string, InquiryDay[]> = {};
      (ds ?? []).forEach((d: InquiryDay) => { (byId[(d as InquiryDay & { inquiry_id: string }).inquiry_id] ??= []).push(d); });
      list.forEach(i => { i.days = byId[i.id] ?? []; });
      // 答えに結び付いた申請の、いまの中身（状態・時間・差）
      const ids = [...new Set((ds ?? []).flatMap((d: InquiryDay) => [d.existing_report_id, d.result_report_id]).filter((x): x is string => !!x))];
      if (ids.length > 0) {
        const { data: reps, error: repErr } = await supabase.from('overtime_reports')
          .select('id, status, is_post_hoc, application_types, diff_minutes, normal_shift, furikae_origin_date, work_date, segments:overtime_report_segments(phase, start_min, end_min)')
          .in('id', ids);
        if (repErr) console.error('[打刻の確認] 申請の中身を読めませんでした', repErr.message);
        setReportBriefs(Object.fromEntries(((reps ?? []) as ReportBrief[]).map(r => [r.id, r])));
      }
    }
    setInquiries(list);
  }, []);

  // 打刻ズレの一覧は給与期間（16日〜翌15日）ごと（2026-10-13・前は新しい順60件だけで、期間で突き合わせられなかった）
  const [clockPeriod, setClockPeriod] = useState(() => calcPayPeriodStartJst(todayJstStr()));
  const [clockOnlyUnchecked, setClockOnlyUnchecked] = useState(false);
  const [clockErr, setClockErr] = useState('');
  const loadClockRows = useCallback(async () => {
    const { data, error } = await supabase.from('overtime_reports')
      .select('id, applicant_id, work_date, reason, clock_in_reported, clock_out_reported, accounting_checked_at')
      .contains('application_types', ['clock_only']).neq('status', 'cancelled')
      .eq('pay_period_start', clockPeriod)
      .order('work_date', { ascending: false }).limit(1000);
    setClockErr(error ? '打刻ズレの記録を読み込めませんでした：' + error.message : '');
    const rows = (data ?? []) as ClockOnlyRow[];
    setClockRows(rows);
    const ids = rows.map(r => r.id);
    if (ids.length === 0) { setFromInquiryIds(new Set()); return; }
    const { data: links, error: linkErr } = await supabase.from('overtime_clock_inquiry_days')
      .select('result_report_id').in('result_report_id', ids);
    if (linkErr) console.error('[打刻ズレの記録] 打刻の確認とのつながりを読めませんでした', linkErr.message);
    setFromInquiryIds(new Set(((links ?? []) as { result_report_id: string | null }[]).map(l => l.result_report_id).filter((x): x is string => !!x)));
  }, [clockPeriod]);

  useEffect(() => { loadInquiries(); loadClockRows(); }, [loadInquiries, loadClockRows]);

  const addDate = () => {
    if (!newDate) return;
    if (rows.some(r => r.work_date === newDate)) { setErr('その日はすでに追加されています'); return; }
    setErr('');
    setRows(prev => [...prev, { work_date: newDate, clock_in: '', clock_out: '', ask_side: null, two: false, clock_in2: '', clock_out2: '' }].sort((a, b) => (a.work_date < b.work_date ? -1 : 1)));
    setNewDate('');
  };

  // 🚨 2026-10-13：申請がある日も送れる（前は除いていた）
  const sendable = rows;

  /** 何について聞くか。出勤が早くない日はいつも「退勤のあと」（選ぶ欄も出さない） */
  //  🚨 シフトの始まり・終わりは「いちばん早い始まり・いちばん遅い終わり」（normalShiftEdges）。
  //     1本目の始まり・2本目の終わりと決め打ちすると、2本目のほうが早い人（朝 6:30〜7:15 ＋ 9:30〜17:30）で
  //     終わりが 7:15 になっていた（2026-10-16 経理担当の指摘）
  const askSideOf = (r: DayInput, ns: Parameters<typeof normalShiftEdges>[0]): AskSide => {
    const edges = normalShiftEdges(ns);
    if (!isEarlyClockIn(edges?.start, r.clock_in)) return 'after';
    // 退勤は最後の打刻（1組目の退勤・2組目の出勤・2組目の退勤のうち、いちばん遅い時刻・lib/clockInquiry の lastClockOut）
    return r.ask_side ?? defaultAskSide(edges?.start, edges?.end, r.clock_in,
      lastClockOut({ clock_out: r.clock_out || null, clock_in2: r.two ? (r.clock_in2 || null) : null, clock_out2: r.two ? (r.clock_out2 || null) : null }));
  };

  const validate = (): string => {
    if (!targetId) return '対象者を選んでください';
    if (sendable.length === 0) return '日を追加してください';
    for (const r of sendable) {
      // 🚨 4つ（1組目・2組目の出勤・退勤）のうち1つでも入っていれば送れる（2026-10-16 経理担当の意見：打刻の押し忘れがある）。
      //    押し忘れた所は「—」と出る（clockText）。「退勤のあと」の基準は入っている中でいちばん遅い時刻（lastClockOut）
      if (!r.clock_out && !r.clock_in && !(r.two && (r.clock_in2 || r.clock_out2))) return `${md(r.work_date)}の打刻を入力してください`;
    }
    return '';
  };

  const doSend = async () => {
    setSending(true); setErr(''); setMsg('');
    try {
      const payload = sendable.map(r => {
        const ns = resolveNormalShift(patterns, r.work_date, calendarKinds[r.work_date] ?? null);
        return {
          work_date: r.work_date,
          // 第2の時間帯も書き写す。ここで落とすと、本人の回答画面に出ないまま
          // 「この打刻は残業ですか？」と聞くことになる
          shift_start2: ns.start_time2 ? ns.start_time2.slice(0, 5) : null,
          shift_end2: ns.end_time2 ? ns.end_time2.slice(0, 5) : null,
          shift_start: ns.start_time ? ns.start_time.slice(0, 5) : null,
          shift_end: ns.end_time ? ns.end_time.slice(0, 5) : null,
          clock_in: r.clock_in || null,
          clock_out: r.clock_out || null,
          clock_in2: r.two ? (r.clock_in2 || null) : null,
          clock_out2: r.two ? (r.clock_out2 || null) : null,
          ask_side: askSideOf(r, ns),
        };
      });
      const { data: inqId, error } = await supabase.rpc('send_overtime_clock_inquiry', {
        p_user_id: targetId, p_days: payload, p_message: message.trim() || null,
      });
      if (error) { setErr('送信に失敗しました：' + error.message); setSending(false); setConfirming(false); return; }

      // メール（ベル・プッシュは RPC 側で作成済み）
      const email = await getUserEmail(targetId);
      if (email) {
        const label = `${md(payload[0].work_date)}${payload.length > 1 ? ` 他${payload.length - 1}日` : ''}`;
        await dispatchEmail('overtime:clock_inquiry', {
          対象者名: names[targetId] ?? '',
          日付: label,
          リンク: `${window.location.origin}/overtime?inquiry=${inqId}`,
        }, { applicant: email }).then(null, () => {});
      }

      // ［この日をもう一度聞く］から送った日は、前の確認を「このまま（もう一度聞いた）」にする
      const sentDates = new Set(payload.map(p => p.work_date));
      for (const r of reask.filter(x => x.userId === targetId && sentDates.has(x.workDate))) {
        const { error: kErr } = await supabase.rpc('resolve_clock_inquiry_day', {
          p_day_id: r.dayId, p_kind: 'kept', p_note: `もう一度聞きました（${md(todayJstStr())} に送信）`,
        });
        if (kErr) console.error('[打刻の確認] 前の確認を「このまま」にできませんでした', kErr.message);
      }
      setReask([]);
      setMsg(`${names[targetId] ?? ''}さんに${payload.length}日ぶんの確認を送りました`);
      // 送った一言を「よく使う履歴」の先頭に反映（次回すぐ押せるように）
      const sent = message.trim();
      if (sent) setPastMessages(prev => [sent, ...prev.filter(m => m !== sent)].slice(0, 10));
      setRows([]); setMessage(''); setConfirming(false);
      loadInquiries();
      setTimeout(() => setMsg(''), 4000);
    } finally {
      setSending(false);
    }
  };

  const doWithdraw = async (id: string) => {
    const { error } = await supabase.rpc('withdraw_overtime_clock_inquiry', { p_inquiry_id: id });
    setWithdrawTarget(null);
    if (error) { setErr('取り下げに失敗しました：' + error.message); return; }
    loadInquiries();
  };

  // ── 段階2：答えのカードでの対応 ──
  const closeOp = () => { setOp(null); setEditDraft(null); setKeepNote(''); setOpErr(null); };

  /** 申請の今の中身を、［📋修正］と同じ形で読む */
  const loadRecord = async (id: string, applicantId: string): Promise<OvertimeRecord | string> => {
    const { data, error } = await supabase.from('overtime_reports')
      .select('*, segments:overtime_report_segments(phase, seg_no, start_min, end_min)').eq('id', id).maybeSingle();
    if (error) return '申請を読み込めませんでした：' + error.message;
    if (!data) return 'この日の申請が見つかりません（取り消された可能性があります）';
    return { ...(data as OvertimeRecord), applicantName: names[applicantId] ?? '' };
  };

  /** ［この時刻で申請を直す］→ カードの中に「前→後」を出す */
  const startEdit = async (i: InquiryRow, d: InquiryDay, reportId: string) => {
    closeOp(); setOpBusy(true);
    const rec = await loadRecord(reportId, i.user_id);
    setOpBusy(false);
    if (typeof rec === 'string') { setOpErr({ dayId: d.id, msg: rec }); return; }
    if (!['reported', 'confirmed'].includes((rec as OvertimeRecord & { status: string }).status)) {
      setOpErr({ dayId: d.id, msg: 'この申請はいま直せる状態ではありません（実績報告のあとに直せます）' }); return;
    }
    const segs: WorkSegment[] = (d.answer_segments ?? []).map(x => ({ startMin: x.start_min, endMin: x.end_min }));
    // 休憩を手で直してある申請は、その分数のまま（自動の休憩なら新しい時間で計算し直す）
    const fig = editFigures(segs, rec.break_manual, rec.break_minutes ?? 0, rec.normal_shift?.labor_minutes ?? 0);
    const { changes, summary } = editChanges(rec, {
      workDate: rec.work_date, segs, breakMin: fig.breakMin, diffMin: fig.diffMin, location: rec.location ?? '', reason: rec.reason ?? '',
    });
    if (Object.keys(changes).length === 0) { setOpErr({ dayId: d.id, msg: '申請はすでにこの時間になっています。［直さずに終える］を使ってください' }); return; }
    setEditDraft({ dayId: d.id, record: rec, segs, fig, changes, summary });
  };

  const doEdit = async () => {
    if (!editDraft) return;
    const { record: rec, segs, fig, changes, summary, dayId } = editDraft;
    setOpBusy(true); setOpErr(null);
    const res = await saveAdminOvertimeEdit({
      record: rec, workDate: rec.work_date, segs,
      breakManual: rec.break_manual, breakMin: fig.breakMin, laborMin: fig.laborMin, diffMin: fig.diffMin, legalOk: fig.legalOk,
      reason: rec.reason ?? '', location: rec.location ?? '', changes, summary,
      changeReason: `打刻の確認のお答えのとおり、${segsLabel(segs)} に直しました`,
      clockInquiryDayId: dayId,
    });
    setOpBusy(false);
    if (res.error) { setOpErr({ dayId, msg: res.error }); return; }
    closeOp();
    afterOp(`${rec.applicantName ?? ''}さんの ${md(rec.work_date)} の申請を ${segsLabel(segs)} に直しました`,
      [res.resolveError, res.gcalFailed ? '申請は直しましたが、Googleカレンダーへの反映に失敗しました。時間をおいて［📋修正］から保存し直してください。' : '']);
  };

  /** ［取り消して定時にする］（確認のあと） */
  const doCancel = async (i: InquiryRow, d: InquiryDay, reportId: string) => {
    setOpBusy(true); setOpErr(null);
    const { error } = await supabase.rpc('resolve_clock_inquiry_cancel', { p_day_id: d.id, p_note: null });
    if (error) { setOpBusy(false); setOpErr({ dayId: d.id, msg: '取り消せませんでした：' + error.message.replace(/^CLOCK_INQ_[A-Z_]+: ?/, '') }); return; }
    await notifyOvertimeAdminCancelled({
      reportId, applicantId: i.user_id,
      dateLabel: `${d.work_date}（打刻の確認のお答えにより、定時（打刻ズレ）の記録にしました）`,
    }).then(null, () => {});
    const { data: syncRes, error: syncErr } = await supabase.functions.invoke('gcal-sync', {
      body: { action: 'sync', source_type: 'overtime', source_id: reportId },
    });
    setOpBusy(false);
    closeOp();
    afterOp(`${names[i.user_id] ?? ''}さんの ${md(d.work_date)} の申請を取り消し、定時の記録にしました`,
      [syncErr || (syncRes as { success?: boolean } | null)?.success === false ? '取り消しましたが、Googleカレンダーから消せませんでした。管理者にご連絡ください。' : '']);
    loadClockRows();
  };

  /** ［直さずに終える］ */
  const doKeep = async (d: InquiryDay) => {
    if (!keepNote.trim()) { setOpErr({ dayId: d.id, msg: '理由を入れてください' }); return; }
    setOpBusy(true); setOpErr(null);
    const { error } = await supabase.rpc('resolve_clock_inquiry_day', { p_day_id: d.id, p_kind: 'kept', p_note: keepNote.trim() });
    setOpBusy(false);
    if (error) { setOpErr({ dayId: d.id, msg: '終えられませんでした：' + error.message.replace(/^CLOCK_INQ_[A-Z_]+: ?/, '') }); return; }
    closeOp();
    afterOp(`${md(d.work_date)} を直さずに終えました`, []);
  };

  /** ［この日をもう一度聞く］：上の送る欄にその人・その日・打刻を入れる（送るのは経理が押したとき） */
  const startReask = (i: InquiryRow, d: InquiryDay) => {
    closeOp();
    setTargetId(i.user_id);
    setRows([{ work_date: d.work_date, clock_in: d.clock_in ? d.clock_in.slice(0, 5) : '', clock_out: d.clock_out ? d.clock_out.slice(0, 5) : '', ask_side: d.ask_side ?? null,
      two: !!(d.clock_in2 || d.clock_out2), clock_in2: d.clock_in2 ? d.clock_in2.slice(0, 5) : '', clock_out2: d.clock_out2 ? d.clock_out2.slice(0, 5) : '' }]);
    setReask([{ dayId: d.id, userId: i.user_id, workDate: d.work_date }]);
    setConfirming(false); setErr('');
    sendRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /** 対応のあと：緑の知らせ・失敗した部分は赤・一覧を読み直す */
  const afterOp = (done: string, warnings: (string | undefined)[]) => {
    const w = warnings.filter(Boolean).join(' ');
    if (w) setErr(w);
    setMsg(done);
    setTimeout(() => setMsg(''), 4000);
    loadInquiries();
  };

  const toggleChecked = async (r: ClockOnlyRow) => {
    const next = r.accounting_checked_at ? null : new Date().toISOString();
    const { data: auth } = await supabase.auth.getUser();
    const { error } = await supabase.from('overtime_reports')
      .update({ accounting_checked_at: next, accounting_checked_by: next ? (auth.user?.id ?? null) : null })
      .eq('id', r.id).select('id');
    if (error) { setErr('更新に失敗しました：' + error.message); return; }
    loadClockRows();
  };

  const label = (s: string) => <span style={{ fontSize: 12, color: subText }}>{s}</span>;

  return (
    <div>
      {msg && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: '12px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 15, flexShrink: 0 }}>✓</div>
          <span style={{ fontSize: 14, fontWeight: 'bold', color: '#166534' }}>{msg}</span>
        </div>
      )}
      {err && (
        <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: '#842029' }}>{err}</p>
        </div>
      )}

      {/* ① 確認を送る */}
      <div ref={sendRef} style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: 14, marginBottom: 16 }}>
        {reask.length > 0 && reask[0].userId === targetId && (
          <div style={{ background: isDark ? '#3a2e10' : '#fff8e1', border: `1px solid ${isDark ? '#8a6d1f' : '#ffe08a'}`, borderRadius: 8, padding: '8px 10px', marginBottom: 10, fontSize: 12.5, color: text, lineHeight: 1.7 }}>
            {md(reask[0].workDate)} をもう一度聞きます。打刻を確かめて、ひとことを入れて送ってください。<br />
            <span style={{ color: subText }}>送ると、前の確認は「このまま（もう一度聞いた）」になります</span>
            <button type="button" onClick={() => { setReask([]); setRows([]); }}
              style={{ marginLeft: 8, background: 'none', border: 'none', color: isDark ? '#8ec5f0' : '#1565c0', textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }}>やめる</button>
          </div>
        )}
        <h4 style={{ margin: '0 0 10px', fontSize: 14, color: text }}>打刻の確認を送る</h4>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: subText, lineHeight: 1.7 }}>
          通常シフトは自動で出ます。<b>打刻だけ</b>入力してください。<br />
          送ると、その日は締め切り後でも本人が報告できるようになります。
        </p>

        <div style={{ marginBottom: 10 }}>
          {label('対象者')}
          <SearchableSelect
            value={targetId || 'all'}
            onChange={v => setTargetId(v === 'all' ? '' : v)}
            options={staff.map(s => [s.id, `${s.name}${s.role_title ? `（${s.role_title}）` : ''}`] as [string, string])}
            allLabel="選んでください"
            isDarkMode={isDark}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginBottom: 12 }}>
          <div>
            {label('対象日')}
            <input type="date" value={newDate} max={todayJstStr()} onChange={e => setNewDate(e.target.value)} style={inputStyle} />
          </div>
          <button onClick={addDate} disabled={!newDate || !targetId}
            style={{ padding: '7px 14px', borderRadius: 6, border: `1px solid ${border}`, background: innerBg, color: text, cursor: 'pointer', fontSize: 12.5 }}>
            ＋ この日を追加
          </button>
        </div>

        {dayStateErr && (
          <p style={{ margin: '0 0 8px', fontSize: 12.5, color: '#842029' }}>その日の申請を読み込めませんでした（{dayStateErr}）</p>
        )}
        {rows.length > 0 && (
          <div style={{ overflowX: 'auto', marginBottom: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: innerBg }}>
                  <th style={{ padding: '6px 8px', textAlign: 'left', color: subText, whiteSpace: 'nowrap' }}>日付</th>
                  <th style={{ padding: '6px 8px', textAlign: 'left', color: subText, whiteSpace: 'nowrap' }}>通常シフト</th>
                  <th style={{ padding: '6px 8px', textAlign: 'left', color: subText, whiteSpace: 'nowrap' }}>出勤打刻</th>
                  <th style={{ padding: '6px 8px', textAlign: 'left', color: subText, whiteSpace: 'nowrap' }}>退勤打刻</th>
                  <th style={{ padding: '6px 8px' }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const ns = resolveNormalShift(patterns, r.work_date, calendarKinds[r.work_date] ?? null);
                  const nsBands = normalShiftBands(ns);
                  const st = dayStates[r.work_date];
                  const stText = st?.report_id
                    ? `申請あり：${reportKindText(st)}${st.segments && st.segments.length > 0 ? ` ${segmentsText(st.segments)}` : ''}（${signedText(st.diff_minutes)}）・${st.status && STATUS_INFO[st.status as OvertimeStatus] ? STATUS_INFO[st.status as OvertimeStatus].label : ''}`
                    : '';
                  return (
                    <tr key={r.work_date} style={{ borderBottom: `1px solid ${border}` }}>
                      <td style={{ padding: '6px 8px', color: text, whiteSpace: 'nowrap' }}>{md(r.work_date)}（{dowOf(r.work_date)}）</td>
                      <td style={{ padding: '6px 8px', color: subText, whiteSpace: 'nowrap' }}>
                        {/* 列は nowrap なので、時間帯が2本ある日は横に伸ばさず改行する */}
                        {nsBands.length === 0 ? '—'
                          : nsBands.map((b, bi) => (
                            <React.Fragment key={bi}>{bi > 0 && <br />}{b.start}〜{b.end}</React.Fragment>
                          ))}
                        {stText && (
                          <div style={{ marginTop: 3 }}>
                            <span style={{ display: 'inline-block', fontSize: 11.5, fontWeight: 'bold', borderRadius: 4, padding: '1px 6px', background: '#e6f1fb', color: '#0c447c', whiteSpace: 'normal' }}>{stText}</span>
                          </div>
                        )}
                        {st?.state === 'leave' && (
                          <div style={{ marginTop: 3, fontSize: 11.5, color: '#b45309' }}>⚠️ この日は休暇の日です</div>
                        )}
                        {isEarlyClockIn(normalShiftEdges(ns)?.start, r.clock_in) && (() => {
                          const side = askSideOf(r, ns);
                          return (
                            <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', whiteSpace: 'normal' }}>
                              <span style={{ fontSize: 11.5, color: text }}>聞くこと</span>
                              {(['after', 'before', 'both'] as const).map(k => (
                                <button key={k} type="button" onClick={() => setRows(prev => prev.map((p, j) => j === i ? { ...p, ask_side: k } : p))}
                                  style={{ padding: '2px 10px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 11.5,
                                    background: side === k ? '#1976d2' : (isDark ? '#495057' : '#e9ecef'),
                                    color: side === k ? '#fff' : text, fontWeight: side === k ? 'bold' : 'normal' }}>
                                  {ASK_SIDE_LABEL[k]}
                                </button>
                              ))}
                            </div>
                          );
                        })()}
                        {dayCheckAt[r.work_date] && (
                          <div style={{ marginTop: 3, fontSize: 11.5, color: text }}>
                            本人の記録：<b>定時</b>（{new Date(dayCheckAt[r.work_date]).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })} に記録）
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <input type="time" value={r.clock_in}
                          onChange={e => setRows(prev => prev.map((p, j) => j === i ? { ...p, clock_in: e.target.value } : p))}
                          style={{ ...inputStyle, width: 110 }} />
                        {r.two && (
                          <input type="time" value={r.clock_in2} aria-label="2組目の出勤打刻"
                            onChange={e => setRows(prev => prev.map((p, j) => j === i ? { ...p, clock_in2: e.target.value } : p))}
                            style={{ ...inputStyle, width: 110, marginTop: 4, display: 'block' }} />
                        )}
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <input type="time" value={r.clock_out}
                          onChange={e => setRows(prev => prev.map((p, j) => j === i ? { ...p, clock_out: e.target.value } : p))}
                          style={{ ...inputStyle, width: 110 }} />
                        {r.two && (
                          <input type="time" value={r.clock_out2} aria-label="2組目の退勤打刻"
                            onChange={e => setRows(prev => prev.map((p, j) => j === i ? { ...p, clock_out2: e.target.value } : p))}
                            style={{ ...inputStyle, width: 110, marginTop: 4, display: 'block' }} />
                        )}
                        {/* 打刻を2組（外出・戻りなど・2026-10-13 経理担当の意見） */}
                        <button type="button"
                          onClick={() => setRows(prev => prev.map((p, j) => j === i ? (p.two ? { ...p, two: false, clock_in2: '', clock_out2: '' } : { ...p, two: true }) : p))}
                          style={{ display: 'block', marginTop: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11.5, color: r.two ? subText : (isDark ? '#8ec5f0' : '#1565c0'), textDecoration: 'underline', whiteSpace: 'nowrap' }}>
                          {r.two ? '2組目を外す ✕' : '＋ 打刻を追加（外出・戻りなど）'}
                        </button>
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                        {/* ✕ を使う（🚫 は環境によって□に化ける） */}
                        <button onClick={() => setRows(prev => prev.filter((_, j) => j !== i))}
                          title="この日を外す"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, color: subText }} aria-label="この日を外す">✕</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          {label('一言（任意）')}
          <input value={message} onChange={e => setMessage(e.target.value)}
            placeholder={`例：${MESSAGE_EXAMPLES[0]}`}
            style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} />

          {/* 文例ボタン（押すと入る） */}
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {MESSAGE_EXAMPLES.map(ex => (
              <button key={ex} type="button" onClick={() => setMessage(ex)}
                style={{ padding: '5px 12px', borderRadius: 6, border: `1px solid ${isDark ? '#3d5166' : '#90caf9'}`, background: isDark ? '#2c3e50' : '#e8f4fd', color: isDark ? '#fff' : '#1565c0', fontSize: 11.5, fontWeight: 'bold', cursor: 'pointer' }}>
                文例 ー「{ex}」
              </button>
            ))}
          </div>

          {/* よく使う履歴（過去に自分が送った一言・押すと入力・✕でこの端末から消す） */}
          {visiblePastMessages.length > 0 && (
            <div style={{ background: isDark ? '#243447' : '#e8f4fd', border: `1px solid ${isDark ? '#3d5166' : '#90caf9'}`, borderRadius: 8, padding: '8px 10px', marginTop: 8 }}>
              <div style={{ fontSize: 11.5, fontWeight: 'bold', color: isDark ? '#fff' : '#1565c0', marginBottom: 6 }}>よく使う一言</div>
              {(showAllMessages ? visiblePastMessages : visiblePastMessages.slice(0, 3)).map((m, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', background: isDark ? '#2c3e50' : '#fff', border: `1px solid ${isDark ? '#3d5166' : '#bbdefb'}`, borderRadius: 5, marginBottom: 5 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: isDark ? '#fff' : '#333' }}>{m}</span>
                  <button type="button" onClick={() => setMessage(m)}
                    style={{ flexShrink: 0, background: '#1976d2', color: '#fff', fontSize: 11, fontWeight: 'bold', padding: '4px 12px', border: 'none', borderRadius: 4, cursor: 'pointer' }}>入力</button>
                  <button type="button" onClick={() => hideMessage(m)} title="この候補を消す"
                    style={{ flexShrink: 0, background: 'none', border: 'none', color: isDark ? '#adb5bd' : '#90a4ae', fontSize: 14, lineHeight: 1, padding: '2px 4px', cursor: 'pointer' }}>✕</button>
                </div>
              ))}
              {visiblePastMessages.length > 3 && (
                <button type="button" onClick={() => setShowAllMessages(v => !v)}
                  style={{ width: '100%', padding: '4px', background: 'none', border: `1px dashed ${isDark ? '#5a6b7d' : '#90caf9'}`, borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold', color: isDark ? '#e9ecef' : '#1565c0', marginTop: 2 }}>
                  {showAllMessages ? '▲ 閉じる' : `▼ もっと見る（あと${visiblePastMessages.length - 3}件）`}
                </button>
              )}
            </div>
          )}
        </div>

        {!confirming ? (
          <button onClick={() => { const v = validate(); if (v) { setErr(v); return; } setErr(''); setConfirming(true); }}
            style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: '#0d6efd', color: '#fff', cursor: 'pointer', fontSize: 13.5, fontWeight: 'bold' }}>
            内容を確認して送る
          </button>
        ) : (
          <div style={{ background: innerBg, borderRadius: 8, padding: '10px 12px' }}>
            <p style={{ margin: '0 0 8px', fontSize: 13, color: text }}>
              <b>{names[targetId] ?? ''}</b>さんに{sendable.length}日ぶんの確認を送ります。<br />
              <span style={{ fontSize: 12, color: subText }}>本人にベル・プッシュ・メールが届きます</span>
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={doSend} disabled={sending}
                style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#0d6efd', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 'bold' }}>
                {sending ? '送信中...' : '送る'}
              </button>
              <button onClick={() => setConfirming(false)}
                style={{ padding: '8px 16px', borderRadius: 8, border: `1px solid ${border}`, background: 'transparent', color: text, cursor: 'pointer', fontSize: 13 }}>
                キャンセル
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ② 送信した確認（2026-10-13：日ごとのカード＋札。「対応待ちだけ」で絞れる） */}
      <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: 14, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <h4 style={{ margin: 0, fontSize: 14, color: text }}>送信した確認</h4>
          {([['all', 'すべて'], ['action', '対応待ちだけ']] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setOnlyAction(k === 'action')}
              style={{ padding: '3px 12px', borderRadius: 14, border: 'none', cursor: 'pointer', fontSize: 12,
                background: onlyAction === (k === 'action') ? '#1976d2' : (isDark ? '#495057' : '#e9ecef'),
                color: onlyAction === (k === 'action') ? '#fff' : text, fontWeight: onlyAction === (k === 'action') ? 'bold' : 'normal' }}>
              {l}
            </button>
          ))}
        </div>
        {inquiries.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: subText }}>まだありません</p>
        ) : inquiries.filter(i => !onlyAction || (i.days ?? []).some(d => followUpOf(d, d.existing_report_id ? reportBriefs[d.existing_report_id]?.status : null).kind === 'action')).map(i => (
          <div key={i.id} style={{ borderBottom: `1px solid ${border}`, padding: '10px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 'bold', color: text }}>{names[i.user_id] ?? ''}</span>
              <span style={{
                fontSize: 11, fontWeight: 'bold', padding: '2px 8px', borderRadius: 10,
                background: i.status === 'open' ? '#fff3cd' : i.status === 'answered' ? '#d1e7dd' : '#e9ecef',
                color: i.status === 'open' ? '#664d03' : i.status === 'answered' ? '#0f5132' : '#495057',
              }}>
                {i.status === 'open' ? '未回答' : i.status === 'answered' ? '回答済み' : '取り下げ'}
              </span>
              <span style={{ fontSize: 11.5, color: subText }}>{i.created_at.slice(0, 10).replace(/-/g, '/')} 送信</span>
              {(() => {
                const n = (i.days ?? []).filter(d => followUpOf(d, d.existing_report_id ? reportBriefs[d.existing_report_id]?.status : null).kind === 'action').length;
                return n > 0 ? <span style={{ fontSize: 11, fontWeight: 'bold', padding: '2px 8px', borderRadius: 10, background: '#b45309', color: '#fff' }}>対応待ち {n}日</span> : null;
              })()}
              {i.status === 'open' && (
                <button onClick={() => setWithdrawTarget(i.id)}
                  style={{ marginLeft: 'auto', background: 'none', border: `1px solid ${border}`, borderRadius: 6, cursor: 'pointer', padding: '3px 10px', fontSize: 11.5, color: subText }}>
                  取り下げる
                </button>
              )}
            </div>
            {/* 自分が送った一言（何件も送ると、何を聞いたか分からなくなるため・2026-10-13 経理担当の意見） */}
            {i.message && (
              <div style={{ marginTop: 6, padding: '6px 10px', borderRadius: 6, background: innerBg, border: `1px solid ${border}`, fontSize: 12.5, color: text, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                <span style={{ color: subText }}>送った一言：</span>{i.message}
              </div>
            )}
            {withdrawTarget === i.id && (
              <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '8px 12px', margin: '8px 0' }}>
                <p style={{ margin: '0 0 8px', fontSize: 12.5, color: '#842029' }}>この確認を取り下げます（本人には出なくなります）</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => doWithdraw(i.id)} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#dc3545', color: '#fff', cursor: 'pointer', fontSize: 12.5 }}>取り下げる</button>
                  <button onClick={() => setWithdrawTarget(null)} style={{ padding: '6px 14px', borderRadius: 6, border: `1px solid ${border}`, background: 'transparent', color: text, cursor: 'pointer', fontSize: 12.5 }}>キャンセル</button>
                </div>
              </div>
            )}
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(i.days ?? []).map(d => {
                const rb = d.existing_report_id ? reportBriefs[d.existing_report_id] : (d.result_report_id ? reportBriefs[d.result_report_id] : undefined);
                const fu = followUpOf(d, rb?.status ?? null);
                const rbSegs = rb?.segments
                  ? rb.segments.filter(x => x.phase === (rb.segments!.some(y => y.phase === 'actual') ? 'actual' : 'planned')).sort((a, b) => a.start_min - b.start_min)
                  : null;
                const rbStatus = rb?.status && STATUS_INFO[rb.status as OvertimeStatus] ? STATUS_INFO[rb.status as OvertimeStatus].label : '';
                const ansSegs = d.answer_segments ?? null;
                const ansDiff = ansSegs ? diffFromShift(ansSegs.map(x => ({ startMin: x.start_min, endMin: x.end_min })), rb?.normal_shift?.labor_minutes ?? null) : null;
                const tag = fu.kind === 'action' ? { bg: '#b45309', fg: '#fff' } : fu.kind === 'done' ? { bg: isDark ? '#1b3a1e' : '#e8f5e9', fg: isDark ? '#a5d6a7' : '#1b5e20' } : { bg: isDark ? '#495057' : '#e9ecef', fg: text };
                const rowLabel: React.CSSProperties = { color: subText, width: 104, flexShrink: 0 };
                return (
                  <div key={d.id} style={{ border: `${fu.kind === 'action' ? 2 : 1}px solid ${fu.kind === 'action' ? '#b45309' : border}`, borderRadius: 8, padding: '8px 10px', fontSize: 12.5, color: text }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <b>{md(d.work_date)}（{dowOf(d.work_date)}）</b>
                      <span style={{ fontSize: 11, fontWeight: 'bold', padding: '1px 7px', borderRadius: 4, background: tag.bg, color: tag.fg }}>{fu.label}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 4 }}><span style={rowLabel}>シフト</span><span>{normalShiftTimeText({ start_time: d.shift_start, end_time: d.shift_end, start_time2: d.shift_start2, end_time2: d.shift_end2 }) || '—'}</span></div>
                    {rb && (
                      <div style={{ display: 'flex', gap: 6 }}><span style={rowLabel}>申請</span>
                        <span>{reportKindText({ application_types: rb.application_types, is_post_hoc: rb.is_post_hoc, furikae_origin: !!rb.furikae_origin_date && rb.work_date !== d.work_date })}{rbSegs && rbSegs.length > 0 ? ` ${segmentsText(rbSegs)}` : ''}（{signedText(rb.diff_minutes)}）・{rbStatus}</span></div>
                    )}
                    <div style={{ display: 'flex', gap: 6 }}><span style={rowLabel}>本人の答え</span>
                      <span style={{ fontWeight: d.answer === 'pending' ? 'normal' : 'bold', color: d.answer === 'pending' ? subText : text }}>
                        {answerLabel(d.answer, d.report_state, d.ask_side ?? 'after')}{d.answer_reason ? `（${d.answer_reason}）` : ''}
                      </span></div>
                    {ansSegs && (
                      <div style={{ display: 'flex', gap: 6 }}><span style={rowLabel}>本人が入れた<br />正しい時間</span>
                        <span style={{ fontWeight: 'bold', color: isDark ? '#8ec5f0' : '#0c447c' }}>{segmentsText(ansSegs)}（{signedText(ansDiff)}）</span></div>
                    )}
                    <div style={{ display: 'flex', gap: 6 }}><span style={rowLabel}>打刻</span><span>{clockText(d)}{d.ask_side && d.ask_side !== 'after' ? `（聞いたこと：${ASK_SIDE_LABEL[d.ask_side]}）` : ''}</span></div>
                    {d.answer_note && <div style={{ display: 'flex', gap: 6 }}><span style={rowLabel}>ひとこと</span><span>{d.answer_note}</span></div>}
                    {d.answer === 'not_worked' && !d.result_report_id && <div style={{ color: '#b45309', marginTop: 2 }}>※ 打刻ズレの記録が未作成です（本人の画面で作れなかった）</div>}
                    {d.resolved_kind && (
                      <div style={{ marginTop: 6, padding: '5px 8px', borderRadius: 6, background: isDark ? '#1b3a1e' : '#e8f5e9', color: isDark ? '#a5d6a7' : '#1b5e20', lineHeight: 1.6 }}>
                        {d.resolved_at ? md(d.resolved_at.slice(0, 10)) + ' ' : ''}{d.resolved_by ? `${names[d.resolved_by] ?? '経理'}が` : ''}
                        {d.resolved_kind === 'edited' ? `申請を ${d.resolved_note ?? ''} に直しました`
                          : d.resolved_kind === 'cancelled' ? '申請を取り消し、定時の記録にしました'
                          : `直さずに終えました${d.resolved_note ? `（${d.resolved_note}）` : ''}`}
                      </div>
                    )}
                    {fu.kind === 'action' && (() => {
                      const repId = d.existing_report_id ?? d.result_report_id;
                      const canFix = !!rb && !!repId && (rb.status === 'reported' || rb.status === 'confirmed');
                      const hasAns = !!ansSegs && ansSegs.length > 0;
                      // 本人の正しい時間が残業なし（±0:00）で、残業・早出だけの申請 → 定時にする
                      const toTeiji = canFix && hasAns && d.answer === 'time_differs' && ansDiff === 0
                        && onlyOvertimeTypes(rb!.application_types) && rb!.work_date === d.work_date && !rb!.furikae_origin_date;
                      const small: React.CSSProperties = { fontSize: 12.5, padding: '6px 12px', borderRadius: 8 };
                      const isEditing = editDraft?.dayId === d.id;
                      return (
                        <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px dashed ${border}` }}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                            {canFix && hasAns && d.answer === 'time_differs' && !toTeiji && (
                              <button type="button" disabled={opBusy} onClick={() => startEdit(i, d, repId!)} style={{ ...primaryBtn({ disabled: opBusy }), ...small }}>この時刻で申請を直す</button>
                            )}
                            {toTeiji && (
                              <button type="button" disabled={opBusy} onClick={() => { closeOp(); setOp({ dayId: d.id, kind: 'cancel' }); }} style={{ ...primaryBtn({ danger: true, disabled: opBusy }), ...small }}>取り消して定時にする</button>
                            )}
                            <button type="button" disabled={opBusy} onClick={() => { closeOp(); setOp({ dayId: d.id, kind: 'keep' }); }} style={{ ...backBtn(isDark), ...small }}>直さずに終える</button>
                            <button type="button" disabled={opBusy} onClick={() => startReask(i, d)} style={{ ...tintBtn(isDark), ...small }}>この日をもう一度聞く</button>
                            {canFix && (d.answer !== 'time_differs' || toTeiji || !hasAns) && (
                              <button type="button" disabled={opBusy} onClick={async () => {
                                closeOp(); setOpBusy(true);
                                const rec = await loadRecord(repId!, i.user_id);
                                setOpBusy(false);
                                if (typeof rec === 'string') { setOpErr({ dayId: d.id, msg: rec }); return; }
                                setModal({ record: rec, clockInquiry: { dayId: d.id, segments: d.answer_segments, note: d.answer_note } });
                              }} style={{ background: 'none', border: 'none', color: isDark ? '#8ec5f0' : '#1565c0', textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }}>申請を直す →</button>
                            )}
                          </div>
                          {isEditing && editDraft && (
                            <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: isDark ? '#1e3a5f' : '#e7f1ff', border: `1px solid ${isDark ? '#4a90d9' : '#9ec5fe'}`, lineHeight: 1.8 }}>
                              申請の時間を直します<br />
                              前：{segsLabel(currentSegsOf(editDraft.record))}（{signedText(editDraft.record.diff_minutes)}）<br />
                              後：<b>{segsLabel(editDraft.segs)}（{signedText(editDraft.fig.diffMin)}）</b><br />
                              {editDraft.record.break_manual && <span style={{ color: subText }}>休憩は手で直した {editDraft.fig.breakMin}分 のままです<br /></span>}
                              {!editDraft.fig.legalOk && <span style={{ color: '#dc3545' }}>⚠️ 休憩が法定の基準に足りません<br /></span>}
                              <span style={{ color: subText }}>本人にお知らせが届きます。前の時刻は履歴に残ります。</span>
                              <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                                <button type="button" disabled={opBusy} onClick={closeOp} style={{ ...backBtn(isDark), ...small }}>やめる</button>
                                <button type="button" disabled={opBusy} onClick={doEdit} style={{ ...primaryBtn({ disabled: opBusy }), ...small }}>{opBusy ? '直しています…' : '直す'}</button>
                                <button type="button" disabled={opBusy} onClick={() => { const rec = editDraft.record; closeOp(); setModal({ record: rec, clockInquiry: { dayId: d.id, segments: d.answer_segments, note: d.answer_note } }); }}
                                  style={{ background: 'none', border: 'none', color: isDark ? '#8ec5f0' : '#1565c0', textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }}>休憩なども直す →</button>
                              </div>
                            </div>
                          )}
                          {op?.dayId === d.id && op.kind === 'cancel' && (
                            <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: isDark ? '#3a1414' : '#f8d7da', border: '1px solid #f5c2c7', color: isDark ? '#fca5a5' : '#842029', lineHeight: 1.7 }}>
                              この申請（{rbSegs && rbSegs.length > 0 ? segmentsText(rbSegs) : ''}）を取り消し、「定時（打刻ズレ）」の記録に置き替えます。<br />
                              本人にお知らせが届きます。前の申請は履歴に残ります。
                              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                                <button type="button" disabled={opBusy} onClick={closeOp} style={{ ...backBtn(isDark), ...small, background: isDark ? 'transparent' : '#fff' }}>やめる</button>
                                <button type="button" disabled={opBusy} onClick={() => doCancel(i, d, repId!)} style={{ ...primaryBtn({ danger: true, disabled: opBusy }), ...small }}>{opBusy ? '取り消しています…' : '取り消して定時にする'}</button>
                              </div>
                            </div>
                          )}
                          {op?.dayId === d.id && op.kind === 'keep' && (
                            <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: innerBg, border: `1px solid ${border}` }}>
                              <div style={{ marginBottom: 4 }}>直さずに終える理由</div>
                              <input value={keepNote} onChange={e => setKeepNote(e.target.value)} placeholder="例：申請の通りで問題なし"
                                style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} />
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
                                {KEEP_NOTE_EXAMPLES.map(ex => (
                                  <button key={ex} type="button" onClick={() => setKeepNote(ex)}
                                    style={{ padding: '2px 10px', borderRadius: 12, border: `1px solid ${border}`, background: 'transparent', color: text, fontSize: 11.5, cursor: 'pointer' }}>{ex}</button>
                                ))}
                              </div>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button type="button" disabled={opBusy} onClick={closeOp} style={{ ...backBtn(isDark), ...small }}>やめる</button>
                                <button type="button" disabled={opBusy} onClick={() => doKeep(d)} style={{ ...primaryBtn({ disabled: opBusy }), ...small }}>{opBusy ? '保存しています…' : '終える'}</button>
                              </div>
                            </div>
                          )}
                          {opErr?.dayId === d.id && (
                            <div style={{ marginTop: 6, color: isDark ? '#fca5a5' : '#842029' }}>{opErr.msg}</div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* ③ 打刻ズレの記録（経理の突き合わせ） */}
      <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: 14 }}>
        <h4 style={{ margin: '0 0 6px', fontSize: 14, color: text }}>打刻ズレの記録（残業なし）</h4>
        <p style={{ margin: '0 0 10px', fontSize: 12, color: subText, lineHeight: 1.7 }}>
          突き合わせが済んだら「確認済み」にしてください（チェックを外すと未確認に戻ります）。<b>確認済みにすると本人は取り消せなくなります</b>。<br />
          打刻の確認への答え（業務はしていません）でできた記録は、経理が聞いて答えが返ってきたものなので、自動で確認済みになります。
        </p>
        {(() => {
          const unchecked = clockRows.filter(r => !r.accounting_checked_at).length;
          const arrow: React.CSSProperties = { background: 'none', border: 'none', fontSize: 18, lineHeight: 1, padding: '2px 8px', cursor: 'pointer', color: text };
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              <button type="button" aria-label="前の給与期間" onClick={() => setClockPeriod(p => shiftPayPeriod(p, -1))} style={arrow}>‹</button>
              <span style={{ fontSize: 12.5, color: text, fontWeight: 'bold' }}>{payPeriodLabel(clockPeriod)}</span>
              <button type="button" aria-label="次の給与期間" onClick={() => setClockPeriod(p => shiftPayPeriod(p, 1))} style={arrow}>›</button>
              {([[false, 'すべて'], [true, '未確認だけ']] as const).map(([v, l]) => (
                <button key={l} type="button" onClick={() => setClockOnlyUnchecked(v)}
                  style={{ padding: '3px 12px', borderRadius: 14, border: 'none', cursor: 'pointer', fontSize: 12,
                    background: clockOnlyUnchecked === v ? '#1976d2' : (isDark ? '#495057' : '#e9ecef'),
                    color: clockOnlyUnchecked === v ? '#fff' : text, fontWeight: clockOnlyUnchecked === v ? 'bold' : 'normal' }}>{l}</button>
              ))}
              <span style={{ fontSize: 12, color: unchecked > 0 ? '#b45309' : subText, fontWeight: unchecked > 0 ? 'bold' : 'normal' }}>
                未確認 {unchecked}件 ／ 全 {clockRows.length}件
              </span>
            </div>
          );
        })()}
        {clockErr && <p style={{ margin: '0 0 8px', fontSize: 12.5, color: '#842029' }}>{clockErr}</p>}
        {clockRows.filter(r => !clockOnlyUnchecked || !r.accounting_checked_at).length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: subText }}>{clockOnlyUnchecked && clockRows.length > 0 ? 'この期間の記録はすべて確認済みです' : 'この期間の記録はありません'}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <tbody>
                {clockRows.filter(r => !clockOnlyUnchecked || !r.accounting_checked_at).map(r => (
                  <tr key={r.id} style={{ borderBottom: `1px solid ${border}` }}>
                    <td style={{ padding: '7px 8px', whiteSpace: 'nowrap' }}>
                      <input type="checkbox" checked={!!r.accounting_checked_at} onChange={() => toggleChecked(r)} />
                    </td>
                    <td style={{ padding: '7px 8px', color: text, whiteSpace: 'nowrap' }}>{md(r.work_date)}（{dowOf(r.work_date)}）</td>
                    <td style={{ padding: '7px 8px', color: text, whiteSpace: 'nowrap' }}>{names[r.applicant_id] ?? ''}</td>
                    <td style={{ padding: '7px 8px', color: subText, whiteSpace: 'nowrap' }}>打刻 {hm(r.clock_in_reported)}〜{hm(r.clock_out_reported)}</td>
                    <td style={{ padding: '7px 8px', color: subText }}>
                      {r.reason ?? ''}
                      {fromInquiryIds.has(r.id) && <span style={{ marginLeft: 6, fontSize: 11, padding: '0 6px', borderRadius: 8, border: `1px solid ${border}`, whiteSpace: 'nowrap' }}>打刻の確認から</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <OvertimeEditModal
          record={modal.record}
          isDarkMode={isDark}
          clockInquiry={modal.clockInquiry}
          onClose={() => setModal(null)}
          onSaved={(warning?: string) => {
            const rec = modal.record;
            setModal(null);
            afterOp(`${rec.applicantName ?? ''}さんの ${md(rec.work_date)} の申請を直しました`, [warning]);
          }}
        />
      )}
    </div>
  );
};

export default OvertimeClockInquiryPanel;
