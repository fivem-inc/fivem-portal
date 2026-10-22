import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { resolveNormalShift, normalShiftTimeText, normalShiftEdges, normalShiftSegsSorted } from '../lib/overtimeShift';
import type { PatternRow } from '../lib/overtimeShift';
import { calcPayPeriodStartJst } from '../lib/breakCalc';
import type { CalendarKind } from '../lib/breakCalc';
import { CLOCK_FORGOT_IN, CLOCK_FORGOT_OUT, CLOCK_LATE_REASONS } from '../lib/overtimeTypes';
import { dispatchEmail, getUserEmail } from '../lib/notificationDispatch';
import { primaryBtn } from '../lib/buttonStyles';
import TimeInput from './TimeInput';
import { toWorkSegments } from '../lib/overtimeSubmit';
import { timeToMinutes } from '../lib/timeInput';
import { minToTime } from '../lib/breakCalc';
import {
  loadDayStates, answerChoices, answerLabel, stateBandText, segmentsText, diffFromShift, signedText, askSideNote, clockText, lastClockOut,
  TIME_DIFFERS_NOTE_EXAMPLES,
} from '../lib/clockInquiry';
import type { InquiryAnswer, DayStateRow, AskSide } from '../lib/clockInquiry';

// 経理からの「打刻の確認」に答える画面。通知バナー → /overtime?inquiry=<id> から開く。
//
// 設計上の要点（2体レビュー反映）
// ・🚨 回答は先に確定させ、そのあとで「残業の報告」に進む。
//   途中で報告フォームへ飛ばすと、他の日の回答が未送信のまま失われる。
// ・🚨 選択肢は「業務をしていました」を先頭に置き、警告を選択肢の上に出す。
//   楽な答え（打刻が遅れただけ）を先頭にすると、経理から届いた確認という立場も相まって
//   サービス残業に同意させた記録になりかねない。
// ・回答の記録・経理への通知は RPC 側で行う（本人＝一般職はベル通知を insert できない）。

interface DayRow {
  id: string; work_date: string;
  shift_start: string | null; shift_end: string | null;
  shift_start2: string | null; shift_end2: string | null;
  clock_in: string | null; clock_out: string | null;
  /** 2組目の打刻（外出・戻りなど・2026-10-13）。無い日は null */
  clock_in2: string | null; clock_out2: string | null;
  /** 何について聞かれているか（2026-10-13）。古い確認は after */
  ask_side: AskSide | null;
  answer: InquiryAnswer;
  answer_reason: string | null; answer_note: string | null;
  /** 経理がその日に書いたひとこと（2026-10-22） */
  ask_note?: string | null;
  result_report_id: string | null;
  report_state: DayStateRow['state'] | null;
  answer_segments: { start_min: number; end_min: number }[] | null;
}
interface InquiryRow {
  id: string; user_id: string; sender_id: string; message: string | null;
  status: 'open' | 'answered' | 'withdrawn'; answered_at: string | null;
}

