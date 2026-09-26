// 残業の「表でまとめて入力」（PCだけ・試験中）。計画：docs/計画-残業の表入力.md
//
// 第3段：見るだけ ／ 第4段：入力と行ごとのチェック ／ 🚨 第5段の1つ目（2026-09-24）：**新しく出す日（事前申請・事後報告）だけ送れる**
//   実績報告・再提出の送信は次に足す（既存の申請を書き換えるので分けて出す）。
// 🚨 シフト・会社カレンダー・自分の申請・経理の許可は、ここで給与期間の日付範囲を指定して自分で読む
//    （ページの一覧は100件で打ち切っている。シフトの型は読み込みの失敗を見ていない）。
//    シフト・カレンダー・申請のどれか1つでも読めなければ、はっきりそう出して表を出さない。
// 🚨 行の計算・判定は lib/overtimeGrid の computeGridRow（中身は1件フォームと同じ lib/overtimeSubmit）。
//    ここに条件を書き写さないこと。
// 🚨 実績報告・再提出の行は**触るまで送らない**（何もしないことが送信にならないように）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useScrollIntoViewWhen } from '../hooks/useScrollIntoViewWhen';
import { supabase } from '../lib/supabaseClient';
import {
  calcPayPeriodStartJst, shiftPayPeriod, payMonthPeriodLabel, todayJstStr, advanceRequestMaxDate,
  formatSignedMin, formatMin, minToTime, isPayPeriodClosed,
} from '../lib/breakCalc';
import type { CalendarKind } from '../lib/breakCalc';
import { resolveNormalShift, normalShiftTimeText, reportGateMin } from '../lib/overtimeShift';
import type { PatternRow, NormalShiftSnapshot } from '../lib/overtimeShift';
import {
  periodDates, pickDayReport, classifyGridDay, GRID_KIND_TAG, initialRowDraft, computeGridRow, normalSegsOf,
  locationPick, GRID_SELF_REVIEW, sameGridReport,
} from '../lib/overtimeGrid';
import type { GridReport, GridDayKind, RowDraft, RowState, GridRowCalc } from '../lib/overtimeGrid';
import { STATUS_INFO } from '../lib/overtimeStatus';
import { OT_TYPE_INFO, isOvertimeType } from '../lib/overtimeTypes';
import { CALENDAR_CELL_STYLE } from '../hooks/useCompanyCalendar';
import { DRAFT_KEYS, loadDraft, saveDraft, clearDraft } from '../lib/draftStorage';
import { useRoles } from '../hooks/useRoles';
import { attrsFor } from '../lib/roleAttrs';
import TimeInput from './TimeInput';
import { buildOvertimeRecord, LATE_CHOICES, EARLY_CHOICES } from '../lib/overtimeSubmit';
import { saveOvertimeReport, syncOvertimeGcal } from '../lib/overtimeSubmitApi';
import { notifyOvertimeNewRequestBell, notifyOvertimeNewRequestEmail, sendOvertimeSlackBatch } from '../lib/overtimeNotify';
import { toDbTime } from '../lib/timeInput';
import { segmentsText, type SegmentLike } from '../lib/segmentsText';

interface Reviewer { id: string; name: string; role_title: string }

interface Props {
  userId: string;
  /** ベルの文面に使う申請者名（1件フォームと同じ） */
  profileName: string | null;
  roleTitle: string;
  isAdmin: boolean;
  isDark: boolean;
  /** 申請先の候補（ページが読んだもの＝1件フォームと同じ） */
  reviewers: Reviewer[];
  /** 勤務地の候補（ページが読んだもの＝1件フォームと同じ） */
  workplaces: string[];
  onClose: () => void;
  /** 表で扱わない日を1件フォームで開く */
  onOpenForm: () => void;
}

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const dowOf = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).getDay(); };

/** 種類の札の色。🚨 送る種類は青の系統、差し戻しは赤、送らないものは灰。新しい色は足さない */
const TAG_STYLE: Record<GridDayKind, 'send' | 'muted' | 'warn'> = {
  new_post: 'send', new_advance: 'send', new_today: 'send', report: 'send', resubmit: 'warn',
  beyond_max: 'muted', report_wait: 'muted', form_only: 'muted', done: 'muted', leave_auto: 'muted',
};

type Drafts = Record<string, RowDraft>;

/** 新しく出す日（事前申請・事後報告）の行か */
const isNewGridKind = (k: GridDayKind) => k === 'new_post' || k === 'new_advance' || k === 'new_today';

/** 上長からの「申請の依頼」（残業）。🚨 送ったら依頼を「申請済み」にして結び付ける（1件フォームと同じ・計画 §10-10） */
interface GridRequest {
  id: string;
  requester_id: string;
  requester_name: string | null;
  target_dates: string[] | null;
  memo: string | null;
  segments: SegmentLike[] | null;
}

