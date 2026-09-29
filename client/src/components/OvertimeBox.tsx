// 残業の［まとめて申請］（スマホ・交通費と同じ「箱」）。計画：docs/計画-残業のまとめて申請.md（2026-09-29 ユーザー確定）
//
// 上の青い枠で1日分 →［＋ 申請リストに追加］→ 一覧（［複製］［直す］［削除］）→［申請する（N件）］→ 送る前の確認 → 送信。
// 🚨 行の計算・判定・送信は表入力と同じ部品（lib/overtimeGrid の buildDayBase・computeGridRow、lib/overtimeBulkSend の runBulkSend、
//    lib/overtimeSubmitApi の supabaseBulkWriter）。ここに条件を書き写さないこと。
// 🚨 新しく出す日（事前申請・事後報告）だけ。実績報告・再提出・修正は「履歴・実績報告」から1件ずつ（ユーザー確定）
// 🚨 箱の中身は端末に保存（閉じても残る＝交通費と同じ）。キーは「利用者ID」ごと（共用の端末で前の人の入力が見えないように）

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import {
  calcPayPeriodStartJst, shiftPayPeriod, todayJstStr, advanceRequestMaxDate,
  formatSignedMin, formatMin, minToTime, isPayPeriodClosed, isPayPeriodPayoutPassed,
} from '../lib/breakCalc';
import type { CalendarKind } from '../lib/breakCalc';
import { resolveNormalShift, normalShiftTimeText } from '../lib/overtimeShift';
import type { PatternRow } from '../lib/overtimeShift';
import {
  periodDates, EMPTY_ROW_DRAFT, computeGridRow, normalSegsOf, locationPick, GRID_SELF_REVIEW, gridBalance,
  gridDayTypeOptions, FURIKAE_ORIGIN_TAKEN_MSG, shortMd, buildDayBase, isNewGridKind,
} from '../lib/overtimeGrid';
import type { GridReport, GridDayKind, RowDraft, GridRowCalc, GridDayType } from '../lib/overtimeGrid';
import { diffColor } from '../lib/overtimeBalance';
import { isOvertimeType, typeLabelFor, CLOCK_ONLY_REASONS } from '../lib/overtimeTypes';
import type { SituationLike } from '../lib/overtimeTypes';
import { DRAFT_KEYS, loadDraft, saveDraft } from '../lib/draftStorage';
import { useRoles } from '../hooks/useRoles';
import { attrsFor } from '../lib/roleAttrs';
import { useScrollIntoViewWhen } from '../hooks/useScrollIntoViewWhen';
import TimeInput from './TimeInput';
import { LATE_CHOICES, EARLY_CHOICES } from '../lib/overtimeSubmit';
import {
  syncOvertimeGcal, supabaseBulkWriter, fetchGrantedWorkDates, fetchMyGrantRequests, fetchClosedAllDates, fetchFurikaeOrigins,
} from '../lib/overtimeSubmitApi';
import type { GrantRequestRow } from '../lib/overtimeSubmitApi';
import OvertimeGrantPanel from './OvertimeGrantPanel';
import OvertimeNotes from './OvertimeNotes';
import { runBulkSend } from '../lib/overtimeBulkSend';
import type { BulkRowStatus } from '../lib/overtimeBulkSend';
import { requestSegmentsLocation, effectiveClockReasonOf, isManagerReviewer, furikaeOriginPrefill } from '../lib/overtimeFormParts';
import type { SegmentLike } from '../lib/segmentsText';

interface Reviewer { id: string; name: string; role_title: string; roles?: unknown }

interface Props {
  userId: string;
  profileName: string | null;
  roleTitle: string;
  isAdmin: boolean;
  isDark: boolean;
  /** 申請先の候補（ページが読んだもの＝1件フォームと同じ） */
  reviewers: Reviewer[];
  /** 勤務地の候補（ページが読んだもの＝1件フォームと同じ） */
  workplaces: string[];
  /** カレンダーに載せるかを自分で選べる人か（ページが読んだもの＝1件フォームと同じ） */
  canChooseCalendar: boolean;
  /** 送れたあと（ページの履歴を読み直す） */
  onSent: () => void;
}

interface BoxRequest { id: string; requester_id: string; requester_name: string | null; target_dates: string[] | null; memo: string | null; segments: SegmentLike[] | null }

/** 箱の1件（1日分）。🚨 同じ日を2つ入れない（追加の時点で止める） */
interface BoxItem { key: string; date: string; draft: RowDraft }
interface BoxInput {
  date: string; draft: RowDraft;
  /** ［直す］で直しているリストの1件（その行はリストに残したまま・「追加」で置き換える）。🚨 途中でやめても元の1件は消えない */
  editingKey?: string | null;
  /** 申請先を本人が選んだか（選んでいれば、依頼がある日でも依頼した人で上書きしない） */
  reviewerPicked?: boolean;
}
interface BoxStore { items: BoxItem[]; input: BoxInput; lastReviewerId: string }

/** 送る前の確認で、打刻ズレ（確認なしで確定）をまとめる箱の名前 */
const CLOCK_GROUP = '__clock__';
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const md = shortMd;
const dowOf = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).getDay(); };
const dayLabel = (d: string) => `${md(d)}（${DOW[dowOf(d)]}）`;
const newKey = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const emptyInput = (reviewerId: string): BoxInput => ({ date: '', draft: { ...EMPTY_ROW_DRAFT, segs: [{ start: '', end: '' }], reviewerId }, editingKey: null, reviewerPicked: false });
const isDateStr = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** 箱に入れられない日の理由（新しく出す日以外） */
function kindNgMessage(kind: GridDayKind, advanceMaxDate: string): string {
  if (kind === 'beyond_max') return `事前申請は${dayLabel(advanceMaxDate)}までです。それより先の日は、その時期が近づいてから申請してください`;
  if (kind === 'leave_auto') return 'この日は休暇から自動で計上されています';
  return 'この日は申請済みです（直すときは「履歴・実績報告」から）';
}