// 🚨 答えの言葉・選べる答えは lib/clockInquiry.ts の answerChoices（経理の画面と共用・DB と同じ組み合わせ）
type Answer = Exclude<InquiryAnswer, 'pending'>;
type SegInput = { start: string; end: string };
/** "HH:MM" に（入力欄用。翌日にまたぐ分は 24 を引いて入れる＝残業申請の入力と同じ扱い） */
const toHHMM = (min: number) => { const m = min % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const dowOf = (d: string) => DOW[new Date(d + 'T00:00:00').getDay()];
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** 「業務をしていました」から事後報告を開くときに、入力画面の上の黄色い枠に出すもの（2026-10-13・段階3） */
export interface ClockInquiryHint {
  date: string; shift: string; clockIn: string | null; clockOut: string | null; note: string | null; from: string;
  /** 打刻を2組とも並べた文字（「09:30〜17:30 / 19:15〜—」・lib/clockInquiry の clockText）。
   *  🚨 2026-10-15：clockIn〜clockOut（最初の出勤〜最後の退勤）だけだと、2組目に退勤が無いとき1組目の退勤が出て、2組目が消えていた */
  clock?: string;
  /** 何について聞かれたか：事後報告で空欄にする側（after＝終わり／before＝開始／both＝両方） */
  askSide: AskSide;
}

interface Props {
  inquiryId: string;
  currentUserId: string;
  isDark: boolean;
  onClose: () => void;
  /** 「この日の残業を報告する」→ 申請フォームを開く（日付・打刻をプリセット） */
  onReportOvertime: (workDate: string, hint: ClockInquiryHint) => void;
  /** 申請がある日の答えのあと：その申請を開く（実績の報告・出し直し）。segs は「時刻が違います」で入れた時刻 */
  onOpenReport: (reportId: string, segs?: SegInput[]) => void;
}

const ClockInquiryResponse: React.FC<Props> = ({ inquiryId, currentUserId, isDark, onClose, onReportOvertime, onOpenReport }) => {
  const [inquiry, setInquiry] = useState<InquiryRow | null>(null);
  const [days, setDays] = useState<DayRow[]>([]);
  const [senderName, setSenderName] = useState('');
  const [myName, setMyName] = useState('');
  const [patterns, setPatterns] = useState<PatternRow[]>([]);
  const [calendarKinds, setCalendarKinds] = useState<Record<string, CalendarKind | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  // 打刻ズレの記録を作れなかった日（2026-10-13）。🚨 前は黙って飛ばしていた。回答は記録済みなので、完了画面で知らせる
  const [failedDays, setFailedDays] = useState<{ date: string; msg: string }[]>([]);

  const [picks, setPicks] = useState<Record<string, { answer: Answer | ''; reason: string; note: string; segs: SegInput[] }>>({});
  // その日の申請の状態（答える時点のもの・2026-10-13）。🚨 読めないときは答えさせない（選べる答えが決まらないため）
  const [dayStates, setDayStates] = useState<Record<string, DayStateRow>>({});
  const [stateErr, setStateErr] = useState('');
  const [statesLoaded, setStatesLoaded] = useState(false);

  const text = isDark ? '#e9ecef' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const cardBg = isDark ? '#343a40' : '#fff';
  const innerBg = isDark ? '#495057' : '#f8f9fa';
  const border = isDark ? '#5a6268' : '#dee2e6';

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: inq, error: e1 } = await supabase
        .from('overtime_clock_inquiries').select('*').eq('id', inquiryId).maybeSingle();
      if (e1 || !inq) { setError('この確認は見つかりませんでした（取り下げられた可能性があります）'); setLoading(false); return; }
      const { data: ds } = await supabase
        .from('overtime_clock_inquiry_days').select('*').eq('inquiry_id', inquiryId).order('work_date');
      const { data: profs } = await supabase
        .from('profiles').select('id, name').in('id', [inq.sender_id, inq.user_id]);
      const { data: pat } = await supabase.from('weekly_shift_patterns').select('*').eq('user_id', inq.user_id);
      const dates = (ds ?? []).map(d => d.work_date);
      if (dates.length > 0) {
        const { data: cal } = await supabase.from('company_calendar').select('date, kind').in('date', dates);
        setCalendarKinds(Object.fromEntries((cal ?? []).map(c => [c.date, c.kind as CalendarKind])));
      }
      const st = await loadDayStates(inq.user_id, dates);
      setDayStates(st.map); setStateErr(st.error ?? ''); setStatesLoaded(!st.error);
      setInquiry(inq as InquiryRow);
      setDays((ds ?? []) as DayRow[]);
      setPatterns((pat ?? []) as PatternRow[]);
      setSenderName((profs ?? []).find(p => p.id === inq.sender_id)?.name ?? '経理');
      setMyName((profs ?? []).find(p => p.id === inq.user_id)?.name ?? '');
      setLoading(false);
    })();
  }, [inquiryId]);

  const canRespond = !!inquiry && inquiry.user_id === currentUserId && inquiry.status === 'open' && statesLoaded;
  const reloadStates = async () => {
    if (!inquiry) return;
    const st = await loadDayStates(inquiry.user_id, days.map(d => d.work_date));
    setDayStates(st.map); setStateErr(st.error ?? ''); setStatesLoaded(!st.error);
    setPicks({});
  };
  const anyReport = days.some(d => dayStates[d.work_date]?.report_id);

  // 直前に選んだ理由を次の日の既定にする（同じ理由が続くことが多いので入力を減らす）
  const lastReason = useMemo(() => {
    const vals = Object.values(picks).map(p => p.reason).filter(Boolean);
    return vals.length > 0 ? vals[vals.length - 1] : '';
  }, [picks]);

  const setPick = (dayId: string, patch: Partial<{ answer: Answer | ''; reason: string; note: string; segs: SegInput[] }>) => {
    setPicks(prev => {
      const cur = prev[dayId] ?? { answer: '', reason: '', note: '', segs: [] };
      const next = { ...cur, ...patch };
      // 「時刻が違います」を選んだら、申請の時間を最初から入れておく（違うところだけ直してもらう）
      if (patch.answer === 'time_differs' && next.segs.length === 0) {
        const day = days.find(x => x.id === dayId);
        const st = day ? dayStates[day.work_date] : undefined;
        next.segs = (st?.segments ?? []).map(sg => ({ start: toHHMM(sg.start_min), end: toHHMM(sg.end_min) }));
        if (next.segs.length === 0) next.segs = [{ start: '', end: '' }];
      }
      // 「業務は終わっていました」を選んだ直後は、直前の日と同じ理由を入れておく（変更可）
      if (patch.answer === 'not_worked' && !next.reason && lastReason) next.reason = lastReason;
      return { ...prev, [dayId]: next };
    });
    setError('');
  };

  const validate = (): string => {
    for (const d of days) {
      const p = picks[d.id];
      if (!p || !p.answer) return `${md(d.work_date)}（${dowOf(d.work_date)}）の回答を選んでください`;
      if (p.answer === 'not_worked' && !p.reason) return `${md(d.work_date)}（${dowOf(d.work_date)}）の理由を選んでください`;
      if (p.answer === 'not_worked' && p.reason === 'その他' && !p.note.trim()) return `${md(d.work_date)}（${dowOf(d.work_date)}）の理由を入力してください`;
      if (p.answer === 'unknown' && !p.note.trim()) return `${md(d.work_date)}（${dowOf(d.work_date)}）の状況を書いてください`;
      if (p.answer === 'time_differs') {
        const label = `${md(d.work_date)}（${dowOf(d.work_date)}）`;
        const ws = toWorkSegments(p.segs);
        if (ws.length === 0 || ws.length !== p.segs.filter(x => x.start || x.end).length) return `${label}の勤務時間を入れてください`;
        const st = dayStates[d.work_date];
        const same = JSON.stringify(ws.map(w => [w.startMin, w.endMin])) === JSON.stringify((st?.segments ?? []).map(x => [x.start_min, x.end_min]));
        if (same) return `${label}は申請と同じ時刻です。申請の通りなら上の答えを選んでください`;
        if (!p.note.trim()) return `${label}のひとことを書いてください`;
      }
    }
    return '';
  };

  const submit = async () => {
    const v = validate();
    if (v) { setError(v); return; }
    if (!inquiry) return;
    setSaving(true); setError('');
    try {
      // 1) 回答を先に確定（open→answered を1回だけ成立。経理への通知もこの中で作られる）
      const payload = days.map(d => {
        const p = picks[d.id];
        return {
          day_id: d.id,
          answer: p.answer,
          reason: p.answer === 'not_worked' ? (p.reason === 'その他' ? p.note.trim() : p.reason) : null,
          note: p.answer === 'unknown' || p.answer === 'time_differs' ? p.note.trim() : null,
          segments: p.answer === 'time_differs'
            ? toWorkSegments(p.segs).map(w => ({ start_min: w.startMin, end_min: w.endMin }))
            : null,
        };
      });
      const { data: claimed, error: rErr } = await supabase.rpc('answer_overtime_clock_inquiry', {
        p_inquiry_id: inquiry.id, p_days: payload, p_note: null,
      });
      if (rErr) {
        // 🚨 送ったあとに申請が出た・取り消されたなど。サーバーが断ったら状態を読み直して答え直してもらう
        if (rErr.message.includes('CLOCK_INQ_STATE_CHANGED')) {
          setError(rErr.message.replace(/^.*CLOCK_INQ_STATE_CHANGED:\s*/, ''));
          await reloadStates();
        } else {
          setError('回答の記録に失敗しました：' + rErr.message.replace(/^.*CLOCK_INQ_[A-Z_]+:\s*/, ''));
        }
        setSaving(false); return;
      }
      if (claimed === false) { setError('この確認はすでに回答済みです'); setSaving(false); return; }
      // 答えたら、残業のナビの数字と残業申請のページの「経理からの打刻の確認」を読み直す（2026-10-15）
      window.dispatchEvent(new Event('overtime-pending-changed'));

      // 2) 「業務は終わっていました」の日だけ、打刻ズレの記録を作る。
      //    ここで失敗しても回答は残るので、あとから作り直せる（result_report_id が null で分かる）
      //    🚨 失敗した日は failed に集めて完了画面に出す（2026-10-13・前は黙って飛ばしていた）
      const failed: { date: string; msg: string }[] = [];
      for (const d of days) {
        const p = picks[d.id];
        if (p.answer !== 'not_worked') continue;
        const ns = resolveNormalShift(patterns, d.work_date, calendarKinds[d.work_date] ?? null);
        if (!ns.start_time) { failed.push({ date: d.work_date, msg: 'この日のシフトが見つからないため、記録を作れませんでした' }); continue; }
        const segs: { start_min: number; end_min: number }[] = [];
        const toMin = (t: string | null) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
        const push = (s: string | null, e: string | null) => {
          const a = toMin(s), b0 = toMin(e);
          if (a == null || b0 == null) return;
          segs.push({ start_min: a, end_min: b0 <= a ? b0 + 1440 : b0 });
        };
        // 🚨 時刻の早い順に（1本目→2本目の順にしない。2本目のほうが早い人がいる・2026-10-16）
        for (const sg of normalShiftSegsSorted(ns)) push(sg.start, sg.end);

        const reasonText = p.reason === 'その他' ? p.note.trim() : p.reason;
        const { data: rep, error: repErr } = await supabase.from('overtime_reports').insert({
          applicant_id: inquiry.user_id, submitted_by: inquiry.user_id, entry_type: 'manual',
          work_date: d.work_date, pay_period_start: calcPayPeriodStartJst(d.work_date), is_post_hoc: true,
          status: 'confirmed', normal_shift: ns,
          break_minutes: ns.break_minutes, break_manual: false,
          labor_minutes: ns.labor_minutes, diff_minutes: 0, legal_warning: false,
          reason: `残業ではありません（理由：${reasonText}）`,
          location: ns.location ?? '',
          application_types: ['clock_only'],
          clock_in_reported: d.clock_in, clock_out_reported: lastClockOut(d),
          reviewer_id: inquiry.user_id,
          confirmed_by: inquiry.user_id, confirmed_at: new Date().toISOString(),
        }).select('id').single();
        if (repErr || !rep) {
          // 同じ日に申請がすでにある（23505）など。回答自体は残る
          failed.push({
            date: d.work_date,
            msg: repErr?.code === '23505'
              ? 'この日はすでに残業申請が出ているため、打刻ズレの記録は作りませんでした（申請はそのままです）'
              : `記録を作れませんでした：${repErr?.message ?? '理由が分かりません'}`,
          });
          continue;
        }
        if (segs.length > 0) {
          const { error: segErr } = await supabase.from('overtime_report_segments').insert(
            // seg_no は 1 始まり（DBの制約が 1〜3）。0 始まりにすると1件も入らない
            segs.map((s, i) => ({ report_id: rep.id, phase: 'actual', seg_no: i + 1, start_min: s.start_min, end_min: s.end_min })),
          );
          if (segErr) failed.push({ date: d.work_date, msg: `記録の時間帯を保存できませんでした：${segErr.message}` });
        }
        const { data: linked, error: linkErr } = await supabase.rpc('link_clock_inquiry_result', { p_day_id: d.id, p_report_id: rep.id });
        if (linkErr || linked === false) {
          console.error('打刻確認の結果の記録に失敗:', linkErr?.message ?? 'link returned false');
          failed.push({ date: d.work_date, msg: '記録は作りましたが、確認と結び付けられませんでした（経理に伝えてください）' });
        }
      }
      setFailedDays(failed);

      // 3) 経理へメール（ベル・プッシュは RPC 側で作成済み）
      const counts: Record<Answer, number> = { worked: 0, adjusted: 0, not_worked: 0, unknown: 0, as_reported: 0, time_differs: 0, will_resubmit: 0 };
      days.forEach(d => { const a = picks[d.id]?.answer; if (a) counts[a] += 1; });
      // 🚨 文は DB の answer_overtime_clock_inquiry の経理あてベルと同じ並び・言葉
      const summary = [
        counts.time_differs > 0 ? `時刻が違う ${counts.time_differs}日` : '',
        counts.will_resubmit > 0 ? `申請を出し直す ${counts.will_resubmit}日` : '',
        counts.as_reported > 0 ? `申請の通り ${counts.as_reported}日` : '',
        counts.not_worked > 0 ? `定時でした（業務なし） ${counts.not_worked}日` : '',
        counts.worked > 0 ? `業務をしていた ${counts.worked}日` : '',
        counts.adjusted > 0 ? `時間調整をした ${counts.adjusted}日` : '',
        counts.unknown > 0 ? `思い出せない ${counts.unknown}日` : '',
      ].filter(Boolean).join('／');
      const senderEmail = await getUserEmail(inquiry.sender_id);
      if (senderEmail) {
        await dispatchEmail('overtime:clock_inquiry_answered', {
          対象者名: myName, 内容: summary,
          リンク: `${window.location.origin}/admin?tab=overtime_admin&section=inquiries`,
        }, { applicant: senderEmail }).then(null, () => {});
      }

      setDone(true);
    } catch (e) {
      setError('送信に失敗しました：' + String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p style={{ fontSize: 13, color: subText }}>読み込み中...</p>;
  if (!inquiry) {
    return (
      <div>
        <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: '#842029' }}>{error || 'この確認は見つかりませんでした'}</p>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: `1px solid ${border}`, borderRadius: 8, cursor: 'pointer', padding: '8px 16px', fontSize: 13, color: text }}>閉じる</button>
      </div>
    );
  }

  // 回答完了：残業として報告が必要な日をここから開く（回答は既に確定している）
  if (done) {
    const workedDays = days.filter(d => picks[d.id]?.answer === 'worked');
    // 時間調整をしました：事後報告で調整早退／調整遅出を出してもらう（開始も終わりも空欄から本人が入れる）
    const adjustedDays = days.filter(d => picks[d.id]?.answer === 'adjusted');
    // 申請がある日の次の一手（事前申請だけ→実績の報告／差し戻し中→出し直し）
    const nextSteps = days.flatMap(d => {
      const st = dayStates[d.work_date]; const a = picks[d.id]?.answer;
      if (!st?.report_id) return [];
      if (st.state === 'planned' && (a === 'as_reported' || a === 'time_differs')) {
        return [{ d, reportId: st.report_id, label: '実績を報告する →', segs: a === 'time_differs' ? picks[d.id].segs : undefined }];
      }
      if (st.state === 'returned' && a === 'will_resubmit') return [{ d, reportId: st.report_id, label: '申請を直して出し直す →', segs: undefined }];
      return [];
    });
    const differsDays = days.filter(d => picks[d.id]?.answer === 'time_differs' && dayStates[d.work_date]?.state === 'reported');
    return (
      <div>
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: '16px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 16, flexShrink: 0 }}>✓</div>
          <div>
            <div style={{ fontSize: 14.5, fontWeight: 'bold', color: '#166534' }}>回答しました</div>
            <div style={{ fontSize: 12, color: '#15803d', marginTop: 2 }}>{senderName}さんに届きます</div>
          </div>
        </div>

        {failedDays.length > 0 && (
          <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
            <p style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 'bold', color: '#842029' }}>回答は届きましたが、記録できなかった日があります</p>
            {failedDays.map((f, i) => (
              <p key={i} style={{ margin: '4px 0 0', fontSize: 12.5, color: '#842029', lineHeight: 1.6 }}>
                {md(f.date)}（{dowOf(f.date)}）　{f.msg}
              </p>
            ))}
          </div>
        )}

        {differsDays.length > 0 && (
          <div style={{ background: innerBg, border: `1px solid ${border}`, borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
            <p style={{ margin: 0, fontSize: 12.5, color: text, lineHeight: 1.7 }}>
              「時刻が違います」と答えた日（{differsDays.map(d => `${md(d.work_date)}（${dowOf(d.work_date)}）`).join('・')}）は、経理が確認して申請を直します。直したらお知らせが届きます。
            </p>
          </div>
        )}

        {nextSteps.length > 0 && (
          <div style={{ background: '#fff3cd', border: '1px solid #ffe0a3', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
            <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 'bold', color: '#664d03' }}>続けてしてほしいことがあります</p>
            {nextSteps.map(n => (
              <div key={n.d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 8 }}>
                <span style={{ fontSize: 12.5, color: '#664d03' }}>
                  {md(n.d.work_date)}（{dowOf(n.d.work_date)}）{n.segs ? `　${n.segs.map(x => `${x.start}〜${x.end}`).join(' / ')}` : ''}
                </span>
                <button onClick={() => onOpenReport(n.reportId, n.segs)}
                  style={{ background: '#856404', border: 'none', borderRadius: 8, cursor: 'pointer', padding: '7px 12px', fontSize: 12, fontWeight: 'bold', color: '#fff', flexShrink: 0 }}>
                  {n.label}
                </button>
              </div>
            ))}
          </div>
        )}

        {workedDays.length > 0 && (
          <div style={{ background: '#fff3cd', border: '1px solid #ffe0a3', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
            <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 'bold', color: '#664d03' }}>残業として報告が必要な日があります</p>
            {workedDays.map(d => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 8 }}>
                <span style={{ fontSize: 12.5, color: '#664d03' }}>
                  {md(d.work_date)}（{dowOf(d.work_date)}）　打刻 {clockText(d)}
                </span>
                <button onClick={() => onReportOvertime(d.work_date, {
                  date: d.work_date,
                  shift: normalShiftTimeText({ start_time: d.shift_start, end_time: d.shift_end, start_time2: d.shift_start2, end_time2: d.shift_end2 }) || '',
                  clockIn: d.clock_in ? d.clock_in.slice(0, 5) : null,
                  clockOut: lastClockOut(d) ? lastClockOut(d)!.slice(0, 5) : null,
                  clock: clockText(d),
                  note: inquiry?.message ?? null,
                  from: senderName,
                  askSide: d.ask_side ?? 'after',
                })}
                  style={{ background: '#856404', border: 'none', borderRadius: 8, cursor: 'pointer', padding: '7px 12px', fontSize: 12, fontWeight: 'bold', color: '#fff', flexShrink: 0 }}>
                  この日の残業を報告する →
                </button>
              </div>
            ))}
          </div>
        )}

        {adjustedDays.length > 0 && (
          <div style={{ background: '#fff3cd', border: '1px solid #ffe0a3', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
            <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 'bold', color: '#664d03' }}>時間調整の申請が必要な日があります</p>
            {adjustedDays.map(d => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 8 }}>
                <span style={{ fontSize: 12.5, color: '#664d03' }}>
                  {md(d.work_date)}（{dowOf(d.work_date)}） 打刻 {clockText(d)}
                </span>
                <button onClick={() => onReportOvertime(d.work_date, {
                  date: d.work_date,
                  shift: normalShiftTimeText({ start_time: d.shift_start, end_time: d.shift_end, start_time2: d.shift_start2, end_time2: d.shift_end2 }) || '',
                  clockIn: d.clock_in ? d.clock_in.slice(0, 5) : null,
                  clockOut: lastClockOut(d) ? lastClockOut(d)!.slice(0, 5) : null,
                  clock: clockText(d),
                  note: inquiry?.message ?? null,
                  from: senderName,
                  askSide: 'both',
                })}
                  style={{ background: '#856404', border: 'none', borderRadius: 8, cursor: 'pointer', padding: '7px 12px', fontSize: 12, fontWeight: 'bold', color: '#fff', flexShrink: 0 }}>
                  時間調整の申請を出す →
                </button>
              </div>
            ))}
          </div>
        )}

        <button onClick={onClose} style={{ width: '100%', background: 'none', border: `1px solid ${border}`, borderRadius: 8, cursor: 'pointer', padding: '10px 0', fontSize: 13, color: text }}>閉じる</button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ fontSize: 18, fontWeight: 'bold', color: text, margin: 0 }}>🕐 勤務時間の確認</h2>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: subText }} aria-label="閉じる">✕</button>
      </div>

      <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 12, padding: '12px 14px', marginBottom: 14 }}>
        <p style={{ margin: 0, fontSize: 13, color: text }}>{senderName}さんから、勤務時間の確認が届いています。</p>
        {inquiry.message && (
          <p style={{ margin: '8px 0 0', fontSize: 12.5, color: subText, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{inquiry.message}</p>
        )}
      </div>

      {/* 🚨 警告は選択肢の「上」に置く。下に置くと、読む前に楽な答えを押せてしまう。
          ライト・ダーク共通の黄色（必ず読まれる必要があるため固定色） */}
      {canRespond && (
        <div style={{ background: '#fff3cd', border: '1px solid #ffe0a3', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: '#664d03', lineHeight: 1.8 }}>
            打刻とシフトの時間に差がありました。残業として処理すべきか確認させてください。<br />
            <b>片付け・準備・保護者対応など、仕事をしていた時間は残業です。</b>
            その場合は必ず「業務をしていました」を選んでください。
            {anyReport && <><br />申請より長く仕事をしていたときは「時刻が違います」で終わりを直してください。</>}
          </p>
        </div>
      )}
      {stateErr && (
        <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: '#842029' }}>その日の申請の状態を読み込めませんでした。画面を開き直してください（{stateErr}）</p>
        </div>
      )}

      {days.map(d => {
        const p = picks[d.id] ?? { answer: '' as Answer | '', reason: '', note: '', segs: [] as SegInput[] };
        const st = dayStates[d.work_date];
        // 答えたあとの表示は、答えた時点の状態（report_state）で言葉を決める
        const shownLabel = d.answer === 'pending' ? '未回答' : answerLabel(d.answer, d.report_state, d.ask_side ?? 'after');
        const band = stateBandText(st);
        const bandStyle = band.tone === 'app' ? { bg: '#e6f1fb', fg: '#0c447c' } : band.tone === 'ret' ? { bg: '#fdecea', fg: '#a32d2d' }
          : band.tone === 'leave' ? { bg: '#fbeaf0', fg: '#72243e' } : { bg: isDark ? '#3a3f44' : '#f1f3f5', fg: isDark ? '#ced4da' : '#495057' };
        const shiftText = normalShiftTimeText({ start_time: d.shift_start, end_time: d.shift_end, start_time2: d.shift_start2, end_time2: d.shift_end2 }) || '—';
        const ws = p.answer === 'time_differs' ? toWorkSegments(p.segs) : [];
        const shiftLabor = st?.normal_shift?.labor_minutes ?? null;
        const newDiff = ws.length > 0 ? diffFromShift(ws, shiftLabor) : null;
        // 🚨 シフトの終わりは「いちばん遅い終わり」（2本目の終わりと決め打ちしない・2026-10-16）
        const edges = normalShiftEdges({ start_time: d.shift_start, end_time: d.shift_end, start_time2: d.shift_start2, end_time2: d.shift_end2 });
        const shiftEndMin = timeToMinutes(edges?.end ?? null);
        const clockOutMin = timeToMinutes(lastClockOut(d));
        // 近道：最後の時間帯の終わりだけを置き換える（開始と2本目は残す）
        const setLastEnd = (min: number | null) => {
          if (min == null || p.segs.length === 0) return;
          const segs = p.segs.map((x, i) => (i === p.segs.length - 1 ? { ...x, end: toHHMM(min) } : x));
          setPick(d.id, { segs });
        };
        return (
          <div key={d.id} style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 12, padding: '12px 14px', marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 'bold', color: text, marginBottom: 4 }}>
              {d.work_date.slice(0, 4)}/{md(d.work_date)}（{dowOf(d.work_date)}）
            </div>
            {/* その日の申請の状態を色の帯で（日によって選べる答えが違うので、取り違えないように） */}
            {canRespond && (
              <div style={{ background: bandStyle.bg, color: bandStyle.fg, borderRadius: 6, padding: '5px 8px', fontSize: 12, fontWeight: 'bold', marginBottom: 6, lineHeight: 1.5 }}>
                {band.text}
              </div>
            )}
            {/* 経理からその日のひとこと（2026-10-22 経理担当の意見：日ごとに書けるように） */}
            {d.ask_note && (
              <div style={{ background: '#e8f4fd', borderLeft: '3px solid #1976d2', padding: '5px 10px', fontSize: 12.5, color: '#0c447c', marginBottom: 6, lineHeight: 1.6 }}>
                経理から：{d.ask_note}
              </div>
            )}
            {/* 見比べるための枠：シフト・出している申請・打刻（固定色） */}
            <div style={{ background: '#fffbea', border: '1px solid #f0d58a', borderRadius: 8, padding: '6px 10px', fontSize: 12.5, color: '#5c4400', lineHeight: 1.7, marginBottom: 10 }}>
              シフト {shiftText}
              {st?.report_id && st.segments && st.segments.length > 0 && <><br />出している申請 {segmentsText(st.segments)}（{signedText(st.diff_minutes)}）</>}
              <br />打刻 <b>{clockText(d)}</b>
              {/* 何について聞かれているか（出勤前／退勤のあと／両方・2026-10-13） */}
              <br /><span style={{ color: '#b45309' }}>{askSideNote(d.ask_side ?? 'after', edges?.start ?? null, edges?.end ?? null, d.clock_in, lastClockOut(d))}</span>
            </div>

            {canRespond ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {answerChoices(st?.state ?? 'none', d.ask_side ?? 'after').map(c => ({ ...c, value: c.value as Answer })).map(c => (
                  <button key={c.value} type="button" onClick={() => setPick(d.id, { answer: c.value })}
                    style={{
                      padding: '10px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                      border: `2px solid ${p.answer === c.value ? '#1565c0' : '#90caf9'}`,
                      background: p.answer === c.value ? '#1976d2' : '#e3f2fd',
                    }}>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: 'bold', color: p.answer === c.value ? '#fff' : '#1565c0' }}>{c.label}</span>
                    <span style={{ display: 'block', fontSize: 11.5, marginTop: 2, color: p.answer === c.value ? '#e3f2fd' : '#1976d2' }}>{c.desc}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: text }}>
                回答：{shownLabel}
                {d.answer === 'time_differs' && d.answer_segments && <span>（{segmentsText(d.answer_segments)}）</span>}
                {d.answer_reason && <span style={{ color: subText }}>（{d.answer_reason}）</span>}
                {d.answer_note && <div style={{ fontSize: 12.5, color: subText, marginTop: 4 }}>{d.answer_note}</div>}
              </div>
            )}

            {canRespond && p.answer === 'not_worked' && (
              <div style={{ marginTop: 10, background: innerBg, borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>何がありましたか</div>
                <select value={p.reason} onChange={e => setPick(d.id, { reason: e.target.value })}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`, background: cardBg, color: text, fontSize: 13 }}>
                  <option value="">選んでください</option>
                  {/* ①②③ と③の理由（1件フォームの ClockReasonPicker と同じ一覧・2026-10-22 案B） */}
                  <option value={CLOCK_FORGOT_IN}>① {CLOCK_FORGOT_IN}</option>
                  <option value={CLOCK_FORGOT_OUT}>② {CLOCK_FORGOT_OUT}</option>
                  <optgroup label="③ 打刻が遅れた・早かった（残業ではない）">
                    {CLOCK_LATE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                  </optgroup>
                </select>
                {p.reason === 'その他' && (
                  <input value={p.note} onChange={e => setPick(d.id, { note: e.target.value })}
                    placeholder="例：迎えを待っていた"
                    style={{ width: '100%', marginTop: 8, padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`, background: cardBg, color: text, fontSize: 13, boxSizing: 'border-box' }} />
                )}
              </div>
            )}

            {canRespond && p.answer === 'time_differs' && (
              <div style={{ marginTop: 10, background: innerBg, borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>実際の勤務時間（出勤〜退勤）</div>
                {p.segs.map((sg, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <TimeInput value={sg.start} isDark={isDark} advance ariaLabel={`勤務${i + 1} 開始時刻`} style={{ flex: 1, minWidth: 0 }}
                      onChange={v => setPick(d.id, { segs: p.segs.map((x, j) => (j === i ? { ...x, start: v } : x)) })} />
                    <span style={{ color: subText }}>〜</span>
                    <TimeInput value={sg.end} isDark={isDark} ariaLabel={`勤務${i + 1} 終了時刻`} style={{ flex: 1, minWidth: 0 }}
                      onChange={v => setPick(d.id, { segs: p.segs.map((x, j) => (j === i ? { ...x, end: v } : x)) })} />
                  </div>
                ))}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                  {clockOutMin != null && (
                    <button type="button" onClick={() => setLastEnd(clockOutMin)}
                      style={{ border: `1px solid ${border}`, background: cardBg, color: text, borderRadius: 14, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
                      退勤の打刻（{minToTime(clockOutMin)}）
                    </button>
                  )}
                  {shiftEndMin != null && (
                    <button type="button" onClick={() => setLastEnd(shiftEndMin)}
                      style={{ border: `1px solid ${border}`, background: cardBg, color: text, borderRadius: 14, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
                      シフトの終わり（{minToTime(shiftEndMin)}）＝残業なし
                    </button>
                  )}
                </div>
                {newDiff != null && (
                  <div style={{ marginTop: 8, fontSize: 12.5, color: text, background: cardBg, borderRadius: 6, padding: '4px 8px' }}>
                    申請 {signedText(st?.diff_minutes)} → 正しい時間 <b>{signedText(newDiff)}</b>
                  </div>
                )}
                <div style={{ fontSize: 12, color: subText, margin: '10px 0 4px' }}>ひとこと<span style={{ color: '#c62828', marginLeft: 4 }}>必須</span></div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                  {TIME_DIFFERS_NOTE_EXAMPLES.map(ex => (
                    <button key={ex} type="button" onClick={() => setPick(d.id, { note: ex })}
                      style={{ border: `1px solid ${p.note === ex ? '#1565c0' : border}`, background: p.note === ex ? '#e3f2fd' : cardBg, color: p.note === ex ? '#1565c0' : text, borderRadius: 14, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
                      {ex}
                    </button>
                  ))}
                </div>
                <input value={p.note} onChange={e => setPick(d.id, { note: e.target.value })} placeholder="ひとこと"
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`, background: cardBg, color: text, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
            )}

            {canRespond && p.answer === 'unknown' && (
              <div style={{ marginTop: 10, background: innerBg, borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>分かる範囲で書いてください</div>
                <textarea value={p.note} onChange={e => setPick(d.id, { note: e.target.value })} rows={2}
                  placeholder="例：この日は覚えていません"
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`, background: cardBg, color: text, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }} />
              </div>
            )}
          </div>
        );
      })}

      {error && (
        <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: '#842029' }}>{error}</p>
        </div>
      )}

      {canRespond ? (
        <button onClick={submit} disabled={saving}
          style={{ ...primaryBtn({ disabled: saving }), width: '100%' }}>
          {saving ? '送信中...' : 'この内容で回答する'}
        </button>
      ) : (
        <p style={{ fontSize: 12.5, color: subText, textAlign: 'center' }}>
          {inquiry.status === 'answered' ? '回答済みです' : inquiry.status === 'withdrawn' ? 'この確認は取り下げられました'
            : inquiry.user_id === currentUserId ? '申請の状態を読み込めないため、いまは回答できません。画面を開き直してください'
            : 'この確認はあなた宛てではありません'}
        </p>
      )}
    </div>
  );
};

export default ClockInquiryResponse;
