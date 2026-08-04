import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { resolveNormalShift } from '../lib/overtimeShift';
import type { PatternRow } from '../lib/overtimeShift';
import { calcPayPeriodStartJst } from '../lib/breakCalc';
import type { CalendarKind } from '../lib/breakCalc';
import { CLOCK_ONLY_REASONS } from '../lib/overtimeTypes';
import { dispatchEmail, getUserEmail } from '../lib/notificationDispatch';

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
  clock_in: string | null; clock_out: string | null;
  answer: 'pending' | 'worked' | 'not_worked' | 'unknown';
  answer_reason: string | null; answer_note: string | null;
  result_report_id: string | null;
}
interface InquiryRow {
  id: string; user_id: string; sender_id: string; message: string | null;
  status: 'open' | 'answered' | 'withdrawn'; answered_at: string | null;
}

type Answer = 'worked' | 'not_worked' | 'unknown';

const ANSWER_CHOICES: { value: Answer; label: string; desc: string }[] = [
  { value: 'worked',     label: '業務をしていました',       desc: '残業として報告します' },
  { value: 'not_worked', label: '業務は終わっていました',   desc: '打刻が遅れただけ・残業なし' },
  { value: 'unknown',    label: '思い出せない・その他',     desc: '経理に相談します' },
];

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const dowOf = (d: string) => DOW[new Date(d + 'T00:00:00').getDay()];
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const hm = (t: string | null) => (t ? t.slice(0, 5) : '—');

interface Props {
  inquiryId: string;
  currentUserId: string;
  isDark: boolean;
  onClose: () => void;
  /** 「この日の残業を報告する」→ 申請フォームを開く（日付・打刻をプリセット） */
  onReportOvertime: (workDate: string, clockOut: string | null) => void;
}