const OvertimeBox: React.FC<Props> = ({ userId, profileName, roleTitle, isAdmin, isDark, reviewers, workplaces, canChooseCalendar, onSent }) => {
  const today = todayJstStr();
  const advanceMaxDate = advanceRequestMaxDate(today);
  const period = calcPayPeriodStartJst(today);
  // 読む範囲：2つ前の給与期間の始め〜事前申請の上限（締め切り後の日も、許可があれば出せるため）
  const winFrom = shiftPayPeriod(shiftPayPeriod(period, -1), -1);
  const winTo = advanceMaxDate;
  const roles = useRoles();
  const canSelfReview = isAdmin || attrsFor(roles, roleTitle).is_manager_plus;

  // ---- 読み込み ----
  const [patterns, setPatterns] = useState<PatternRow[] | null>(null);
  const [calendar, setCalendar] = useState<Record<string, CalendarKind> | null>(null);
  const [reports, setReports] = useState<GridReport[] | null>(null);
  const [requests, setRequests] = useState<BoxRequest[]>([]);
  const [furikaeOrigins, setFurikaeOrigins] = useState<Map<string, string>>(new Map());
  const [grants, setGrants] = useState<Set<string>>(new Set());
  const [grantRequests, setGrantRequests] = useState<GrantRequestRow[]>([]);
  const [grantReqErr, setGrantReqErr] = useState<string | null>(null);
  const [closedDates, setClosedDates] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<string[]>([]);
  const [reqErr, setReqErr] = useState('');
  // 申請先の候補に無い人の名前（依頼した人・前に選んだ人が退職・役職変更した 等）
  const [extraNames, setExtraNames] = useState<Map<string, string>>(new Map());

  const load = useCallback(async () => {
    const errs: string[] = [];
    const [patRes, calRes, repRes, reqRes, originRes] = await Promise.all([
      supabase.from('weekly_shift_patterns').select('*').eq('user_id', userId),
      supabase.from('company_calendar').select('date, kind').gte('date', winFrom).lte('date', winTo),
      supabase.from('overtime_reports')
        .select('id, work_date, status, entry_type, is_post_hoc, application_types, location, diff_minutes, break_minutes, break_manual, reason, return_comment, reviewer_id, normal_shift, show_on_calendar, late_situation, early_situation, segments:overtime_report_segments(phase, seg_no, start_min, end_min)')
        .eq('applicant_id', userId).gte('work_date', winFrom).lte('work_date', winTo),
      supabase.from('application_requests').select('id, requester_id, target_dates, memo, segments')
        .eq('recipient_id', userId).eq('kind', 'overtime').eq('status', 'open').order('created_at', { ascending: true }),
      fetchFurikaeOrigins(userId, winFrom, winTo),
    ]);
    // 🚨 シフト・カレンダー・申請・振替元のどれか1つでも読めなければ送らせない（表入力と同じ）
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
    if (originRes.error) errs.push('振替休日の振替元：' + originRes.error);
    setFurikaeOrigins(originRes.map);
    // 依頼は読めなくても止めない（依頼と結び付かないだけ）。名前だけ読む
    const rs = reqRes.error ? [] : (reqRes.data ?? []) as Omit<BoxRequest, 'requester_name'>[];
    let nameOf = new Map<string, string>();
    const ids = [...new Set(rs.map(q => q.requester_id))].filter(Boolean);
    if (ids.length > 0) {
      const { data: profs } = await supabase.from('profiles').select('id, name').in('id', ids);
      nameOf = new Map(((profs ?? []) as { id: string; name: string }[]).map(p => [p.id, p.name]));
    }
    setRequests(rs.map(q => ({ ...q, requester_name: nameOf.get(q.requester_id) ?? null })));
    // 🚨 依頼が読めなくても止めないが、黙らない（表入力と同じ）
    setReqErr(reqRes.error ? '申請の依頼を読み込めませんでした。ここから送っても、依頼とは結び付きません（' + reqRes.error.message + '）' : '');
    setErrors(errs);
  }, [userId, winFrom, winTo]);
  useEffect(() => { void load(); }, [load]);

  // 締め後の許可・依頼・休館日（表入力と同じ読み方）
  const loadGrantState = useCallback(async () => {
    const closedFrom = (() => { const d = new Date(); d.setMonth(d.getMonth() - 6); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
    const [grantSet, grantReqRes, closedSet] = await Promise.all([
      fetchGrantedWorkDates(userId), fetchMyGrantRequests(userId), fetchClosedAllDates(closedFrom),
    ]);
    setGrants(grantSet);
    setGrantRequests(grantReqRes.rows);
    setGrantReqErr(grantReqRes.error);
    setClosedDates(closedSet);
  }, [userId]);
  useEffect(() => { void loadGrantState(); }, [loadGrantState]);

  const [nowMin, setNowMin] = useState(() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); });
  useEffect(() => {
    const t = setInterval(() => { const d = new Date(); setNowMin(d.getHours() * 60 + d.getMinutes()); }, 60_000);
    return () => clearInterval(t);
  }, []);

  // ---- 箱（端末に保存） ----
  const storeKey = `${DRAFT_KEYS.overtimeBox}:${userId}`;
  const [store, setStore] = useState<BoxStore>(() => {
    const s = loadDraft<BoxStore>(storeKey);
    // 🚨 古い形の下書きでも落ちないよう、足りない項目は空で埋める
    const fix = (d: Partial<RowDraft> | undefined): RowDraft => ({ ...EMPTY_ROW_DRAFT, segs: [{ start: '', end: '' }], ...(d ?? {}) });
    if (!s || typeof s !== 'object') return { items: [], input: emptyInput(''), lastReviewerId: '' };
    // 🚨 壊れた保存でも画面を落とさない：日付の形の行だけ・同じ日は1つだけ残す
    const seen = new Set<string>();
    const items = (Array.isArray(s.items) ? s.items : [])
      .filter(it => it && isDateStr(it.date) && !seen.has(it.date) && (seen.add(it.date), true))
      .map(it => ({ key: typeof it.key === 'string' ? it.key : newKey(), date: it.date, draft: fix(it.draft) }));
    const editingKey = s.input?.editingKey && items.some(it => it.key === s.input.editingKey) ? s.input.editingKey : null;
    return {
      items,
      input: { date: isDateStr(s.input?.date) ? s.input.date : '', draft: fix(s.input?.draft), editingKey, reviewerPicked: !!s.input?.reviewerPicked },
      lastReviewerId: typeof s.lastReviewerId === 'string' ? s.lastReviewerId : '',
    };
  });
  useEffect(() => { saveDraft(storeKey, store); }, [storeKey, store]);
  // 送信中に別のタブへ移って画面が閉じても、送れた日を端末の保存から消せるように（最新の中身を持っておく）
  const storeRef = useRef(store);
  storeRef.current = store;
  const { items, input } = store;
  const setInputDraft = (patch: Partial<RowDraft>) => setStore(s => ({ ...s, input: { ...s.input, draft: { ...s.input.draft, ...patch } } }));

  const [tried, setTried] = useState(false);        // ［追加］を押したあとだけ赤い文を出す（入れている途中で赤くしない）
  const [addError, setAddError] = useState('');
  const [banner, setBanner] = useState<'' | 'copy' | 'edit'>('');
  // 入力中の内容を消して［直す］［複製］してよいかの確認
  const [pending, setPending] = useState<{ kind: 'edit' | 'copy'; key: string } | null>(null);
  // 振替元の日を選んだときに自動で入れた時刻（表入力と同じ：休みの日に選び直したら、自動で入れた時刻だけ消す）
  const furikaeAutoRef = useRef<{ start: string; end: string } | null>(null);

  const ready = patterns !== null && calendar !== null && reports !== null;
  const reviewerIsManager = useMemo(() => (id: string) => isManagerReviewer(reviewers.find(rv => rv.id === id)), [reviewers]);
  const requestByDate = useMemo(() => {
    const m = new Map<string, BoxRequest>();
    requests.forEach(q => (q.target_dates ?? []).forEach(d => { if (!m.has(d)) m.set(d, q); }));
    return m;
  }, [requests]);

  /**
   * その日の申請先として選べる人か：自己受理・申請先の候補（在籍のリーダー・マネージャー）・その日の依頼をした人。
   * 🚨 端末に残した申請先が退職・役職変更で候補から外れていても、黙って送らない（2026-09-29 レビュー指摘）
   */
  const reviewerAllowed = (date: string, id: string) =>
    !id || id === GRID_SELF_REVIEW || reviewers.some(rv => rv.id === id) || requestByDate.get(date)?.requester_id === id;
  const nameOfReviewer = (id: string) =>
    reviewers.find(rv => rv.id === id)?.name ?? requests.find(q => q.requester_id === id)?.requester_name ?? extraNames.get(id) ?? null;
  // 候補に無い申請先の名前を読む（選択欄と確認に名前を出すため）
  const missingKey = [...new Set([...items.map(i => i.draft.reviewerId), input.draft.reviewerId])]
    .filter(id => id && id !== GRID_SELF_REVIEW && !reviewers.some(rv => rv.id === id) && !requests.some(q => q.requester_id === id) && !extraNames.has(id))
    .sort().join(',');
  useEffect(() => {
    if (!missingKey) return;
    const ids = missingKey.split(',');
    supabase.from('profiles').select('id, name').in('id', ids).then(({ data }) => {
      setExtraNames(prev => {
        const m = new Map(prev);
        ((data ?? []) as { id: string; name: string }[]).forEach(p => m.set(p.id, p.name));
        ids.forEach(id => { if (!m.has(id)) m.set(id, '（不明な申請先）'); });
        return m;
      });
    }, () => { /* 名前が読めなくても「（申請先）」と出すだけ */ });
  }, [missingKey]);

  // ---- 1日分の計算（箱の中の行と、上の青い枠で同じもの） ----
  const makeRow = useCallback((date: string, draft: RowDraft, others: { date: string; draft: RowDraft }[]) => {
    if (!ready) return null;
    const base = buildDayBase({
      date, today, nowMin, advanceMaxDate, patterns: patterns!, calendarKind: calendar![date] ?? null,
      dayReports: reports!.filter(r => r.work_date === date), request: requestByDate.get(date) ?? null, defaultReviewerId: '',
    });
    // 振替元（表入力と同じ考え方。別の期間の申請は送る直前に確かめる）
    const originOf = isNewGridKind(base.kind)
      ? (furikaeOrigins.get(date) ?? others.find(o => o.draft.dayType === 'furikae_off' && o.draft.furikaeOriginDate === date)?.date ?? null)
      : null;
    let furikaeOriginNg = '';
    const o = draft.dayType === 'furikae_off' ? draft.furikaeOriginDate : '';
    if (o) {
      const ex = furikaeOrigins.get(o);
      const other = others.find(x => x.draft.dayType === 'furikae_off' && x.draft.furikaeOriginDate === o);
      const onOrigin = reports!.some(r => r.work_date === o && r.entry_type === 'manual' && r.status !== 'cancelled');
      if (ex && ex !== date) furikaeOriginNg = `振替元の日（${md(o)}）は、すでに ${md(ex)} の振替休日の振替元になっています`;
      else if (other) furikaeOriginNg = `振替元の日（${md(o)}）が、リストの ${md(other.date)} の振替休日と同じです`;
      else if (onOrigin) furikaeOriginNg = FURIKAE_ORIGIN_TAKEN_MSG;
    }
    const calc: GridRowCalc = computeGridRow({
      kind: base.kind, date, today, nowMin, advanceMaxDate, ns: base.ns, main: base.main, draft,
      defaultReviewerId: '', canSelfReview, selfId: userId,
      closeLocked: isPayPeriodClosed(date, today) && !grants.has(date), focused: false,
      reviewerIsManager, originOf, furikaeOriginNg, canChooseCalendar,
    });
    return { ...base, draft, calc, originOf, furikaeOriginNg };
  }, [ready, today, nowMin, advanceMaxDate, patterns, calendar, reports, requestByDate, furikaeOrigins, canSelfReview, userId, grants, reviewerIsManager, canChooseCalendar]);

  const rows = useMemo(() => items.map(it => {
    const others = items.filter(x => x.key !== it.key);
    return { key: it.key, row: makeRow(it.date, it.draft, others) };
  }), [items, makeRow]);
  type BoxRow = NonNullable<ReturnType<typeof makeRow>>;
  const reviewerNg = (r: BoxRow) => !r.calc.clockOnly && !reviewerAllowed(r.date, r.draft.reviewerId)
    ? 'この申請先は選べません（退職・役職の変更など）。［直す］で選び直してください' : '';
  const rowOk = (r: BoxRow | null, key?: string) => !!r && r.date >= winFrom && key !== input.editingKey && isNewGridKind(r.kind)
    && (r.calc.state === 'ok' || r.calc.state === 'warn') && !reviewerNg(r);
  const sendableRows = rows.filter(x => rowOk(x.row, x.key)).map(x => x.row!);
  // 上の枠：直している行は「ほかの行」に数えない（振替元の重なりの確かめで自分とぶつからないように）
  const inputRow = input.date ? makeRow(input.date, input.draft, items.filter(it => it.key !== input.editingKey)) : null;

  // ---- 上の青い枠 ----
  /** 日付を選んだとき：時間の申請で時刻が空なら、依頼の時間かその日の通常シフトを入れる（表入力の fillNormalIfEmpty と同じ）。依頼があれば申請先は依頼した人 */
  const fillFor = (date: string, d: RowDraft): Partial<RowDraft> => {
    if (!date || !ready) return {};
    const req = requestByDate.get(date) ?? null;
    const ns = resolveNormalShift(patterns!, date, calendar![date] ?? null);
    const patch: Partial<RowDraft> = {};
    if ((d.dayType ?? 'time') === 'time' && !d.segs.some(s => s.start || s.end)) {
      const reqSegs = (req?.segments ?? []).filter(x => x.start && x.end);
      if (reqSegs.length > 0) {
        patch.segs = reqSegs.slice(0, 3).map(x => ({ start: x.start, end: x.end }));
        const reqLoc = requestSegmentsLocation(reqSegs);
        if (!d.location && reqLoc) Object.assign(patch, locationPick(reqLoc, workplaces));
      } else {
        const segs = normalSegsOf(ns);
        patch.segs = segs.length > 0 ? segs : [{ start: '', end: '' }];
      }
    }
    if (!d.location && !patch.location) Object.assign(patch, locationPick(ns.location, workplaces));
    // 依頼がある日は依頼した人（1件フォーム・表入力と同じ）。🚨 本人が選び直した申請先は上書きしない
    if (req && !input.reviewerPicked) patch.reviewerId = req.requester_id;
    return patch;
  };
  const pickDate = (date: string) => {
    setAddError(''); setTried(false);
    const patch = fillFor(date, input.draft);
    setStore(s => ({ ...s, input: { date, draft: { ...s.input.draft, ...patch } } }));
  };
  /** 読んでいる範囲の外の日（古すぎる日）。🚨 この範囲の申請しか読んでいないので、外の日は同じ日の申請があるか分からない */
  const outOfWindow = (date: string) => !!date && date < winFrom;

  /** 種類の切り替え（表入力の switchDayType と同じ消し方） */
  const switchDayType = (t: GridDayType) => {
    const clearFurikae = t === 'furikae_off' ? {} : { furikaeOriginDate: '', furikaeOriginLocation: '', furikaeOriginLocationCustom: '', furikaeOriginStart: '', furikaeOriginEnd: '' };
    const clearClock = { clockInAt: '', clockOutAt: '', clockReason: '', clockReasonOther: '', ...clearFurikae };
    const clearTime = { segs: [{ start: '', end: '' }], breakMin: '', changeReason: '', lateChoice: null, earlyChoice: null, location: '', locationCustom: '', locMoveStart: '', locMoveEnd: '' };
    setTried(false);
    if (t === 'time') {
      // 時間に戻したら、日付があればシフト（または依頼）の時刻を入れ直す
      const next: RowDraft = { ...input.draft, dayType: 'time', ...clearClock, segs: [{ start: '', end: '' }], location: '', locationCustom: '', locMoveStart: '', locMoveEnd: '' };
      setInputDraft({ ...next, ...fillFor(input.date, next) });
    } else if (t === 'clock_only') setInputDraft({ dayType: 'clock_only', ...clearTime, ...clearFurikae, reason: '' });
    else setInputDraft({ dayType: t, ...clearTime, ...clearClock, ...(input.date && ready ? locationPick(resolveNormalShift(patterns!, input.date, calendar![input.date] ?? null).location, workplaces) : {}) });
  };

  const pickFurikaeOrigin = (d: string) => {
    if (!d) { setInputDraft({ furikaeOriginDate: '' }); return; }
    const pre = furikaeOriginPrefill(resolveNormalShift(patterns ?? [], d, null), workplaces);
    const auto = furikaeAutoRef.current;
    let times: Partial<RowDraft> = {};
    if (pre.start && pre.end) { times = { furikaeOriginStart: pre.start, furikaeOriginEnd: pre.end }; furikaeAutoRef.current = { start: pre.start, end: pre.end }; }
    else if (auto && auto.start === input.draft.furikaeOriginStart && auto.end === input.draft.furikaeOriginEnd) { times = { furikaeOriginStart: '', furikaeOriginEnd: '' }; furikaeAutoRef.current = null; }
    setInputDraft({ furikaeOriginDate: d, furikaeOriginLocation: pre.location, furikaeOriginLocationCustom: pre.locationCustom, ...times });
  };

  const addToList = () => {
    setTried(true);
    if (!input.date) { setAddError('日付を選んでください'); return; }
    if (outOfWindow(input.date)) { setAddError('この日は古すぎるため、ここからは出せません（管理者にご相談ください）'); return; }
    if (items.some(it => it.date === input.date && it.key !== input.editingKey)) { setAddError('この日はすでにリストにあります（直すときはリストの［直す］）'); return; }
    const r = inputRow;
    if (!r) { setAddError('読み込み中です。少し待ってからもう一度押してください'); return; }
    if (!isNewGridKind(r.kind)) { setAddError(kindNgMessage(r.kind, advanceMaxDate)); return; }
    const st = r.calc.state;
    if (st === 'empty') { setAddError('時間を入力してください'); return; }
    if (st === 'nochange' || st === 'error' || st === 'editing') { setAddError(r.calc.message || '入力を確かめてください'); return; }
    if (!r.calc.clockOnly && !reviewerAllowed(input.date, input.draft.reviewerId)) { setAddError('この申請先は選べません（退職・役職の変更など）。選び直してください'); return; }
    // ok・warn・locked（締め後＝許可待ち）は入れる。締め後はリストの上で許可を依頼できる
    // 🚨 直し中なら、その行を置き換える（並びの位置も同じ）
    setStore(s => {
      const editing = s.input.editingKey && s.items.some(it => it.key === s.input.editingKey) ? s.input.editingKey : null;
      const item = { key: editing ?? newKey(), date: s.input.date, draft: s.input.draft };
      // 次の1件の申請先は「本人が選んだ人」。依頼から自動で入った人（依頼した人）は覚えない
      const fromRequest = !s.input.reviewerPicked && requestByDate.get(s.input.date)?.requester_id === s.input.draft.reviewerId;
      const nextReviewer = fromRequest ? s.lastReviewerId : s.input.draft.reviewerId;
      return {
        items: editing ? s.items.map(it => (it.key === editing ? item : it)) : [...s.items, item],
        input: emptyInput(nextReviewer),
        lastReviewerId: nextReviewer,
      };
    });
    clearResult(input.date);
    setTried(false); setAddError(''); setBanner('');
    furikaeAutoRef.current = null;
  };

  const inputDirty = !!input.date || input.draft.segs.some(s => s.start || s.end) || input.draft.reason.trim() !== '';
  // 🚨 やめる・クリアしても、直していた元の1件はリストに残る（直し中の印が外れるだけ）
  const clearInput = () => { setStore(s => ({ ...s, input: emptyInput(s.lastReviewerId) })); setTried(false); setAddError(''); setBanner(''); setPending(null); };

  /** 複製：日付は空・振替元と打刻の時刻は写さない（ユーザー確定） */
  const copyItem = (it: BoxItem, force = false) => {
    if (inputDirty && !force) { setPending({ kind: 'copy', key: it.key }); return; }
    setPending(null);
    setStore(s => ({
      ...s,
      input: {
        date: '',
        draft: {
          ...it.draft,
          furikaeOriginDate: '', furikaeOriginLocation: '', furikaeOriginLocationCustom: '', furikaeOriginStart: '', furikaeOriginEnd: '',
          clockInAt: '', clockOutAt: '',
          // 申請先が候補に無い人（依頼した人など）なら、前回選んだ人にする（日付が変わると依頼した人は選べないため）
          reviewerId: it.draft.reviewerId === GRID_SELF_REVIEW || reviewers.some(rv => rv.id === it.draft.reviewerId) ? it.draft.reviewerId : s.lastReviewerId,
        },
        editingKey: null, reviewerPicked: true,
      },
    }));
    setTried(false); setAddError(''); setBanner('copy');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  /**
   * 直す：その行の中身を上の枠に入れる。🚨 行はリストに残したまま「直し中」にする（途中でやめても消えない・2026-09-29 レビュー指摘）。
   * 「追加」で置き換わる。入力中の内容があれば先に確かめる
   */
  const editItem = (it: BoxItem, force = false) => {
    if (inputDirty && input.editingKey !== it.key && !force) { setPending({ kind: 'edit', key: it.key }); return; }
    setStore(s => ({ ...s, input: { date: it.date, draft: it.draft, editingKey: it.key, reviewerPicked: true } }));
    clearResult(it.date);
    setPending(null); setTried(true); setAddError(''); setBanner('edit');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const removeItem = (key: string) => {
    const it = items.find(x => x.key === key);
    if (it) clearResult(it.date);
    setStore(s => ({
      ...s, items: s.items.filter(x => x.key !== key),
      // 直し中の行を消したら、上の枠は「新しい1件」として残す
      input: s.input.editingKey === key ? { ...s.input, editingKey: null } : s.input,
    }));
  };

  // ---- 送信 ----
  const [confirm, setConfirm] = useState<{ date: string; label: string }[] | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [rowResults, setRowResults] = useState<Record<string, { status: BulkRowStatus; message: string }>>({});
  // 前の送信の結果は、その日を直す・消す・追加し直すときに消す（古い結果が今の理由を隠さないように）
  const clearResult = (date: string) => setRowResults(prev => { if (!prev[date]) return prev; const n = { ...prev }; delete n[date]; return n; });
  const [doneBanner, setDoneBanner] = useState<{ ok: number; problems: number } | null>(null);
  const [gcalFailed, setGcalFailed] = useState<string[]>([]);
  useEffect(() => {
    if (!doneBanner) return;
    const t = setTimeout(() => setDoneBanner(null), 4000);
    return () => clearTimeout(t);
  }, [doneBanner]);
  const confirmRef = useScrollIntoViewWhen<HTMLDivElement>(confirm);
  useEffect(() => {
    if (!sending) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [sending]);

  const doSend = async () => {
    if (!confirm || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    const targets = confirm;
    setConfirm(null);
    setRowResults(Object.fromEntries(targets.map(t => [t.date, { status: 'waiting' as BulkRowStatus, message: '' }])));
    // 🚨 送信の流れは表入力と同じ runBulkSend。行は日付で引く（箱に同じ日は入らない）
    const byDate = new Map(rows.filter(x => x.row).map(x => [x.row!.date, x.row!]));
    const result = await runBulkSend(
      targets,
      date => byDate.get(date),
      { userId, profileName: profileName ?? '', canSelfReview, advanceMaxDate, grants, now: () => new Date(), today: todayJstStr, reviewerIsManager, canChooseCalendar },
      supabaseBulkWriter,
      (date, status, message) => setRowResults(prev => ({ ...prev, [date]: { status, message } })),
      () => {},
    );
    // 送れた日は箱から消す（送れなかった・確認が要る日は理由を付けて残す）。
    // 🚨 送信中に別のタブへ移って画面が閉じていても消えるよう、端末の保存も直接直す
    const sent = new Set(result.sentDates);
    const after = { ...storeRef.current, items: storeRef.current.items.filter(it => !sent.has(it.date)) };
    saveDraft(storeKey, after);
    setStore(s => ({ ...s, items: s.items.filter(it => !sent.has(it.date)) }));
    setGcalFailed(result.gcalFailedIds);
    if (result.ok > 0) setDoneBanner({ ok: result.ok, problems: result.failed + result.check });
    setSending(false);
    sendingRef.current = false;
    await load();
    if (result.ok > 0) onSent();
  };

  // ---- 表の上の合計（今期だけ。表入力と同じ gridBalance） ----
  const periodSet = useMemo(() => new Set(periodDates(period)), [period]);
  const balance = reports ? gridBalance(reports.filter(r => periodSet.has(r.work_date)), period,
    sendableRows.filter(r => periodSet.has(r.date)).map(r => ({ main: r.main, isEdit: false, date: r.date, diffMin: r.calc.diffMin, applicationTypes: r.calc.applicationTypes }))) : null;
  const sendInPeriod = sendableRows.filter(r => periodSet.has(r.date)).length;

  // ---- 締め後の許可の依頼（表入力と同じ枠） ----
  const lockedDates = rows.filter(x => x.row && x.row.calc.state === 'locked').map(x => x.row!.date);
  const openGrantDates = new Set(grantRequests.filter(g => g.status === 'open').flatMap(g => g.work_dates));
  const itemDates = new Set(items.map(it => it.date));
  const touches = (g: GrantRequestRow) => g.work_dates.some(d => itemDates.has(d));
  const openGrantReqs = grantRequests.filter(g => g.status === 'open' && touches(g));
  const declinedGrantReqs = grantRequests.filter(g => g.status === 'declined' && touches(g)
    && !g.work_dates.some(d => openGrantDates.has(d)) && !g.work_dates.every(d => grants.has(d)));
  const payoutPassedOf = (d: string) => isPayPeriodPayoutPassed(d, today, closedDates);
  const requestable = lockedDates.filter(d => !openGrantDates.has(d) && !payoutPassedOf(d) && !outOfWindow(d));
  const payoutPassedAll = lockedDates.length > 0 && requestable.length === 0 && lockedDates.some(payoutPassedOf);
  const grantedDates = items.map(it => it.date).filter(d => isPayPeriodClosed(d, today) && grants.has(d));

  // ---- styles（残業ページ・交通費の箱と同じ配色） ----
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const borderColor = isDark ? '#495057' : '#dee2e6';
  const innerBg = isDark ? '#2b3035' : '#f8f9fa';
  const inputBg = isDark ? '#495057' : '#fff';
  const toggleBlue = '#1976d2';
  const toggleText = isDark ? '#90caf9' : '#1565c0';
  const toggleBg = isDark ? '#1e3a5f' : '#e3f2fd';
  const warnText = isDark ? '#f0c36d' : '#b8860b';
  // 🚨 文字の入力欄は16px以上（iOS は16px未満の欄にふれるとページを拡大する）
  const fld: React.CSSProperties = { width: '100%', boxSizing: 'border-box', border: `1px solid ${borderColor}`, background: inputBg, color: text, borderRadius: 6, padding: '8px 10px', fontSize: 16 };
  const lbl: React.CSSProperties = { display: 'block', fontSize: 12, color: subText, margin: '10px 0 4px' };
  const chip = (on: boolean): React.CSSProperties => ({
    padding: '6px 10px', borderRadius: 16, border: `1px solid ${on ? toggleBlue : borderColor}`, cursor: 'pointer', fontSize: 13,
    background: on ? toggleBlue : inputBg, color: on ? '#fff' : text,
  });
  const smBtn = (bg: string): React.CSSProperties => ({ background: bg, color: '#fff', border: 'none', borderRadius: 4, padding: '8px 10px', fontSize: 12.5, cursor: 'pointer', flexShrink: 0 });
  // 確認を開いている間・送信中は、リストと上の枠を触らせない（確認で見せた内容と送る内容がずれないように）
  const busy = sending || !!confirm;
  const req = <span style={{ color: '#dc3545' }}> *</span>;
  const typesText = (types: readonly string[] | null, situation?: SituationLike | null) =>
    (types ?? []).filter(isOvertimeType).map(t => typeLabelFor(t, situation)).join('・');

  const d = input.draft;
  const c = inputRow?.calc ?? null;
  const dayType = d.dayType ?? 'time';
  const inputNg = inputRow && !isNewGridKind(inputRow.kind) ? kindNgMessage(inputRow.kind, advanceMaxDate) : '';
  const managersOnly = dayType === 'absence';

  /** 1件の中身（一覧と確認で同じ文字） */
  const itemSummary = (r: BoxRow) => {
    if (r.calc.clockOnly) return <>残業ではありません（打刻が遅れただけ）・理由「{effectiveClockReasonOf(r.draft.clockReason ?? '', r.draft.clockReasonOther ?? '')}」</>;
    if (r.calc.fullDayType) return <>終日 {r.calc.fullDayType === 'absence' ? '欠勤1日' : <b style={{ color: diffColor(r.calc.diffMin, isDark) }}>{formatSignedMin(r.calc.diffMin)}</b>}</>;
    const segs = [...r.calc.workSegments].sort((a, b) => a.startMin - b.startMin).map(s => `${minToTime(s.startMin)}〜${minToTime(s.endMin)}`).join(' / ');
    return <>{segs} <b style={{ color: diffColor(r.calc.diffMin, isDark) }}>{formatSignedMin(r.calc.diffMin)}</b></>;
  };
  const reviewerName = (id: string) => id === GRID_SELF_REVIEW ? '自己受理' : (nameOfReviewer(id) ?? '（申請先）');

  return (
    <div style={{ color: text }}>
      {errors.length > 0 && (
        <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: '#842029', marginBottom: 10 }}>
          読み込めなかったものがあります。読み直してから送ってください。
          {errors.map(e => <div key={e}>・{e}</div>)}
          <button type="button" onClick={() => { void load(); }} style={{ ...smBtn('#dc3545'), marginTop: 6 }}>再読み込み</button>
        </div>
      )}

      {reqErr && <div style={{ background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, color: '#856404', marginBottom: 8 }}>{reqErr}</div>}
      {/* 【注意事項】は［事前申請・事後報告］と同じ部品。先頭にこの画面の使い方を入れる（2026-09-29 ユーザー指示） */}
      <OvertimeNotes isDark={isDark} advanceMaxDate={advanceMaxDate} cardBg={isDark ? '#343a40' : '#fff'} leadItems={[
        <>1日分ずつ入れて［＋ 申請リストに追加］→ 最後に［申請する］で送信します。<b>［申請する］を押すまでは送信されません。</b>2件目からは［複製］で日付と時間だけ変えると早いです。</>,
        <>入れた内容は<b>この端末にだけ</b>保存されます（別のスマホやパソコンには出ません）。</>,
        <>申請済みの日・締め切り後の日など、送れない日は赤く表示され、送信されません。</>,
        <>実績報告・差し戻しの再提出・内容の修正は「履歴・実績報告」タブから1件ずつ行ってください。</>,
      ]} />

      {banner && (
        <div style={{ background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 6, padding: '8px 12px', marginBottom: 8, fontSize: 13, color: '#856404' }}>
          {banner === 'copy' ? '📋 複製を適用中（日付を選んで「追加」してください）' : input.editingKey
            ? <>✏️ リストの1件を直しています（「追加」で置き換わります）<button type="button" onClick={clearInput} style={{ marginLeft: 8, background: 'none', border: 'none', color: '#856404', textDecoration: 'underline', cursor: 'pointer', fontSize: 13 }}>やめる</button></>
            : '✏️ リストの1件を直しています'}
        </div>
      )}
      {pending && (
        <div style={{ background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: '#856404', marginBottom: 8 }}>
          上の枠に入力中の内容があります。消して、{pending.kind === 'copy' ? 'この行を複製' : 'この行を直'}しますか？{input.editingKey ? '（直していた元の1件はリストに残ります）' : ''}
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button type="button" style={smBtn('#dc3545')} onClick={() => {
              const it = items.find(x => x.key === pending.key);
              if (it) { if (pending.kind === 'copy') copyItem(it, true); else editItem(it, true); } else setPending(null);
            }}>消して{pending.kind === 'copy' ? '複製する' : '直す'}</button>
            <button type="button" style={smBtn('#6c757d')} onClick={() => setPending(null)}>やめる</button>
          </div>
        </div>
      )}

      {/* ===== 上の青い枠（1日分） ===== */}
      <div style={{ border: '2px solid #0d6efd', borderRadius: 10, padding: 12, marginBottom: 10, background: isDark ? '#2c3e50' : '#fff' }}>
        {inputDirty && (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" onClick={clearInput} style={{ background: 'none', border: 'none', color: subText, fontSize: 12, textDecoration: 'underline', cursor: 'pointer' }}>入力内容をクリア</button>
          </div>
        )}
        <label style={{ ...lbl, marginTop: 0 }}>日付{req}</label>
        <input type="date" value={input.date} min={winFrom} max={advanceMaxDate} onChange={e => pickDate(e.target.value)} style={fld} aria-label="日付" />
        {inputRow && (
          <div style={{ background: toggleBg, color: toggleText, borderRadius: 8, padding: '7px 10px', fontSize: 12.5, marginTop: 6, lineHeight: 1.6 }}>
            通常シフト {normalShiftTimeText(inputRow.ns) || '休み'}{inputRow.ns.location ? `（${inputRow.ns.location}）` : ''}
            {inputNg ? <div style={{ color: '#e24b4a', fontWeight: 'bold' }}>{inputNg}</div>
              : <div>→ この日は <b>{c?.mode === 'advance' ? '事前申請' : '事後報告'}</b> になります{inputRow.kind === 'new_today' && dayType === 'time' ? '（今日は、入れた開始時刻がいまより前なら事後報告）' : ''}</div>}
            {inputRow.req && <div>📩 {inputRow.req.requester_name ?? '上長'}さんから申請の依頼{inputRow.req.memo ? `「${inputRow.req.memo}」` : ''}</div>}
            {inputRow.originOf && <div style={{ color: '#e24b4a' }}>この日は {md(inputRow.originOf)} の振替休日の振替元です</div>}
          </div>
        )}

        <label style={lbl}>種類</label>
        <select value={dayType} onChange={e => switchDayType(e.target.value as GridDayType)} style={fld} aria-label="種類">
          {gridDayTypeOptions(inputRow?.kind ?? 'new_post', inputRow?.ns ?? { day_kind: 'mon', calendar_kind: null, start_time: '09:00', end_time: '18:00', break_minutes: 0, labor_minutes: 0 }).map(o => (
            <option key={o.value} value={o.value} disabled={!!o.disabledReason}>{o.label}{o.disabledReason ? `（${o.disabledReason}）` : ''}</option>
          ))}
        </select>

        {dayType === 'time' && (
          <>
            <label style={lbl}>勤務時間{req}</label>
            {d.segs.map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <TimeInput value={s.start} isDark={isDark} advance ariaLabel={`勤務${i + 1} 開始`} style={{ flex: 1, minWidth: 0 }}
                  onChange={v => setInputDraft({ segs: d.segs.map((x, j) => (j === i ? { ...x, start: v } : x)) })} />
                <span>〜</span>
                <TimeInput value={s.end} isDark={isDark} ariaLabel={`勤務${i + 1} 終了`} style={{ flex: 1, minWidth: 0 }}
                  onChange={v => setInputDraft({ segs: d.segs.map((x, j) => (j === i ? { ...x, end: v } : x)) })} />
                {i > 0 && <button type="button" onClick={() => setInputDraft({ segs: d.segs.filter((_, j) => j !== i) })} style={{ ...chip(false), padding: '4px 8px' }} aria-label="この時間帯を消す">✕</button>}
              </div>
            ))}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5, color: subText }}>
              {d.segs.length < 3 && <button type="button" style={{ ...chip(false), padding: '4px 10px', fontSize: 12 }} onClick={() => setInputDraft({ segs: [...d.segs, { start: '', end: '' }] })}>＋ 時間帯</button>}
              {c && c.workSegments.length > 0 && <span>休憩 {formatMin(c.breakMin)}{d.breakMin ? '（手入力）' : '（自動）'}・労働 {formatMin(c.laborMin)}・<b style={{ color: diffColor(c.diffMin, isDark) }}>{formatSignedMin(c.diffMin)}</b></span>}
            </div>
            <label style={lbl}>休憩（分）<span style={{ fontSize: 11, marginLeft: 8 }}>空＝自動</span></label>
            <input type="text" inputMode="numeric" value={d.breakMin} placeholder={c ? `自動 ${c.breakMin}` : '自動'} style={fld} aria-label="休憩（分）"
              onChange={e => setInputDraft({ breakMin: e.target.value.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, '') })} />
            {c && !c.legalOk && <div style={{ fontSize: 12, color: warnText, fontWeight: 'bold', marginTop: 4 }}>⚠️ 休憩が法定より短い（送れます）</div>}
            {c?.typeDetect.lateQ && (
              <>
                <label style={lbl}>開始が遅い理由{req}</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {LATE_CHOICES.map(o => <button key={o.value} type="button" style={chip(d.lateChoice === o.value)} onClick={() => setInputDraft({ lateChoice: o.value })}>{o.label}</button>)}
                </div>
              </>
            )}
            {c?.typeDetect.earlyQ && (
              <>
                <label style={lbl}>早く終わる理由{req}</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {EARLY_CHOICES.map(o => <button key={o.value} type="button" style={chip(d.earlyChoice === o.value)} onClick={() => setInputDraft({ earlyChoice: o.value })}>{o.label}</button>)}
                </div>
              </>
            )}
            {c && c.applicationTypes.length > 0 && <div style={{ fontSize: 12, color: subText, marginTop: 6 }}>種別：{typesText(c.applicationTypes, { late_situation: d.lateChoice, early_situation: d.earlyChoice })}</div>}
            <label style={lbl}>勤務地{req}</label>
            <select value={d.location} onChange={e => setInputDraft({ location: e.target.value })} style={fld} aria-label="勤務地">
              <option value="">選択してください</option>
              {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
              <option value="移動あり">移動あり（校が変わる）</option>
              <option value="その他">その他</option>
            </select>
            {d.location === 'その他' && <input type="text" value={d.locationCustom} placeholder="勤務地" onChange={e => setInputDraft({ locationCustom: e.target.value })} style={{ ...fld, marginTop: 6 }} aria-label="勤務地（その他）" />}
            {d.location === '移動あり' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                <select value={d.locMoveStart ?? ''} onChange={e => setInputDraft({ locMoveStart: e.target.value })} style={fld} aria-label="移動元の校">
                  <option value="">移動元の校</option>{workplaces.map(w => <option key={w} value={w}>{w}</option>)}
                </select>
                <span style={{ fontWeight: 'bold', color: subText }}>→</span>
                <select value={d.locMoveEnd ?? ''} onChange={e => setInputDraft({ locMoveEnd: e.target.value })} style={fld} aria-label="移動先の校">
                  <option value="">移動先の校</option>{workplaces.map(w => <option key={w} value={w}>{w}</option>)}
                </select>
              </div>
            )}
          </>
        )}

        {(dayType === 'chosei_off' || dayType === 'furikae_off' || dayType === 'absence') && inputRow && (
          <div style={{ background: innerBg, borderRadius: 8, padding: '8px 10px', fontSize: 12.5, marginTop: 8, lineHeight: 1.6 }}>
            {dayType === 'chosei_off' && <>シフト労働分 <b style={{ color: diffColor(c?.diffMin ?? 0, isDark) }}>{formatSignedMin(c?.diffMin ?? 0)}</b> を合計時間数から差し引きます</>}
            {dayType === 'absence' && '欠勤1日として記録します'}
            {dayType === 'furikae_off' && (c?.furikae?.hasTime
              ? <>振替元の労働 {formatMin(c.furikae.laborMin)} − 休む日の労働 {formatMin(inputRow.ns.labor_minutes)} ＝ 合計時間数 <b style={{ color: diffColor(c.diffMin, isDark) }}>{formatSignedMin(c.diffMin)}</b></>
              : '下で振替元の出勤時刻を入れると、合計時間数への反映（差分）が計算されます')}
            {inputRow.ns.location
              ? <div style={{ color: subText, marginTop: 4 }}>勤務地：{inputRow.ns.location}（シフトから自動）</div>
              : (
                <>
                  <label style={lbl}>勤務地{req}</label>
                  <select value={d.location} onChange={e => setInputDraft({ location: e.target.value })} style={fld} aria-label="勤務地">
                    <option value="">選択してください</option>
                    {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
                    <option value="その他">その他</option>
                  </select>
                  {d.location === 'その他' && <input type="text" value={d.locationCustom} placeholder="勤務地" onChange={e => setInputDraft({ locationCustom: e.target.value })} style={{ ...fld, marginTop: 6 }} aria-label="勤務地（その他）" />}
                </>
              )}
          </div>
        )}

        {dayType === 'furikae_off' && (
          <div style={{ borderLeft: `3px solid ${toggleBlue}`, paddingLeft: 10, marginTop: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 'bold' }}>① 実際に出勤した日（振替元）</div>
            <div style={{ background: '#fff3cd', border: '1px solid #ffe0a3', borderRadius: 8, padding: '6px 10px', margin: '6px 0', fontSize: 11.5, color: '#856404', lineHeight: 1.6 }}>
              ※ 出勤した日（振替元）は、ここに時刻を入れて記録します。<b>別途「休日出勤」として申請しないでください</b>（二重計上になります）。
            </div>
            <label style={lbl}>振替元の勤務日{req}</label>
            <input type="date" value={d.furikaeOriginDate ?? ''} onChange={e => pickFurikaeOrigin(e.target.value)} style={fld} aria-label="振替元の勤務日" />
            <label style={lbl}>振替元の勤務校{req}</label>
            <select value={d.furikaeOriginLocation ?? ''} onChange={e => setInputDraft({ furikaeOriginLocation: e.target.value })} style={fld} aria-label="振替元の勤務校">
              <option value="">選択してください</option>
              {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
              <option value="その他">その他（自由入力）</option>
            </select>
            {d.furikaeOriginLocation === 'その他' && <input type="text" value={d.furikaeOriginLocationCustom ?? ''} placeholder="勤務校・場所を入力してください" onChange={e => setInputDraft({ furikaeOriginLocationCustom: e.target.value })} style={{ ...fld, marginTop: 6 }} aria-label="振替元の勤務校（その他）" />}
            <label style={lbl}>振替元の勤務時間{req}</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <TimeInput value={d.furikaeOriginStart ?? ''} onChange={v => setInputDraft({ furikaeOriginStart: v })} isDark={isDark} advance ariaLabel="振替元 開始時刻" style={{ flex: 1, minWidth: 0 }} />
              <span>〜</span>
              <TimeInput value={d.furikaeOriginEnd ?? ''} onChange={v => setInputDraft({ furikaeOriginEnd: v })} isDark={isDark} ariaLabel="振替元 終了時刻" style={{ flex: 1, minWidth: 0 }} />
            </div>
            {c?.furikae?.hasTime && <div style={{ fontSize: 12, color: subText, marginTop: 4 }}>休憩 {formatMin(c.furikae.breakMin)}（自動）・労働 {formatMin(c.furikae.laborMin)}</div>}
            {!!c?.furikae?.date && c.furikae.date < today && (
              <div style={{ background: '#fff3cd', border: '1px solid #ffe0a3', borderRadius: 8, padding: '6px 10px', marginTop: 6, fontSize: 11.5, color: '#856404' }}>振替休日は、休日に出勤する前の申請が原則です。今後は事前にお願いします。</div>
            )}
          </div>
        )}

        {dayType === 'clock_only' && (
          <>
            <div style={{ background: innerBg, borderRadius: 8, padding: '8px 10px', fontSize: 12.5, color: subText, marginTop: 8, lineHeight: 1.6 }}>
              勤務時間はシフトどおりとして記録します。合計時間数は増えも減りもしません。
            </div>
            <label style={lbl}>打刻の時刻<span style={{ fontSize: 11 }}>（分かれば・任意）</span></label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, color: subText }}>出勤</span>
              <TimeInput value={d.clockInAt ?? ''} onChange={v => setInputDraft({ clockInAt: v })} isDark={isDark} advance ariaLabel="出勤の打刻時刻" style={{ flex: 1, minWidth: 0 }} />
              <span style={{ fontSize: 12, color: subText }}>退勤</span>
              <TimeInput value={d.clockOutAt ?? ''} onChange={v => setInputDraft({ clockOutAt: v })} isDark={isDark} ariaLabel="退勤の打刻時刻" style={{ flex: 1, minWidth: 0 }} />
            </div>
            <label style={lbl}>打刻が遅くなった理由{req}</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {CLOCK_ONLY_REASONS.map(x => <button key={x} type="button" style={{ ...chip(d.clockReason === x), borderRadius: 10, textAlign: 'left' }} onClick={() => setInputDraft({ clockReason: x })}>{x}</button>)}
            </div>
            {d.clockReason === 'その他' && <input type="text" value={d.clockReasonOther ?? ''} placeholder="例：迎えを待っていた" onChange={e => setInputDraft({ clockReasonOther: e.target.value })} style={{ ...fld, marginTop: 6 }} aria-label="打刻が遅くなった理由（その他）" />}
            {/* 🚨 この枠は絶対に外さない（1件フォーム・表入力と同じ）。黄色の固定色 */}
            <div style={{ background: '#fff3cd', border: '1px solid #ffe0a3', borderRadius: 8, padding: '8px 10px', marginTop: 8 }}>
              <p style={{ margin: 0, fontSize: 12.5, color: '#664d03', lineHeight: 1.7 }}>
                ⚠️ 片付け・準備・保護者対応など、<b>仕事をしていた時間は残業です</b>。その場合はこの画面ではなく、残業として報告してください。
              </p>
              <button type="button" onClick={() => switchDayType('time')}
                style={{ marginTop: 6, background: '#fff', border: '1px solid #856404', borderRadius: 8, cursor: 'pointer', padding: '6px 12px', fontSize: 12.5, fontWeight: 'bold', color: '#856404' }}>
                残業として報告する →
              </button>
            </div>
          </>
        )}

        {dayType !== 'clock_only' && (
          <>
            <label style={lbl}>理由{req}</label>
            <input type="text" value={d.reason} onChange={e => setInputDraft({ reason: e.target.value })} style={fld} aria-label="理由" />
          </>
        )}

        {c?.offerCalendar && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 13.5, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!d.showOnCalendar} onChange={e => setInputDraft({ showOnCalendar: e.target.checked })} style={{ width: 18, height: 18 }} />
            📅 みんなのカレンダーに表示
          </label>
        )}
        {c?.offerCalendar && <div style={{ fontSize: 11.5, color: subText }}>ほかの人のシフトに関係する予定だけチェックしてください（在宅や一人で残る残業は不要）</div>}
        {c?.offerCalendar && !d.showOnCalendar && c.applicationTypes.some(t => t === 'location_change' || t === 'holiday_work') && (
          <div style={{ fontSize: 12, color: warnText, marginTop: 4 }}>⚠️ 勤務する場所が変わる予定ですが、カレンダーに表示しない設定になっています</div>
        )}

        {dayType !== 'clock_only' && (
          <>
            <label style={lbl}>申請先{req}</label>
            <select value={d.reviewerId} style={fld} aria-label="申請先"
              onChange={e => { const v = e.target.value; setStore(s => ({ ...s, input: { ...s.input, reviewerPicked: true, draft: { ...s.input.draft, reviewerId: v } } })); }}>
              <option value="">選択してください</option>
              {/* 候補に無い申請先（依頼した人が候補外・前に選んだ人が退職 等）も名前を出す。🚨 空に見せて黙って送らない */}
              {d.reviewerId && d.reviewerId !== GRID_SELF_REVIEW && !reviewers.some(rv => rv.id === d.reviewerId) && (
                <option value={d.reviewerId}>{nameOfReviewer(d.reviewerId) ?? '（申請先）'}{requestByDate.get(input.date)?.requester_id === d.reviewerId ? '（依頼した人）' : '（選べません）'}</option>
              )}
              {canSelfReview && <option value={GRID_SELF_REVIEW}>自己受理（自分で確認する）</option>}
              {reviewers.filter(rv => rv.id !== userId).filter(rv => !managersOnly || isManagerReviewer(rv) || rv.id === d.reviewerId)
                .map(rv => <option key={rv.id} value={rv.id}>{rv.name}（{rv.role_title}）</option>)}
            </select>
            {managersOnly && <div style={{ fontSize: 11.5, color: subText, marginTop: 2 }}>欠勤はマネージャー以上の受理が必要です</div>}
          </>
        )}

        {(addError || (tried && c && c.message && (c.state === 'error' || c.state === 'nochange'))) && (
          <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '8px 10px', marginTop: 10, fontSize: 13, color: '#842029' }}>
            ⚠️ {addError || c?.message}
          </div>
        )}
        {c?.state === 'locked' && <div style={{ fontSize: 12, color: subText, marginTop: 8 }}>締め切り後の日です。リストに入れると、下の枠から経理に許可を依頼できます</div>}

        <button type="button" onClick={addToList} disabled={busy}
          style={{ width: '100%', marginTop: 12, padding: 11, background: '#0d6efd', color: '#fff', border: 'none', borderRadius: 6, fontSize: 15, fontWeight: 'bold', cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>
          {input.editingKey ? '✓ 直した内容でリストに戻す' : '＋ 申請リストに追加'}
        </button>
      </div>

      {/* ===== 締め後の許可の依頼（表入力と同じ枠） ===== */}
      {(lockedDates.length > 0 || openGrantReqs.length > 0) && (
        <OvertimeGrantPanel
          userId={userId} profileName={profileName ?? ''} isDark={isDark}
          requestable={requestable} openRequests={openGrantReqs} declinedRequests={declinedGrantReqs}
          grantedDates={grantedDates} payoutPassed={payoutPassedAll} loadError={grantReqErr}
          onReload={() => { void loadGrantState(); }}
        />
      )}

      {/* ===== 追加済みリスト ===== */}
      {items.length > 0 && (
        <>
          <hr style={{ border: 'none', borderTop: `1px dashed ${borderColor}`, margin: '14px 0 8px' }} />
          <div style={{ fontSize: 12.5, color: subText }}>✅ 追加済み（{items.length}件）<span style={{ fontSize: 11.5, marginLeft: 8 }}>複製を押すと上の入力欄に入ります</span></div>
          <div style={{ height: 6 }} />
          {[...rows].sort((a, b) => (items.find(x => x.key === a.key)?.date ?? '').localeCompare(items.find(x => x.key === b.key)?.date ?? '')).map(({ key, row }, i) => {
            const it = items.find(x => x.key === key)!;
            const ok = rowOk(row, key);
            const isEditing = key === input.editingKey;
            const res = rowResults[it.date];
            const ng = !row ? '読み込み中…' : outOfWindow(it.date) ? '古すぎる日です（削除してください）' : !isNewGridKind(row.kind) ? kindNgMessage(row.kind, advanceMaxDate)
              : row.calc.state === 'locked' ? '締め切り後です（上の枠から経理に許可を依頼）'
              : reviewerNg(row) ? reviewerNg(row)
              : isEditing ? ''
              : !ok ? (row.calc.message || '入力を確かめてください') : '';
            return (
              <div key={key} style={{
                display: 'flex', gap: 6, alignItems: 'center', padding: 8, marginBottom: 6, borderRadius: 6, fontSize: 13,
                background: isDark ? '#2c3e50' : '#f8fbff', border: `1px solid ${isDark ? '#344a5e' : '#cfe2ff'}`,
                borderLeft: `3px solid ${ng ? '#e24b4a' : isEditing ? '#ffc107' : '#0d6efd'}`,
              }}>
                <span style={{ background: innerBg, borderRadius: 4, padding: '2px 7px', fontWeight: 'bold', fontSize: 12, flexShrink: 0 }}>{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11.5, color: subText }}>
                    {dayLabel(it.date)} {row ? row.calc.sendLabel : ''}
                    {row && row.calc.applicationTypes.length > 0 && !row.calc.fullDayType && !row.calc.clockOnly ? `・${typesText(row.calc.applicationTypes, { late_situation: it.draft.lateChoice, early_situation: it.draft.earlyChoice })}` : ''}
                    {row?.calc.effectiveLocation ? `・${row.calc.effectiveLocation}` : ''}
                    {row?.calc.offerCalendar && it.draft.showOnCalendar ? '　📅' : ''}
                  </div>
                  {row && <div style={{ fontSize: 14 }}>{itemSummary(row)}</div>}
                  {it.draft.reason && !row?.calc.clockOnly && <div style={{ fontSize: 11.5, color: subText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.draft.reason}</div>}
                  {isEditing && <div style={{ fontSize: 11.5, color: '#856404', fontWeight: 'bold' }}>✏️ 直し中（上の枠で直して「戻す」／やめると元のまま）</div>}
                  {ng && !res && <div style={{ fontSize: 11.5, color: '#e24b4a', fontWeight: 'bold' }}>{ng}</div>}
                  {res && res.status !== 'sent' && (
                    <div style={{ fontSize: 11.5, fontWeight: 'bold', color: res.status === 'check' ? warnText : res.status === 'failed' ? '#e24b4a' : subText }}>
                      {res.status === 'waiting' ? '送信待ち' : res.status === 'sending' ? '送信中…' : res.status === 'check' ? `要確認：${res.message}` : `送れませんでした：${res.message}`}
                    </div>
                  )}
                </div>
                {!busy && (
                  <>
                    <button type="button" onClick={() => copyItem(it)} style={smBtn('#6c757d')}>複製</button>
                    <button type="button" onClick={() => editItem(it)} style={smBtn('#1976d2')}>直す</button>
                    <button type="button" onClick={() => removeItem(key)} style={smBtn('#dc3545')}>削除</button>
                  </>
                )}
              </div>
            );
          })}
        </>
      )}

      {/* ===== 今期の合計（表入力と同じ計算） ===== */}
      {balance && (
        <div style={{ background: innerBg, borderRadius: 8, padding: '8px 10px', fontSize: 12.5, margin: '8px 0', lineHeight: 1.7 }}>
          今期の合計 <span style={{ marginLeft: 6 }}>確定</span> <b style={{ color: diffColor(balance.now.total, isDark) }}>{formatSignedMin(balance.now.total)}</b>
          ／見込み <b style={{ color: diffColor(balance.now.plannedTotal, isDark) }}>{formatSignedMin(balance.now.plannedTotal)}</b>
          {sendInPeriod > 0 && (
            <div>このリストを送ると → <b style={{ fontSize: 15, color: diffColor(balance.after.plannedTotal, isDark) }}>{formatSignedMin(balance.after.plannedTotal)}</b>
              <span style={{ color: subText }}>（{formatSignedMin(balance.after.plannedTotal - balance.now.plannedTotal)}）</span></div>
          )}
        </div>
      )}

      {!confirm && (
        <button type="button" disabled={sending || sendableRows.length === 0 || errors.length > 0}
          onClick={() => setConfirm(sendableRows.map(r => ({ date: r.date, label: r.calc.sendLabel })))}
          style={{
            width: '100%', padding: 12, marginTop: 6, border: 'none', borderRadius: 6, fontSize: 15, fontWeight: 'bold', color: '#fff',
            background: sending || sendableRows.length === 0 ? '#6c757d' : '#007bff', opacity: sending || sendableRows.length === 0 ? 0.6 : 1,
            cursor: sending || sendableRows.length === 0 ? 'not-allowed' : 'pointer',
          }}>
          {sending ? '送信中…' : `申請する${sendableRows.length > 0 ? `（${sendableRows.length}件）` : ''}`}
        </button>
      )}
      {items.length > sendableRows.length && !sending && (
        <div style={{ fontSize: 11.5, color: subText, marginTop: 4 }}>※ 赤い行は送りません。直すか削除すると数に入ります</div>
      )}

      {/* ===== 送る前の確認（表入力と同じ：申請先ごと） ===== */}
      {confirm && (() => {
        const list = confirm.map(t => sendableRows.find(r => r.date === t.date)).filter((r): r is BoxRow => !!r);
        const groups = new Map<string, BoxRow[]>();
        list.forEach(r => {
          const k = r.calc.clockOnly ? CLOCK_GROUP : r.calc.isSelfReview ? GRID_SELF_REVIEW : r.calc.reviewerId;
          groups.set(k, [...(groups.get(k) ?? []), r]);
        });
        return (
          <div ref={confirmRef} style={{ border: `2px solid ${toggleBlue}`, borderRadius: 10, padding: '12px 12px', marginTop: 12 }}>
            <b style={{ fontSize: 15 }}>送る前の確認（{list.length}件）</b>
            {[...groups.entries()].map(([k, rs]) => (
              <div key={k} style={{ border: `1px solid ${borderColor}`, borderRadius: 8, padding: '8px 10px', margin: '8px 0', fontSize: 13, lineHeight: 1.7 }}>
                <div style={{ fontWeight: 'bold' }}>
                  {k === CLOCK_GROUP ? <>打刻ズレの記録（{rs.length}件）<span style={{ color: '#c62828' }}> 確認なしで、記録した時点で確定します</span></>
                    : k === GRID_SELF_REVIEW ? <>自己受理（{rs.length}件）<span style={{ color: '#c62828' }}> 送った時点で確定します</span></>
                    : <>{reviewerName(k)} さん宛（{rs.length}件）</>}
                </div>
                {rs.sort((a, b) => a.date.localeCompare(b.date)).map(r => (
                  <div key={r.date}>
                    <b>{dayLabel(r.date)}</b> {r.calc.sendLabel}{r.req ? '（依頼に答える）' : ''}：{itemSummary(r)}
                    {!r.calc.clockOnly && !r.calc.fullDayType && r.calc.applicationTypes.length > 0 && <> {typesText(r.calc.applicationTypes, { late_situation: r.draft.lateChoice, early_situation: r.draft.earlyChoice })}</>}
                    {!r.calc.clockOnly && <> 「{r.draft.reason.trim()}」</>}
                    {r.calc.offerCalendar && <span style={{ color: subText }}> 📅 {r.draft.showOnCalendar ? '表示する' : '表示しない'}</span>}
                    {r.calc.state === 'warn' && <span style={{ color: warnText, fontWeight: 'bold' }}> ⚠️ 休憩が法定より短い</span>}
                  </div>
                ))}
              </div>
            ))}
            <p style={{ fontSize: 12, color: subText, margin: '4px 0 0' }}>1日ずつ、いつもの申請として登録されます。</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" onClick={() => setConfirm(null)} style={{ flex: 1, padding: 10, borderRadius: 8, border: `1px solid ${borderColor}`, background: 'transparent', color: text, fontSize: 14, cursor: 'pointer' }}>戻って直す</button>
              <button type="button" onClick={() => { void doSend(); }} style={{ flex: 1, padding: 10, borderRadius: 8, border: 'none', background: toggleBlue, color: '#fff', fontSize: 14, fontWeight: 'bold', cursor: 'pointer' }}>{list.length}件を送信する</button>
            </div>
          </div>
        );
      })()}

      {gcalFailed.length > 0 && (
        <div style={{ background: '#fff3cd', border: '1px solid #ffc107', color: '#856404', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginTop: 10 }}>
          Googleカレンダーへの反映に失敗した申請が {gcalFailed.length} 件あります。
          <button type="button" style={{ ...smBtn('#856404'), marginLeft: 6 }} onClick={async () => {
            const ngIds: string[] = [];
            for (const id of gcalFailed) { if (!(await syncOvertimeGcal(id))) ngIds.push(id); }
            setGcalFailed(ngIds);
          }}>カレンダーに反映し直す</button>
        </div>
      )}

      {/* 送れた件数（🎨🔒 成功の薄緑カード・固定色。表入力と同じ形） */}
      {doneBanner && (
        <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9999, background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: '18px 22px', boxShadow: '0 4px 20px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', gap: 12, minWidth: 240, maxWidth: '90vw' }}>
          <div style={{ width: 34, height: 34, borderRadius: '50%', background: '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 18, flexShrink: 0 }}>✓</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 15, fontWeight: 'bold', color: '#166534' }}>{doneBanner.ok}件を送信しました</p>
            <p style={{ margin: '2px 0 0', fontSize: 12.5, color: '#15803d' }}>
              {doneBanner.problems > 0 ? `送れなかった・確認が必要な ${doneBanner.problems} 件は、リストに残っています` : '履歴・実績報告タブで状況を確認できます'}
            </p>
          </div>
          <button type="button" onClick={() => setDoneBanner(null)} style={{ background: 'none', border: 'none', color: '#166534', cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>
      )}
    </div>
  );
};

export default OvertimeBox;