const OvertimeGrid: React.FC<Props> = ({ userId, profileName, roleTitle, isAdmin, isDark, reviewers, workplaces, onClose, onOpenForm }) => {
  const today = todayJstStr();
  const [period, setPeriod] = useState(() => calcPayPeriodStartJst(today));
  const dates = useMemo(() => periodDates(period), [period]);
  const from = dates[0];
  const to = dates[dates.length - 1];

  const roles = useRoles();
  const canSelfReview = isAdmin || attrsFor(roles, roleTitle).is_manager_plus;

  const [patterns, setPatterns] = useState<PatternRow[] | null>(null);
  const [calendar, setCalendar] = useState<Record<string, CalendarKind> | null>(null);
  const [reports, setReports] = useState<GridReport[] | null>(null);
  const [grants, setGrants] = useState<Set<string>>(new Set());
  const [requests, setRequests] = useState<GridRequest[]>([]);
  const [reqErr, setReqErr] = useState('');
  const [peopleNames, setPeopleNames] = useState<Map<string, string>>(new Map());   // 依頼した人・元の申請先の名前
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const errs: string[] = [];
    const [patRes, calRes, repRes, grantRes, reqRes] = await Promise.all([
      supabase.from('weekly_shift_patterns').select('*').eq('user_id', userId),
      supabase.from('company_calendar').select('date, kind').gte('date', from).lte('date', to),
      supabase.from('overtime_reports')
        .select('id, work_date, status, entry_type, is_post_hoc, application_types, location, diff_minutes, break_minutes, break_manual, reason, return_comment, reviewer_id, normal_shift, show_on_calendar, segments:overtime_report_segments(phase, seg_no, start_min, end_min)')
        .eq('applicant_id', userId).gte('work_date', from).lte('work_date', to),
      supabase.from('overtime_submission_grants').select('work_date').eq('user_id', userId).is('revoked_at', null),
      supabase.from('application_requests').select('id, requester_id, target_dates, memo, segments')
        .eq('recipient_id', userId).eq('kind', 'overtime').eq('status', 'open').order('created_at', { ascending: true }),
    ]);
    // 🚨 1つでも読めなければ null のままにして、表の上に理由を出す（空の配列にしない＝全日「休み」に見えるのを防ぐ）
    if (patRes.error) { errs.push('通常シフト：' + patRes.error.message); setPatterns(null); }
    else setPatterns((patRes.data as PatternRow[] | null) ?? []);
    if (calRes.error) { errs.push('会社カレンダー：' + calRes.error.message); setCalendar(null); }
    else {
      const map: Record<string, CalendarKind> = {};
      ((calRes.data ?? []) as { date: string; kind: CalendarKind }[]).forEach(r => { map[r.date] = r.kind; });
      setCalendar(map);
    }
    if (repRes.error) { errs.push('申請：' + repRes.error.message); setReports(null); }
    else setReports((repRes.data as GridReport[] | null) ?? []);
    // 経理の許可は読めなくても止めない（締め後の日が「送れない」側に倒れるだけ。最終判断は DB のトリガー）
    setGrants(grantRes.error ? new Set() : new Set(((grantRes.data ?? []) as { work_date: string }[]).map(g => g.work_date)));
    // 🚨 依頼は読めなくても表は止めない（送っても依頼と結び付かないだけ）。ただし黙らずに表の上に出す
    // 名前は「依頼した人」と「元の申請の申請先」をまとめて1回で読む。
    // 🚨 申請先の候補（reviewers）に入っていない人がいる（例：管理者）。候補だけで名前を引くと
    //    確認の枠が「（元の申請先）さん宛」になっていた（2026-09-25 実機指摘）
    const rs = reqRes.error ? [] : (reqRes.data ?? []) as Omit<GridRequest, 'requester_name'>[];
    const repRows = repRes.error ? [] : (repRes.data ?? []) as { reviewer_id: string | null }[];
    const ids = [...new Set([...rs.map(q => q.requester_id), ...repRows.map(r => r.reviewer_id ?? '')])].filter(Boolean);
    let nameOf = new Map<string, string>();
    if (ids.length > 0) {
      // 名前が読めなくても表は出す（名前の所だけ空になる）
      const { data: profs } = await supabase.from('profiles').select('id, name').in('id', ids);
      nameOf = new Map(((profs ?? []) as { id: string; name: string }[]).map(p => [p.id, p.name]));
    }
    setPeopleNames(nameOf);
    if (reqRes.error) {
      setRequests([]);
      setReqErr('申請の依頼を読み込めませんでした。この表から送っても、依頼とは結び付きません（' + reqRes.error.message + '）');
    } else {
      setRequests(rs.map(q => ({ ...q, requester_name: nameOf.get(q.requester_id) ?? null })));
      setReqErr('');
    }
    setErrors(errs);
    setLoading(false);
  }, [userId, from, to]);

  useEffect(() => { void load(); }, [load]);

  // いまの時刻（今日の行の判定に使う）。1分ごとに更新
  const [nowMin, setNowMin] = useState(() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); });
  useEffect(() => {
    const t = setInterval(() => { const d = new Date(); setNowMin(d.getHours() * 60 + d.getMinutes()); }, 60_000);
    return () => clearInterval(t);
  }, []);

  // ---- 表の上の申請先（新しく出す日の既定） ----
  const [defaultReviewerId, setDefaultReviewerId] = useState('');

  // ---- 入力（行ごと）。🚨 下書きのキーは「利用者ID＋給与期間」（共用PCで前の人の入力が見えないように） ----
  const draftKey = `${DRAFT_KEYS.overtimeGrid}:${userId}:${period}`;
  const [drafts, setDrafts] = useState<Drafts>({});
  const [draftNote, setDraftNote] = useState('');
  const loadedKeyRef = useRef('');
  const [focusedDate, setFocusedDate] = useState<string | null>(null);
  const [lastBulk, setLastBulk] = useState<string[] | null>(null);
  const [onlyErrors, setOnlyErrors] = useState(false);

  const advanceMaxDate = advanceRequestMaxDate(today);
  const ready = patterns !== null && calendar !== null && reports !== null;

  // 日付 → その日の依頼（同じ日に2件あれば先に来たもの）
  const requestByDate = useMemo(() => {
    const m = new Map<string, GridRequest>();
    requests.forEach(q => (q.target_dates ?? []).forEach(d => { if (!m.has(d)) m.set(d, q); }));
    return m;
  }, [requests]);

  const baseRows = useMemo(() => {
    if (!ready) return [];
    return dates.map(date => {
      const ck = calendar![date] ?? null;
      const resolved: NormalShiftSnapshot = resolveNormalShift(patterns!, date, ck);
      const { main, leaveAuto } = pickDayReport(reports!.filter(r => r.work_date === date));
      const planned = (main?.segments ?? []).filter(s => s.phase === 'planned');
      const kind = classifyGridDay({
        date, today, nowMin, advanceMaxDate, main, leaveAuto,
        gateMin: main ? reportGateMin(main.normal_shift as NormalShiftSnapshot | null, planned) : null,
      });
      // 実績報告・再提出で元の申請がシフトを手直ししていれば、その控えで計算する（1件フォームと同じ）
      const snap = main?.normal_shift as NormalShiftSnapshot | null | undefined;
      const ns = (kind === 'report' || kind === 'resubmit') && snap?.manual_override ? snap : resolved;
      // 依頼は新しく出す日の行にだけ付ける（申請が既にある日は、1件フォームの依頼カードから）
      const req = isNewGridKind(kind) ? (requestByDate.get(date) ?? null) : null;
      // 🚨 依頼がある日の申請先の既定は「依頼した人」（1件フォームと同じ）。表の上の申請先より先に使う
      const rowDefaultReviewer = req?.requester_id || defaultReviewerId;
      return { date, ck, ns, main, leaveAuto, kind, req, rowDefaultReviewer };
    });
  }, [ready, dates, calendar, patterns, reports, today, nowMin, advanceMaxDate, requestByDate, defaultReviewerId]);

  // 下書きを読み込む（期間を変えたとき・読み込みが終わったとき）。
  // 🚨 申請の状態が変わった日（新規だったのに申請ができた／実績報告だったのに済んだ 等）の下書きは捨てて一言知らせる
  useEffect(() => {
    if (!ready || loadedKeyRef.current === draftKey) return;
    loadedKeyRef.current = draftKey;
    const saved = loadDraft<{ drafts: Drafts; kinds?: Record<string, GridDayKind>; defaultReviewerId?: string }>(draftKey);
    const next: Drafts = {};
    let dropped = 0;
    baseRows.forEach(r => {
      const init = initialRowDraft(r.kind, r.main, workplaces);
      const s = saved?.drafts?.[r.date];
      const savedKind = saved?.kinds?.[r.date];
      const sameKind = !savedKind || savedKind === r.kind
        || ((savedKind === 'new_today' || savedKind === 'new_advance' || savedKind === 'new_post') && (r.kind === 'new_today' || r.kind === 'new_advance' || r.kind === 'new_post'));
      if (!s) { next[r.date] = init; return; }
      if (sameKind) { next[r.date] = { ...init, ...s }; return; }
      next[r.date] = init;
      if (s.segs?.some(x => x.start || x.end) || s.reason) dropped++;
    });
    setDrafts(next);
    setLastBulk(null);
    if (saved?.defaultReviewerId) setDefaultReviewerId(saved.defaultReviewerId);
    setDraftNote(dropped > 0 ? `前回の入力のうち ${dropped} 日分は、その後に申請の状態が変わったため消しました。` : '');
  }, [ready, draftKey, baseRows, workplaces]);

  // 下書きを保存（入力のたび）。どの種類の行だったかも一緒に残す（状態が変わった日を見分けるため）
  useEffect(() => {
    if (loadedKeyRef.current !== draftKey) return;
    const kinds: Record<string, GridDayKind> = {};
    baseRows.forEach(r => { kinds[r.date] = r.kind; });
    saveDraft(draftKey, { drafts, kinds, defaultReviewerId });
  }, [drafts, defaultReviewerId, draftKey, baseRows]);

  const setRow = (date: string, patch: Partial<RowDraft>) => {
    setDrafts(prev => ({ ...prev, [date]: { ...(prev[date] ?? initialRowDraft('new_post', null, workplaces)), ...patch } }));
    // 直したら、その行の前回の送信結果（送れませんでした 等）は消す
    setRowResults(prev => { if (!prev[date]) return prev; const n = { ...prev }; delete n[date]; return n; });
  };

  const rows = useMemo(() => baseRows.map(r => {
    const draft = drafts[r.date] ?? initialRowDraft(r.kind, r.main, workplaces);
    const calc: GridRowCalc = computeGridRow({
      kind: r.kind, date: r.date, today, nowMin, advanceMaxDate, ns: r.ns, main: r.main, draft,
      defaultReviewerId: r.rowDefaultReviewer, canSelfReview, selfId: userId,
      closeLocked: isPayPeriodClosed(r.date, today) && !grants.has(r.date),
      focused: focusedDate === r.date,
    });
    return { ...r, draft, calc };
  }), [baseRows, drafts, today, nowMin, advanceMaxDate, canSelfReview, grants, focusedDate, workplaces, userId]);
  type Row = typeof rows[number];

  const counts = useMemo(() => {
    const c: Partial<Record<RowState, number>> = {};
    rows.forEach(r => { c[r.calc.state] = (c[r.calc.state] ?? 0) + 1; });
    return c;
  }, [rows]);
  // 送れる行：新しく出す日（事前申請・事後報告）＋ 実績報告・再提出（2026-09-25 第5段の2つ目）
  const sendable = rows.filter(r => r.calc.state === 'ok' || r.calc.state === 'warn');
  // 🚨 「予定どおりの日を送る対象に入れる」の対象：報告できる・まだ触っていない行だけ（直した行は含めない）
  const plannedAsIs = rows.filter(r => r.kind === 'report' && !r.draft.touched);
  // 締め切りを過ぎた新しい行（経理の許可が無い）。🚨 行ごとではなく表の上に1つだけ出す
  const lockedNewRows = rows.filter(r => (r.kind === 'new_post' || r.kind === 'new_today') && isPayPeriodClosed(r.date, today) && !grants.has(r.date));

  // ────────────────────────────────────────────
  // 送信（第5段）
  // ────────────────────────────────────────────
  type RowResult = { status: 'sending' | 'waiting' | 'sent' | 'failed' | 'check'; message: string };
  const [confirm, setConfirm] = useState<{ date: string; label: string }[] | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);   // 🚨 二度押しは state ではなく ref で止める（state は次の描画まで変わらない）
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [rowResults, setRowResults] = useState<Record<string, RowResult>>({});
  const [resultCard, setResultCard] = useState<{ ok: number; failed: number; check: number } | null>(null);
  // Googleカレンダーへの反映に失敗した申請（結果カードの［反映し直す］で使う）
  const [gcalFailedIds, setGcalFailedIds] = useState<string[]>([]);
  const [gcalRetrying, setGcalRetrying] = useState(false);
  // 送れた件数を画面中央の薄緑カードで出す（🎨🔒 成功は固定色・ライトとダークで色を変えない）。4秒で消える
  const [doneBanner, setDoneBanner] = useState<{ ok: number; problems: number } | null>(null);
  useEffect(() => {
    if (!doneBanner) return;
    const t = setTimeout(() => setDoneBanner(null), 4000);
    return () => clearTimeout(t);
  }, [doneBanner]);

  // 🚨 確認の枠・送れなかった行の知らせは表のいちばん下に出るので、開いたらそこまで動かす
  //    （2026-09-25 実機指摘：押しても画面の外に出て、［送信する］が見えなかった）
  const confirmBoxRef = useScrollIntoViewWhen<HTMLDivElement>(confirm);
  const problemBoxRef = useScrollIntoViewWhen<HTMLDivElement>(resultCard && resultCard.failed + resultCard.check > 0 ? resultCard : null);

  // 送信中にページを離れようとしたら、ブラウザの標準の警告を出す
  useEffect(() => {
    if (!sending) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [sending]);

  const dowLabel = (d: string) => DOW[dowOf(d)];
  const fullDateLabel = (d: string) => `${d}（${dowLabel(d)}）`;   // 1件フォームの通知と同じ形

  /**
   * 1行ずつ順に送る。🚨 途中で失敗しても他の行は止めない（それぞれ独立した申請）。
   * 🚨 送る直前に、その行をいまの時刻でもう一度チェックする。確認画面のときと種類が変わっていたら送らない。
   */
  const doSend = async () => {
    if (!confirm || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    const targets = confirm;
    setConfirm(null);
    setResultCard(null);
    setGcalFailedIds([]);
    setRowResults(Object.fromEntries(targets.map(t => [t.date, { status: 'waiting', message: '' } as RowResult])));
    setProgress({ done: 0, total: targets.length });

    const sentIds: string[] = [];
    const sentDates: string[] = [];
    // メールは申請先ごとに1通（🚨 ベルは1件ずつ）
    const mailGroups = new Map<string, { dates: string[]; diff: number; phases: Record<string, number> }>();
    // Slack は種類ごとに1通（🚨 宛先はチャンネルなので申請先ごとには分けない・計画 §10-3）
    const slackNew: string[] = [];
    const slackConfirmed: string[] = [];
    let ok = 0, failed = 0, check = 0;
    const setRes = (date: string, res: RowResult) => setRowResults(prev => ({ ...prev, [date]: res }));

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      setRes(t.date, { status: 'sending', message: '' });
      const r = rows.find(x => x.date === t.date);
      const now = new Date();
      const nowMinLive = now.getHours() * 60 + now.getMinutes();
      const c = r ? computeGridRow({
        kind: r.kind, date: r.date, today: todayJstStr(), nowMin: nowMinLive, advanceMaxDate, ns: r.ns, main: r.main, draft: r.draft,
        defaultReviewerId: r.rowDefaultReviewer, canSelfReview, selfId: userId,
        closeLocked: isPayPeriodClosed(r.date, todayJstStr()) && !grants.has(r.date), focused: false,
      }) : null;
      const isEdit = !!r && (r.kind === 'report' || r.kind === 'resubmit');
      // 🚨 実績報告・再提出は、送る直前にその申請を読み直す（計画 §10-5）。
      //    表を開いている間に上長が受理・差し戻し・修正をしていたら、古い中身で上書きしないよう送らない
      let fresh: (GridReport & Record<string, unknown>) | null = null;
      let freshErr = '';
      if (isEdit && r?.main && c && (c.state === 'ok' || c.state === 'warn') && c.sendLabel === t.label) {
        const { data, error } = await supabase.from('overtime_reports')
          .select('*, segments:overtime_report_segments(phase, seg_no, start_min, end_min)')
          .eq('id', r.main.id).maybeSingle();
        if (error) freshErr = '申請を読み直せませんでした：' + error.message;
        else if (!data) freshErr = 'この申請が見つかりません（取り消された可能性があります）。表を読み直してください';
        else if (!sameGridReport(r.main, data as GridReport)) freshErr = '表を開いたあとで、この申請の状態か内容が変わっています（受理・差し戻し・修正など）。表を読み直してから、もう一度送ってください';
        else fresh = data as GridReport & Record<string, unknown>;
      }
      if (!r || !c || (c.state !== 'ok' && c.state !== 'warn')) {
        failed++; setRes(t.date, { status: 'failed', message: c?.message || '送れる状態ではありません' });
      } else if (c.sendLabel !== t.label) {
        failed++; setRes(t.date, { status: 'failed', message: `種類が変わりました（${t.label} → ${c.sendLabel}）。確認し直してから送ってください` });
      } else if (isEdit && !fresh) {
        check++; setRes(t.date, { status: 'check', message: freshErr });
      } else {
        const record = buildOvertimeRecord({
          userId, date: r.date, mode: c.mode, phase: c.phase, fullDayMode: false, fullDayType: null,
          isSelfReview: c.isSelfReview, isPureZero: c.isPureZero, isReportPhase: c.isReportPhase, isResubmit: c.isResubmit, hasChanges: c.hasChanges,
          normalShift: r.ns, breakMin: c.breakMin, breakManual: r.draft.breakMin.trim() !== '', laborMin: c.laborMin, diffMin: c.diffMin,
          fdDiffMin: 0, legalOk: c.legalOk, reason: r.draft.reason, changeReason: r.draft.changeReason, fdLocation: '', effectiveLocation: c.effectiveLocation,
          applicationTypes: c.applicationTypes,
          // 🚨 表ではカレンダーに載せるかを聞かない。新しい行は null（種類ごとの既定）・計画 §3。
          //    実績報告は元の申請の値を引き継ぐ（buildOvertimeRecord の中で。1件フォームと同じ）
          offerCalendarChoice: false, showOnCalendar: false, editTargetShowOnCalendar: fresh?.show_on_calendar ?? undefined,
          furikaeOriginDate: '', effectiveFurikaeOriginLocation: '', furikaeOriginStart: '', furikaeOriginEnd: '',
          furikaeOriginBreak: 0, furikaeOriginLabor: 0, furikaeHasTime: false,
          reviewerId: c.reviewerId, modifiedFromId: null,
          clockOnlyMode: false, effectiveClockReason: '', clockInAt: '', clockOutAt: '', nowIso: now.toISOString(),
        }, toDbTime);
        // 🚨 再提出も元の値を引き継ぐ（計画 §10-7）。buildOvertimeRecord は再提出では null にするので、ここで元の値に戻す。
        //    null にすると「載せない」を選んでいた人の申請が、直して出し直しただけでカレンダーに出てしまう
        if (fresh && c.isResubmit) record.show_on_calendar = fresh.show_on_calendar ?? null;
        const saved = await saveOvertimeReport({
          userId, record, phase: c.phase, segments: c.workSegments, segRetries: 2,
          // 修正の記録の言葉は1件フォームと同じ
          edit: fresh ? {
            id: fresh.id, status: fresh.status, snapshot: fresh,
            historySummary: c.isReportPhase
              ? (c.isPureZero ? '残業なし（通常どおり）で報告' : c.hasChanges ? `実績報告（変更あり：${c.changedAxes.join('・')}）` : '実績報告（予定どおり）')
              : '再提出',
            historyChangeReason: (c.isReportPhase && c.hasChanges) ? r.draft.changeReason.trim() : null,
          } : null,
        });
        if (!saved.ok) {
          if (saved.stage === 'conflict') {
            check++; setRes(r.date, { status: 'check', message: saved.message });
          } else if (saved.code === '23505') {
            // 🚨 同じ日が既にある。中身が同じ（通信が切れて応答だけ届かなかった／2つのタブで送った）なら送信済み。
            //    違えば別の経路で作られた申請なので「要確認」。どちらも通知は送らない
            const { data: ex } = await supabase.from('overtime_reports').select('id, diff_minutes, reason')
              .eq('applicant_id', userId).eq('work_date', r.date).eq('entry_type', 'manual').neq('status', 'cancelled').maybeSingle();
            const same = !!ex && ex.diff_minutes === c.diffMin && (ex.reason ?? '').trim() === r.draft.reason.trim();
            if (same) { ok++; sentDates.push(r.date); setRes(r.date, { status: 'sent', message: 'すでに送信済みでした' }); }
            else { check++; setRes(r.date, { status: 'check', message: '同じ日の申請がすでにあります（内容が違います）。表を読み直して確認してください' }); }
          } else if (saved.reportId) {
            // 申請は保存できたが時間帯が保存できなかった（2回入れ直しても失敗）。🚨 送り直すと重複になるので再送させない
            check++; setRes(r.date, { status: 'check', message: `申請は保存されましたが、時間帯を保存できませんでした。履歴から「内容を修正する」で直してください（${saved.message}）` });
          } else {
            failed++; setRes(r.date, { status: 'failed', message: saved.message });
          }
        } else {
          ok++; sentIds.push(saved.reportId); sentDates.push(r.date);
          setRes(r.date, { status: 'sent', message: c.sendLabel });
          // 依頼から来た日は、その依頼を「申請済み」にして申請と結び付ける（1件フォームと同じ）。
          // 🚨 update は0件でもエラーにならないので件数を見る。status=open を条件に入れる（相手が「対応しない」を選んだあとなら触らない）。
          //    失敗しても申請そのものは成立しているので、送信は成功のまま（依頼が open のまま残るだけ）
          if (r.req) {
            const nowIso2 = new Date().toISOString();
            const { data: linked, error: lerr } = await supabase.from('application_requests')
              .update({ status: 'applied', linked_id: saved.reportId, responded_at: nowIso2, updated_at: nowIso2 })
              .eq('id', r.req.id).eq('status', 'open').select('id');
            if (lerr || !linked || linked.length === 0) console.error('[申請の依頼] 申請済みにできませんでした', lerr?.message);
          }
          const phaseLabel = c.phase === 'actual' ? '実績報告' : '事前申請';
          // 通知（1件フォームと同じ条件）。🚨 自己受理は確認者のキューに入らないのでベルは送らない。
          //    残業なしの実績報告（差分0）もその場で確定するので送らない（押しても該当の申請が無い空振りになる）
          if (!c.isSelfReview && !c.isPureZero && c.reviewerId) {
            await notifyOvertimeNewRequestBell({
              reportId: saved.reportId, reviewerId: c.reviewerId, applicantName: profileName ?? '',
              phaseLabel, dateLabel: fullDateLabel(r.date), timeLabel: formatSignedMin(c.diffMin),
            });
            const g = mailGroups.get(c.reviewerId) ?? { dates: [], diff: 0, phases: {} };
            g.dates.push(r.date); g.diff += c.diffMin; g.phases[phaseLabel] = (g.phases[phaseLabel] ?? 0) + 1;
            mailGroups.set(c.reviewerId, g);
            slackNew.push(saved.reportId);
          } else if (c.isSelfReview && !c.isPureZero) {
            // 🚨 自己受理の残業なし（差分0）は送らない（中身が無い。1件フォームと同じ条件）
            slackConfirmed.push(saved.reportId);
          }
        }
      }
      setProgress({ done: i + 1, total: targets.length });
    }

    // メールを申請先ごとに1通（いまは OFF の設定なので実際には出ない。ON のときに件数ぶん飛ばないように）
    for (const [reviewerId, g] of mailGroups) {
      const ds = [...g.dates].sort();
      await notifyOvertimeNewRequestEmail({
        reviewerId, applicantName: profileName ?? '',
        phaseLabel: Object.entries(g.phases).map(([k, v]) => `${k}${v}件`).join('・'),
        dateLabel: ds.length > 1 ? `${fullDateLabel(ds[0])}ほか${ds.length - 1}日` : fullDateLabel(ds[0]),
        timeLabel: `計${formatSignedMin(g.diff)}（${ds.length}件）`,
      });
    }

    // Slack を種類ごとに1通（1日1行の一覧。いまは OFF の設定なので実際には出ない）
    await sendOvertimeSlackBatch(slackNew, 'overtime:new_request');
    await sendOvertimeSlackBatch(slackConfirmed, 'overtime:confirmed');

    // カレンダーの同期は申請をすべて入れ終えてから1件ずつ（失敗は送信の失敗とは分けて出す）
    const gcalNg: string[] = [];
    for (const id of sentIds) { if (!(await syncOvertimeGcal(id))) gcalNg.push(id); }
    setGcalFailedIds(gcalNg);

    // 送れた日の入力を消す（下書きからも消える）。🚨 空の入力で上書きせず消す：読み直したあとの状態
    //    （再提出を事前申請として出した日は「実績報告」の行になる 等）から、改めて最初の入力が作られるように
    setDrafts(prev => { const n = { ...prev }; sentDates.forEach(d => { delete n[d]; }); return n; });
    setResultCard({ ok, failed, check });
    if (ok > 0) setDoneBanner({ ok, problems: failed + check });
    setProgress(null);
    setSending(false);
    sendingRef.current = false;
    await load();
  };

  /** 新しい行を初めて触ったとき、時間が空ならその日の通常シフトを入れる（🚨 2本シフトの2本目の入れ忘れを防ぐ） */
  const fillNormalIfEmpty = (r: Row) => {
    if (r.kind !== 'new_post' && r.kind !== 'new_advance' && r.kind !== 'new_today') return;
    if (r.draft.segs.some(s => s.start || s.end)) return;
    // 依頼に「入る時間と校」があれば、それを入れる（1件フォームの「依頼から申請」と同じ）。
    // 🚨 表の勤務地は1か所しか持てない。依頼の校が時間帯で変わるときは勤務地を入れず、本人に選んでもらう
    const reqSegs = (r.req?.segments ?? []).filter(x => x.start && x.end);
    if (reqSegs.length > 0) {
      const locs = [...new Set(reqSegs.map(x => (x.location ?? '').trim()).filter(Boolean))];
      setRow(r.date, {
        segs: reqSegs.slice(0, 3).map(x => ({ start: x.start, end: x.end })),
        ...(r.draft.location || locs.length !== 1 ? {} : locationPick(locs[0], workplaces)),
      });
      return;
    }
    const segs = normalSegsOf(r.ns);
    setRow(r.date, {
      segs: segs.length > 0 ? segs : [{ start: '', end: '' }],
      ...(r.draft.location ? {} : locationPick(r.ns.location, workplaces)),
    });
  };

  // ---- styles（残業ページと同じ配色） ----
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const cardBg = isDark ? '#343a40' : '#fff';
  const innerBg = isDark ? '#2b3035' : '#f8f9fa';
  const borderColor = isDark ? '#495057' : '#dee2e6';
  const inputBg = isDark ? '#495057' : '#fff';
  const toggleBlue = '#1976d2';
  const toggleText = isDark ? '#90caf9' : '#1976d2';
  const toggleBg = isDark ? '#1e3a5f' : '#e3f2fd';
  const errBg = isDark ? '#4a2b30' : '#fdecea';
  const warnBg = isDark ? '#4a3f1e' : '#fff8e1';
  const warnText = isDark ? '#f0c36d' : '#b8860b';
  const btn: React.CSSProperties = { padding: '6px 12px', borderRadius: 8, border: `1px solid ${borderColor}`, background: cardBg, color: text, fontSize: 13, cursor: 'pointer' };
  const btnSm: React.CSSProperties = { ...btn, padding: '2px 8px', fontSize: 11.5 };
  const btnOn: React.CSSProperties = { background: toggleBlue, color: '#fff', borderColor: toggleBlue };
  const btnSub: React.CSSProperties = { ...btn, background: toggleBg, color: toggleText, borderColor: toggleBlue, fontWeight: 'bold' };
  const th: React.CSSProperties = { position: 'sticky', top: 0, background: innerBg, color: subText, fontSize: 12, fontWeight: 'bold', textAlign: 'left', padding: '7px 8px', borderBottom: `2px solid ${borderColor}`, whiteSpace: 'nowrap', zIndex: 1 };
  // 右端の「送る？」の列は、表を横にずらしても右端に残す（2026-09-25 実機指摘：狭い画面で右が切れて、送るかどうかが見えなかった）。
  // 日付の列を左に残しているのと同じ作り。🚨 背景は行と同じ色を塗る（塗らないと、下を流れる列が透けて重なる）。
  //    今日の行の色は半透明なので、この列だけは不透明な地の色にする
  const sendCol: React.CSSProperties = { position: 'sticky', right: 0, minWidth: 100, boxShadow: `inset 1px 0 0 ${borderColor}` };
  const td: React.CSSProperties = { padding: '6px 8px', borderBottom: `1px solid ${borderColor}`, verticalAlign: 'top', fontSize: 13, color: text };
  // 🚨 文字の入力欄は16px以上（iOS は16px未満の欄にふれるとページを拡大する）
  const txt: React.CSSProperties = { width: '100%', minWidth: 150, boxSizing: 'border-box', border: `1px solid ${borderColor}`, background: inputBg, color: text, borderRadius: 6, padding: '5px 7px', fontSize: 16 };
  // 🚨 時刻の部品（共用の TimeInput）は、空いている幅いっぱいに伸び、狭い画面では0まで縮む。
  //    表は列が多いので縮められて数字が見えなくなる（2026-09-25 実機）。表の側で幅を決めて縮ませない
  const timeBox: React.CSSProperties = { width: 104, flex: 'none' };
  const sel: React.CSSProperties = { border: `1px solid ${borderColor}`, background: inputBg, color: text, borderRadius: 6, padding: '4px 6px', fontSize: 13 };

  const segText = (segs: { start_min: number; end_min: number }[]) =>
    [...segs].sort((a, b) => a.start_min - b.start_min).map(s => `${minToTime(s.start_min)}〜${minToTime(s.end_min)}`).join(' / ');
  const typesText = (types: readonly string[] | null) =>
    (types ?? []).filter(isOvertimeType).map(t => OT_TYPE_INFO[t].label).join('・');

  const tag = (k: GridDayKind, label?: string) => {
    const st = TAG_STYLE[k];
    const style: React.CSSProperties = st === 'send'
      ? { background: toggleBg, color: toggleText, border: `1px solid ${toggleBlue}` }
      : st === 'warn'
        ? { background: errBg, color: isDark ? '#f5b8bb' : '#c62828', border: '1px solid #c62828' }
        : { background: innerBg, color: subText, border: `1px solid ${borderColor}` };
    return <span style={{ ...style, display: 'inline-block', fontSize: 11.5, fontWeight: 'bold', borderRadius: 6, padding: '1px 7px', whiteSpace: 'nowrap' }}>{label ?? GRID_KIND_TAG[k]}</span>;
  };

  const sendCell = (c: GridRowCalc, date: string, note = '') => {
    const res = rowResults[date];
    if (res) {
      if (res.status === 'waiting') return <span style={{ color: subText, fontSize: 12 }}>送信待ち</span>;
      if (res.status === 'sending') return <b style={{ color: toggleText }}>送信中…</b>;
      if (res.status === 'sent') return <b style={{ color: '#2e7d32' }}>✓ 送信済み<div style={{ fontSize: 11.5, fontWeight: 'normal' }}>{res.message}</div></b>;
      if (res.status === 'check') return <b style={{ color: warnText }}>要確認<div style={{ fontSize: 11.5, fontWeight: 'normal' }}>{res.message}</div></b>;
      return <b style={{ color: '#e24b4a' }}>送れませんでした<div style={{ fontSize: 11.5, fontWeight: 'normal' }}>{res.message}</div></b>;
    }
    switch (c.state) {
      case 'ok': return <b style={{ color: toggleText }}>送る<div style={{ fontSize: 11.5, fontWeight: 'normal' }}>{c.sendLabel}{note}</div></b>;
      case 'warn': return <b style={{ color: toggleText }}>送る（注意）<div style={{ fontSize: 11.5, fontWeight: 'normal' }}>{c.sendLabel}{note}</div></b>;
      case 'error': return <b style={{ color: '#e24b4a' }}>エラー（送らない）</b>;
      case 'editing': return <span style={{ color: subText }}>入力中</span>;
      case 'nochange': return <span style={{ color: subText, fontSize: 12 }}>通常シフトと同じ（送らない）</span>;
      case 'idle': return <span style={{ color: subText, fontSize: 12 }}>まだ送らない<br />（触るか［予定どおり］で対象に）</span>;
      case 'empty': return <span style={{ color: subText, fontSize: 12 }}>空（送らない）</span>;
      default: return null;
    }
  };

  const rowBgOf = (state: RowState, kind: GridDayKind, isToday: boolean): string | undefined => {
    if (state === 'error') return errBg;
    if (state === 'warn') return warnBg;
    if (TAG_STYLE[kind] === 'muted') return innerBg;
    if (isToday) return isDark ? '#1e3a5f55' : '#e3f2fd66';
    return undefined;
  };

  // Enter で同じ列の下の行へ（スプレッドシートと同じ動き）
  const onEnterNext = (e: React.KeyboardEvent<HTMLInputElement>, col: string) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const all = Array.from(document.querySelectorAll<HTMLInputElement>(`input[data-grid-col="${col}"]`));
    const i = all.indexOf(e.currentTarget);
    if (i >= 0 && all[i + 1]) all[i + 1].focus();
  };

  const reviewerOptions = reviewers.filter(r => r.id !== userId);
  const reviewerName = (id: string) =>
    id === GRID_SELF_REVIEW ? '自己受理' : (reviewers.find(r => r.id === id)?.name ?? peopleNames.get(id) ?? (id === userId ? '自分' : '（元の申請先）'));

  return (
    <div style={{ background: cardBg, border: `1px solid ${borderColor}`, borderRadius: 12, padding: '16px 18px', color: text }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 18, fontWeight: 'bold' }}>📋 残業申請「表入力」（パソコン専用）</span>
        <button type="button" style={btn} onClick={() => setPeriod(p => shiftPayPeriod(p, -1))} aria-label="前の給与期間">◀</button>
        <b>{payMonthPeriodLabel(period)}</b>
        <button type="button" style={btn} onClick={() => setPeriod(p => shiftPayPeriod(p, 1))} aria-label="次の給与期間">▶</button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: subText }}>新しく出す日の申請先</span>
        <select value={defaultReviewerId} onChange={e => setDefaultReviewerId(e.target.value)} style={sel} aria-label="新しく出す日の申請先">
          <option value="">選択してください</option>
          {canSelfReview && <option value={GRID_SELF_REVIEW}>自己受理（自分で確認する）</option>}
          {reviewerOptions.map(r => <option key={r.id} value={r.id}>{r.name}（{r.role_title}）</option>)}
        </select>
        <button type="button" style={btn} onClick={onClose}>1件ずつのフォームに戻る</button>
      </div>

      <div style={{ background: innerBg, border: `1px solid ${borderColor}`, borderRadius: 8, padding: '8px 12px', fontSize: 12.5, color: subText, marginBottom: 10, lineHeight: 1.7 }}>
        ・入力途中の内容は、この端末に保存されます<br />
        ・時間を入れた日だけ送ります。空の日と、通常シフトと同じ日は送りません<br />
        ・<b>実績報告・再提出の行は、触るまで送りません</b>。予定どおりなら［予定どおり］、残業が無かったら［残業なし］<br />
        ・時刻は「930」のように続けて打てます。理由の欄は Enter で下の行へ
      </div>

      {draftNote && (
        <div style={{ background: warnBg, border: '1px solid #f59e0b', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, marginBottom: 10 }}>{draftNote}</div>
      )}

      {reqErr && (
        <div style={{ background: warnBg, border: '1px solid #f59e0b', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, marginBottom: 10 }}>{reqErr}</div>
      )}

      {errors.length > 0 && (
        <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 10, padding: '10px 12px', marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 13, color: '#842029' }}>
            <b>読み込めなかったものがあります。この表は正しく表示できません（送信もできません）。</b>
            {errors.map(e => <div key={e}>{e}</div>)}
          </div>
          <button type="button" onClick={() => { loadedKeyRef.current = ''; void load(); }}
            style={{ flexShrink: 0, padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 'bold', background: '#dc3545', color: '#fff' }}>再読み込み</button>
        </div>
      )}

      {lockedNewRows.length > 0 && (
        <div style={{ background: warnBg, border: '1px solid #f59e0b', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, marginBottom: 10 }}>
          この給与期間は締め切りを過ぎています。新しく出す日（{lockedNewRows.length}日）は送れません。経理への許可の依頼は、1件ずつのフォームからできます。
          （実績報告・再提出は送れます）
        </div>
      )}

      {loading ? (
        <p style={{ margin: 0, fontSize: 13, color: subText, textAlign: 'center' }}>読み込み中…</p>
      ) : ready && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', fontSize: 13, marginBottom: 8 }}>
            <span>送れる <b>{sendable.length}件</b></span>
            <span style={{ color: '#e24b4a' }}>エラー <b>{counts.error ?? 0}件</b></span>
            <span style={{ color: subText }}>入力中 {counts.editing ?? 0}・まだ送らない {counts.idle ?? 0}・通常シフトと同じ {counts.nochange ?? 0}・空 {counts.empty ?? 0}</span>
            <span style={{ flex: 1 }} />
            {lastBulk ? (
              <span style={{ fontSize: 12.5 }}>
                {lastBulk.map(md).join('・')} を送る対象に入れました
                <button type="button" style={{ ...btnSm, marginLeft: 6 }} onClick={() => {
                  setDrafts(prev => { const n = { ...prev }; lastBulk.forEach(d => { if (n[d]) n[d] = { ...n[d], touched: false }; }); return n; });
                  setLastBulk(null);
                }}>元に戻す</button>
              </span>
            ) : (
              <button type="button" style={{ ...btnSub, opacity: plannedAsIs.length === 0 ? 0.5 : 1 }} disabled={plannedAsIs.length === 0}
                onClick={() => {
                  const ds = plannedAsIs.map(r => r.date);
                  setDrafts(prev => {
                    const n = { ...prev };
                    plannedAsIs.forEach(r => { n[r.date] = { ...initialRowDraft('report', r.main, workplaces), touched: true }; });
                    return n;
                  });
                  setLastBulk(ds);
                }}>
                予定どおりの日を送る対象に入れる（{plannedAsIs.length}件）
              </button>
            )}
            <button type="button" style={onlyErrors ? btnSub : btn} onClick={() => setOnlyErrors(v => !v)}>エラーの行だけ表示</button>
          </div>

          {/* 🚨 送信中・確認中は表を触れないようにする（送っている中身が途中で変わらないように） */}
          <div style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto', border: `1px solid ${borderColor}`, borderRadius: 8, ...(sending || confirm ? { pointerEvents: 'none', opacity: 0.7 } : {}) }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ ...th, left: 0, zIndex: 2 }}>日付</th>
                  <th style={th}>種類</th>
                  <th style={th}>通常シフト</th>
                  <th style={th}>この日の状態</th>
                  <th style={th}>時間</th>
                  <th style={th}>休憩（分）</th>
                  <th style={th}>労働・差分</th>
                  <th style={th}>理由・種別・勤務地</th>
                  <th style={th}>申請先</th>
                  <th style={{ ...th, ...sendCol, zIndex: 2 }}>送る？</th>
                </tr>
              </thead>
              <tbody>
                {rows.filter(r => !onlyErrors || r.calc.state === 'error').map(r => {
                  const dow = dowOf(r.date);
                  const off = r.ns.day_kind === 'holiday' || dow === 0 || dow === 6;
                  const isToday = r.date === today;
                  const rep = r.main ?? r.leaveAuto;
                  const planned = (rep?.segments ?? []).filter(s => s.phase === 'planned');
                  const actual = (rep?.segments ?? []).filter(s => s.phase === 'actual');
                  const st = rep ? STATUS_INFO[rep.status] : null;
                  const c = r.calc;
                  const bg = rowBgOf(c.state, r.kind, isToday);
                  const editable = c.state !== 'view';
                  const isEdit = r.kind === 'report' || r.kind === 'resubmit';
                  const idle = c.state === 'idle';
                  // 実績報告・再提出の行は、触った時点で「送る対象」に入れる
                  const touch = (patch: Partial<RowDraft>) => setRow(r.date, isEdit ? { ...patch, touched: true } : patch);
                  const tagLabel = r.kind === 'new_today' ? `今日（${c.sendLabel}）` : r.kind === 'resubmit' ? c.sendLabel : undefined;
                  return (
                    <tr key={r.date} style={{ background: bg }}
                      onFocus={() => setFocusedDate(r.date)}
                      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusedDate(d => (d === r.date ? null : d)); }}>
                      <td style={{ ...td, position: 'sticky', left: 0, background: bg ?? cardBg, whiteSpace: 'nowrap', fontWeight: 'bold', color: off ? '#d9534f' : text }}>
                        {md(r.date)}（{DOW[dow]}）
                        {isToday && <div style={{ fontSize: 11, color: toggleText }}>今日</div>}
                        {r.ck && <div style={{ fontSize: 11, fontWeight: 'normal', background: CALENDAR_CELL_STYLE[r.ck].bg, color: CALENDAR_CELL_STYLE[r.ck].text, borderRadius: 4, padding: '0 4px', display: 'inline-block' }}>{CALENDAR_CELL_STYLE[r.ck].short}</div>}
                      </td>
                      <td style={td}>{tag(r.kind, tagLabel)}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{normalShiftTimeText(r.ns) || <span style={{ color: subText }}>休み</span>}</td>
                      <td style={td}>
                        {st ? (
                          <span style={{ display: 'inline-block', fontSize: 11.5, fontWeight: 'bold', color: '#fff', background: st.color, borderRadius: 10, padding: '2px 8px', whiteSpace: 'nowrap' }}>{st.label}</span>
                        ) : <span style={{ color: subText }}>―</span>}
                        {planned.length > 0 && <div style={{ fontSize: 11.5, color: subText, marginTop: 2 }}>予定 {segText(planned)}{rep ? `・${typesText(rep.application_types)}` : ''}</div>}
                        {!editable && actual.length > 0 && <div style={{ fontSize: 11.5, color: subText }}>実績 {segText(actual)}</div>}
                        {rep?.status === 'returned' && rep.return_comment && (
                          <div style={{ color: '#e24b4a', fontWeight: 'bold', fontSize: 12, marginTop: 2 }}>差し戻し理由：{rep.return_comment}</div>
                        )}
                        {r.kind === 'report_wait' && isToday && <div style={{ fontSize: 11.5, color: subText, marginTop: 2 }}>勤務が終わるころに報告できます</div>}
                        {r.req && (
                          <div style={{ fontSize: 12, marginTop: 3, color: toggleText, fontWeight: 'bold' }}>
                            📩 {r.req.requester_name ?? '上長'}さんから申請の依頼
                            {r.req.memo && <div style={{ fontWeight: 'normal', color: subText }}>「{r.req.memo}」</div>}
                            {(r.req.segments ?? []).length > 0 && <div style={{ fontWeight: 'normal', color: subText }}>依頼の時間：{segmentsText(r.req.segments)}</div>}
                          </div>
                        )}
                        {r.kind === 'beyond_max' && <div style={{ fontSize: 11.5, color: subText, marginTop: 2 }}>事前申請はまだ出せません</div>}
                      </td>

                      {!editable ? (
                        <>
                          <td style={td} colSpan={4}>
                            {rep && rep.diff_minutes != null && <b style={{ color: rep.diff_minutes > 0 ? '#2e7d32' : rep.diff_minutes < 0 ? '#c62828' : subText }}>{formatSignedMin(rep.diff_minutes)} </b>}
                            {rep?.reason && <span>{rep.reason}</span>}
                            {r.kind === 'form_only' && (
                              <div style={{ fontSize: 12, color: subText, marginTop: 2 }}>
                                時間外調整休・振替休日・欠勤・打刻ズレ・移動ありは、1件ずつのフォームから出してください
                                <button type="button" style={{ ...btnSm, marginLeft: 6 }} onClick={onOpenForm}>フォームを開く</button>
                              </div>
                            )}
                          </td>
                          <td style={td}>{rep?.reviewer_id ? <span style={{ fontSize: 12, color: subText }}>{reviewerName(rep.reviewer_id)}</span> : null}</td>
                          <td style={{ ...td, ...sendCol, background: bg && bg.length <= 7 ? bg : cardBg }}><span style={{ fontSize: 12, color: subText }}>{r.kind === 'done' || r.kind === 'leave_auto' ? '済み' : ''}</span></td>
                        </>
                      ) : (
                        <>
                          <td style={{ ...td, whiteSpace: 'nowrap' }}>
                            {r.draft.segs.map((s, i) => (
                              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3, opacity: idle ? 0.75 : 1 }}
                                onFocus={() => { if (i === 0) fillNormalIfEmpty(r); }}>
                                <TimeInput value={s.start} isDark={isDark} style={timeBox} advance ariaLabel={`${md(r.date)} 勤務${i + 1} 開始`}
                                  onChange={v => touch({ segs: r.draft.segs.map((x, j) => (j === i ? { ...x, start: v } : x)) })} />
                                <span>〜</span>
                                <TimeInput value={s.end} isDark={isDark} style={timeBox} ariaLabel={`${md(r.date)} 勤務${i + 1} 終了`}
                                  onChange={v => touch({ segs: r.draft.segs.map((x, j) => (j === i ? { ...x, end: v } : x)) })} />
                                {i > 0 && <button type="button" style={btnSm} aria-label="この時間帯を消す"
                                  onClick={() => touch({ segs: r.draft.segs.filter((_, j) => j !== i) })}>✕</button>}
                              </div>
                            ))}
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {r.draft.segs.length < 3 && <button type="button" style={btnSm} onClick={() => touch({ segs: [...r.draft.segs, { start: '', end: '' }] })}>＋ 時間帯</button>}
                              {r.kind === 'report' && (
                                <>
                                  <button type="button" style={{ ...btnSm, ...(r.draft.touched && !c.hasChanges ? btnOn : {}) }}
                                    onClick={() => setRow(r.date, { ...initialRowDraft('report', r.main, workplaces), touched: true })}>予定どおり</button>
                                  <button type="button" style={{ ...btnSm, ...(r.draft.touched && c.isPureZero ? btnOn : {}) }}
                                    onClick={() => {
                                      const segs = normalSegsOf(r.ns);
                                      setRow(r.date, {
                                        touched: true, segs: segs.length > 0 ? segs : [{ start: '', end: '' }], breakMin: '',
                                        ...locationPick(r.ns.location, workplaces),
                                        lateChoice: null, earlyChoice: null,
                                      });
                                    }}>残業なし</button>
                                </>
                              )}
                              {isEdit && r.draft.touched && (
                                <button type="button" style={btnSm} onClick={() => setRow(r.date, { ...initialRowDraft(r.kind, r.main, workplaces), touched: false })}>送らない</button>
                              )}
                            </div>
                            {r.kind === 'report' && r.draft.touched && c.hasChanges && <div style={{ fontSize: 11.5, color: toggleText }}>予定から変更</div>}
                          </td>
                          <td style={td}>
                            <input type="text" inputMode="numeric" value={r.draft.breakMin} placeholder={`自動 ${c.breakMin}`}
                              onChange={e => touch({ breakMin: e.target.value.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, '') })}
                              style={{ ...txt, minWidth: 0, width: 80 }} aria-label={`${md(r.date)} 休憩（分）`} />
                            {r.draft.breakMin !== '' && (
                              <div style={{ fontSize: 11 }}>
                                <span style={{ color: subText }}>手入力 </span>
                                <button type="button" style={{ ...btnSm, padding: '0 6px' }} onClick={() => touch({ breakMin: '' })}>自動に戻す</button>
                              </div>
                            )}
                          </td>
                          <td style={{ ...td, whiteSpace: 'nowrap', opacity: idle ? 0.75 : 1 }}>
                            {c.workSegments.length > 0 ? (
                              <>
                                {formatMin(c.laborMin)}<br />
                                <b style={{ color: c.diffMin > 0 ? '#2e7d32' : c.diffMin < 0 ? '#c62828' : subText }}>{formatSignedMin(c.diffMin)}</b>
                                {!c.legalOk && <div style={{ fontSize: 11.5, fontWeight: 'bold', color: warnText }}>⚠️ 休憩が法定より短い</div>}
                              </>
                            ) : <span style={{ color: subText }}>―</span>}
                          </td>
                          <td style={{ ...td, minWidth: 200 }}>
                            <input type="text" value={r.draft.reason} placeholder="理由" data-grid-col="reason"
                              onChange={e => touch({ reason: e.target.value })} onKeyDown={e => onEnterNext(e, 'reason')}
                              style={{ ...txt, ...(c.state === 'error' && c.message === '理由を入力してください' ? { border: '2px solid #e24b4a' } : {}) }}
                              aria-label={`${md(r.date)} 理由`} />
                            {r.kind === 'report' && r.draft.touched && c.hasChanges && !c.isPureZero && (
                              <input type="text" value={r.draft.changeReason} placeholder="予定から変わった理由（必須）" data-grid-col="changeReason"
                                onChange={e => touch({ changeReason: e.target.value })} onKeyDown={e => onEnterNext(e, 'changeReason')}
                                style={{ ...txt, marginTop: 4 }} aria-label={`${md(r.date)} 予定から変わった理由`} />
                            )}
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 4, fontSize: 12 }}>
                              {c.applicationTypes.length > 0 && <span style={{ color: subText }}>{typesText(c.applicationTypes)}</span>}
                              {/* 選択肢は lib/overtimeSubmit の LATE_CHOICES / EARLY_CHOICES（1件フォームと共用・短い表記で並べる） */}
                              {c.typeDetect.lateQ && (
                                <span>開始が遅い：
                                  {LATE_CHOICES.map(o => (
                                    <label key={o.value} style={{ marginRight: 6 }}><input type="radio" checked={r.draft.lateChoice === o.value} onChange={() => touch({ lateChoice: o.value })} /> {o.short}</label>
                                  ))}
                                </span>
                              )}
                              {c.typeDetect.earlyQ && (
                                <span>早く終わる：
                                  {EARLY_CHOICES.map(o => (
                                    <label key={o.value} style={{ marginRight: 6 }}><input type="radio" checked={r.draft.earlyChoice === o.value} onChange={() => touch({ earlyChoice: o.value })} /> {o.short}</label>
                                  ))}
                                </span>
                              )}
                              <select value={r.draft.location} onChange={e => touch({ location: e.target.value })} style={sel} aria-label={`${md(r.date)} 勤務地`}>
                                <option value="">勤務地</option>
                                {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
                                <option value="その他">その他</option>
                              </select>
                              {r.draft.location === 'その他' && (
                                <input type="text" value={r.draft.locationCustom} placeholder="勤務地" onChange={e => touch({ locationCustom: e.target.value })}
                                  style={{ ...txt, minWidth: 0, width: 130 }} aria-label={`${md(r.date)} 勤務地（その他）`} />
                              )}
                            </div>
                            {c.message && (c.state === 'error' || c.state === 'warn' || c.state === 'nochange') && (
                              <div style={{ fontSize: 11.5, fontWeight: 'bold', marginTop: 3, color: c.state === 'error' ? '#e24b4a' : c.state === 'warn' ? warnText : subText }}>{c.message}</div>
                            )}
                          </td>
                          <td style={td}>
                            {isEdit ? (
                              <span style={{ fontSize: 12, color: subText }}>{c.isSelfReview ? '自己受理' : reviewerName(c.reviewerId)}<br />（元の申請のまま）</span>
                            ) : (
                              <select value={r.draft.reviewerId} onChange={e => touch({ reviewerId: e.target.value })} style={{ ...sel, maxWidth: 170 }} aria-label={`${md(r.date)} 申請先`}>
                                <option value="">{r.req ? `依頼した人（${r.req.requester_name ?? reviewerName(r.req.requester_id)}）` : defaultReviewerId ? `表の上と同じ（${reviewerName(defaultReviewerId)}）` : '表の上で選んでください'}</option>
                                {canSelfReview && <option value={GRID_SELF_REVIEW}>自己受理（自分で確認する）</option>}
                                {reviewerOptions.map(rv => <option key={rv.id} value={rv.id}>{rv.name}（{rv.role_title}）</option>)}
                              </select>
                            )}
                          </td>
                          <td style={{ ...td, ...sendCol, background: bg && bg.length <= 7 ? bg : cardBg }}>{sendCell(c, r.date, r.req ? '（依頼に答える）' : '')}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
            <button type="button" style={btn} disabled={sending} onClick={() => {
              clearDraft(draftKey);
              const next: Drafts = {};
              baseRows.forEach(r => { next[r.date] = initialRowDraft(r.kind, r.main, workplaces); });
              setDrafts(next);
              setLastBulk(null);
              setRowResults({});
            }}>この期間の入力をすべて消す</button>
            <span style={{ fontSize: 12, color: subText }}>
              {(counts.error ?? 0) > 0 ? `エラーの ${counts.error} 件は送りません。` : ''}
            </span>
            {!confirm && !sending && (
              <button type="button" disabled={sendable.length === 0 || errors.length > 0}
                onClick={() => {
                  setResultCard(null);
                  setConfirm(sendable.map(r => ({ date: r.date, label: r.calc.sendLabel })));
                }}
                style={{ ...btn, ...btnOn, fontWeight: 'bold', ...(sendable.length === 0 ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}>
                {sendable.length}件を確認して送信
              </button>
            )}
          </div>

          {/* 送る前の確認（申請先ごと）。🚨 押した瞬間には送らない。ここで［送信する］を押したときだけ送る */}
          {confirm && (() => {
            const items = confirm.map(t => rows.find(r => r.date === t.date)).filter((r): r is Row => !!r);
            const groups = new Map<string, Row[]>();
            items.forEach(r => {
              const k = r.calc.isSelfReview ? GRID_SELF_REVIEW : r.calc.reviewerId;
              groups.set(k, [...(groups.get(k) ?? []), r]);
            });
            const line = (r: Row) => {
              const segs = [...r.calc.workSegments].sort((a, b) => a.startMin - b.startMin).map(s => `${minToTime(s.startMin)}〜${minToTime(s.endMin)}`).join(' / ');
              return (
                <div key={r.date} style={{ fontSize: 13, padding: '2px 0' }}>
                  <b>{md(r.date)}（{DOW[dowOf(r.date)]}）</b> {r.calc.sendLabel}{r.req ? '（依頼に答える）' : ''}：{segs}
                  <b style={{ color: r.calc.diffMin > 0 ? '#2e7d32' : r.calc.diffMin < 0 ? '#c62828' : subText }}>{formatSignedMin(r.calc.diffMin)}</b>
                  {' '}{typesText(r.calc.applicationTypes)} 「{r.draft.reason.trim()}」
                  {r.calc.isReportPhase && r.calc.hasChanges && !r.calc.isPureZero && <span style={{ color: subText }}> 変わった理由「{r.draft.changeReason.trim()}」</span>}
                  {r.calc.state === 'warn' && <span style={{ color: warnText, fontWeight: 'bold' }}> ⚠️ 休憩が法定より短い</span>}
                </div>
              );
            };
            return (
              <div ref={confirmBoxRef} style={{ border: `2px solid ${toggleBlue}`, borderRadius: 10, padding: '12px 14px', marginTop: 14, background: cardBg }}>
                <b style={{ fontSize: 15 }}>送る前の確認（{items.length}件）</b>
                {[...groups.entries()].map(([k, rs]) => (
                  <div key={k} style={{ border: `1px solid ${borderColor}`, borderRadius: 8, padding: '8px 10px', margin: '8px 0' }}>
                    <div style={{ fontWeight: 'bold', fontSize: 13.5, marginBottom: 4 }}>
                      {k === GRID_SELF_REVIEW
                        ? <>自己受理（{rs.length}件）<span style={{ color: '#c62828' }}> 送った時点で確定します</span></>
                        : <>{reviewerName(k)} さん宛（{rs.length}件）</>}
                    </div>
                    {rs.map(line)}
                  </div>
                ))}
                <p style={{ fontSize: 12, color: subText, margin: '4px 0 0' }}>
                  {/* 2026-09-25 ユーザー確定：説明は短く1文だけ（ベル・申請先・残業なしの扱いは書かない） */}
                  1日ずつ、いつもの申請として登録されます。
                </p>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 10 }}>
                  <button type="button" style={btn} onClick={() => setConfirm(null)}>戻って直す</button>
                  <button type="button" style={{ ...btn, ...btnOn, fontWeight: 'bold' }} onClick={() => { void doSend(); }}>{items.length}件を送信する</button>
                </div>
              </div>
            );
          })()}

          {progress && (
            <div style={{ border: `1px solid ${borderColor}`, borderRadius: 10, padding: '10px 14px', marginTop: 14, fontSize: 13 }}>
              送信中… <b>{progress.done} / {progress.total}件</b>（このページを閉じないでください）
            </div>
          )}

          {/* 送れた件数は画面中央の薄緑カード（doneBanner）。ここは送れなかった・確認が要る・カレンダーの反映に失敗したときだけ。
              🚨 固定色（ライトとダークで色を変えない・🎨🔒）。以前はダークで暗い緑になり読みにくかった（2026-09-25 実機指摘） */}
          {resultCard && (resultCard.failed + resultCard.check > 0 || gcalFailedIds.length > 0) && (
            <div ref={problemBoxRef} style={{
              background: '#fff3cd', border: '1px solid #ffc107', color: '#856404',
              borderRadius: 8, padding: '10px 12px', fontSize: 13, marginTop: 14,
            }}>
              {resultCard.failed > 0 && <div>送れなかった {resultCard.failed} 件は表に残っています（行の右端に理由）。</div>}
              {resultCard.check > 0 && <div>確認が必要な {resultCard.check} 件があります（行の右端を見てください）。</div>}
              {gcalFailedIds.length > 0 && (
                <div style={{ marginTop: resultCard.failed + resultCard.check > 0 ? 6 : 0 }}>
                  Googleカレンダーへの反映に失敗した申請が {gcalFailedIds.length} 件あります。
                  <button type="button" style={{ ...btnSm, marginLeft: 6 }} disabled={gcalRetrying} onClick={async () => {
                    setGcalRetrying(true);
                    const ng: string[] = [];
                    for (const id of gcalFailedIds) { if (!(await syncOvertimeGcal(id))) ng.push(id); }
                    setGcalFailedIds(ng);
                    setGcalRetrying(false);
                  }}>{gcalRetrying ? '反映中…' : 'カレンダーに反映し直す'}</button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* 送れた件数（🎨🔒 成功の薄緑カード。残業ページの送信完了と同じ形・補足行つき） */}
      {doneBanner && (
        <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9999, background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: '20px 28px', boxShadow: '0 4px 20px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', gap: 12, minWidth: 260 }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 18, flexShrink: 0 }}>✓</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 15, fontWeight: 'bold', color: '#166534' }}>{doneBanner.ok}件を送信しました</p>
            <p style={{ margin: '2px 0 0', fontSize: 12.5, color: '#15803d' }}>
              {doneBanner.problems > 0 ? `送れなかった・確認が必要な ${doneBanner.problems} 件は、表の下に出ています` : '履歴・実績報告タブで状況を確認できます'}
            </p>
          </div>
          <button type="button" onClick={() => setDoneBanner(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#166534', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>✕</button>
        </div>
      )}
    </div>
  );
};

export default OvertimeGrid;