const ClockInquiryResponse: React.FC<Props> = ({ inquiryId, currentUserId, isDark, onClose, onReportOvertime }) => {
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

  const [picks, setPicks] = useState<Record<string, { answer: Answer | ''; reason: string; note: string }>>({});

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
      setInquiry(inq as InquiryRow);
      setDays((ds ?? []) as DayRow[]);
      setPatterns((pat ?? []) as PatternRow[]);
      setSenderName((profs ?? []).find(p => p.id === inq.sender_id)?.name ?? '経理');
      setMyName((profs ?? []).find(p => p.id === inq.user_id)?.name ?? '');
      setLoading(false);
    })();
  }, [inquiryId]);

  const canRespond = !!inquiry && inquiry.user_id === currentUserId && inquiry.status === 'open';

  // 直前に選んだ理由を次の日の既定にする（同じ理由が続くことが多いので入力を減らす）
  const lastReason = useMemo(() => {
    const vals = Object.values(picks).map(p => p.reason).filter(Boolean);
    return vals.length > 0 ? vals[vals.length - 1] : '';
  }, [picks]);

  const setPick = (dayId: string, patch: Partial<{ answer: Answer | ''; reason: string; note: string }>) => {
    setPicks(prev => {
      const cur = prev[dayId] ?? { answer: '', reason: '', note: '' };
      const next = { ...cur, ...patch };
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
          note: p.answer === 'unknown' ? p.note.trim() : null,
        };
      });
      const { data: claimed, error: rErr } = await supabase.rpc('answer_overtime_clock_inquiry', {
        p_inquiry_id: inquiry.id, p_days: payload, p_note: null,
      });
      if (rErr) { setError('回答の記録に失敗しました：' + rErr.message); setSaving(false); return; }
      if (claimed === false) { setError('この確認はすでに回答済みです'); setSaving(false); return; }

      // 2) 「業務は終わっていました」の日だけ、打刻ズレの記録を作る。
      //    ここで失敗しても回答は残るので、あとから作り直せる（result_report_id が null で分かる）
      for (const d of days) {
        const p = picks[d.id];
        if (p.answer !== 'not_worked') continue;
        const ns = resolveNormalShift(patterns, d.work_date, calendarKinds[d.work_date] ?? null);
        if (!ns.start_time) continue;
        const segs: { start_min: number; end_min: number }[] = [];
        const toMin = (t: string | null) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
        const push = (s: string | null, e: string | null) => {
          const a = toMin(s), b0 = toMin(e);
          if (a == null || b0 == null) return;
          segs.push({ start_min: a, end_min: b0 <= a ? b0 + 1440 : b0 });
        };
        push(ns.start_time, ns.end_time);
        push(ns.start_time2 ?? null, ns.end_time2 ?? null);

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
          clock_in_reported: d.clock_in, clock_out_reported: d.clock_out,
          reviewer_id: inquiry.user_id,
          confirmed_by: inquiry.user_id, confirmed_at: new Date().toISOString(),
        }).select('id').single();
        if (repErr || !rep) continue;  // 同日重複(23505)等は個別スキップ。回答自体は残る
        if (segs.length > 0) {
          await supabase.from('overtime_report_segments').insert(
            // seg_no は 1 始まり（DBの制約が 1〜3）。0 始まりにすると1件も入らない
            segs.map((s, i) => ({ report_id: rep.id, phase: 'actual', seg_no: i + 1, start_min: s.start_min, end_min: s.end_min })),
          );
        }
        await supabase.rpc('link_clock_inquiry_result', { p_day_id: d.id, p_report_id: rep.id }).then(null, () => {});
      }

      // 3) 経理へメール（ベル・プッシュは RPC 側で作成済み）
      const counts = { worked: 0, not_worked: 0, unknown: 0 };
      days.forEach(d => { const a = picks[d.id]?.answer; if (a) counts[a] += 1; });
      const summary = [
        counts.not_worked > 0 ? `打刻が遅れただけ ${counts.not_worked}日` : '',
        counts.worked > 0 ? `業務をしていた ${counts.worked}日` : '',
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
    return (
      <div>
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: '16px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 16, flexShrink: 0 }}>✓</div>
          <div>
            <div style={{ fontSize: 14.5, fontWeight: 'bold', color: '#166534' }}>回答しました</div>
            <div style={{ fontSize: 12, color: '#15803d', marginTop: 2 }}>{senderName}さんに届きます</div>
          </div>
        </div>

        {workedDays.length > 0 && (
          <div style={{ background: '#fff3cd', border: '1px solid #ffe0a3', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
            <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 'bold', color: '#664d03' }}>残業として報告が必要な日があります</p>
            {workedDays.map(d => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 8 }}>
                <span style={{ fontSize: 12.5, color: '#664d03' }}>
                  {md(d.work_date)}（{dowOf(d.work_date)}）　打刻 {hm(d.clock_out)}
                </span>
                <button onClick={() => onReportOvertime(d.work_date, d.clock_out)}
                  style={{ background: '#856404', border: 'none', borderRadius: 8, cursor: 'pointer', padding: '7px 12px', fontSize: 12, fontWeight: 'bold', color: '#fff', flexShrink: 0 }}>
                  この日の残業を報告する →
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
          </p>
        </div>
      )}

      {days.map(d => {
        const p = picks[d.id] ?? { answer: '' as Answer | '', reason: '', note: '' };
        const shown: Answer | '' = canRespond ? p.answer : (d.answer === 'pending' ? '' : d.answer);
        return (
          <div key={d.id} style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 12, padding: '12px 14px', marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 'bold', color: text, marginBottom: 4 }}>
              {d.work_date.slice(0, 4)}/{md(d.work_date)}（{dowOf(d.work_date)}）
            </div>
            <div style={{ fontSize: 12.5, color: subText, marginBottom: 10 }}>
              シフト {hm(d.shift_start)}〜{hm(d.shift_end)} ／ 打刻 {hm(d.clock_in)}〜{hm(d.clock_out)}
            </div>

            {canRespond ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {ANSWER_CHOICES.map(c => (
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
                回答：{ANSWER_CHOICES.find(c => c.value === shown)?.label ?? '未回答'}
                {d.answer_reason && <span style={{ color: subText }}>（{d.answer_reason}）</span>}
                {d.answer_note && <div style={{ fontSize: 12.5, color: subText, marginTop: 4 }}>{d.answer_note}</div>}
              </div>
            )}

            {canRespond && p.answer === 'not_worked' && (
              <div style={{ marginTop: 10, background: innerBg, borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>打刻が遅くなった理由</div>
                <select value={p.reason} onChange={e => setPick(d.id, { reason: e.target.value })}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`, background: cardBg, color: text, fontSize: 13 }}>
                  <option value="">選んでください</option>
                  {CLOCK_ONLY_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                {p.reason === 'その他' && (
                  <input value={p.note} onChange={e => setPick(d.id, { note: e.target.value })}
                    placeholder="例：迎えを待っていた"
                    style={{ width: '100%', marginTop: 8, padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`, background: cardBg, color: text, fontSize: 13, boxSizing: 'border-box' }} />
                )}
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
          style={{ width: '100%', padding: '12px 0', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: 'bold', background: '#28a745', color: '#fff' }}>
          {saving ? '送信中...' : 'この内容で回答する'}
        </button>
      ) : (
        <p style={{ fontSize: 12.5, color: subText, textAlign: 'center' }}>
          {inquiry.status === 'answered' ? '回答済みです' : inquiry.status === 'withdrawn' ? 'この確認は取り下げられました' : 'この確認はあなた宛てではありません'}
        </p>
      )}
    </div>
  );
};

export default ClockInquiryResponse;
