import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import SearchableSelect from '../common/SearchableSelect';
import { resolveNormalShift } from '../../lib/overtimeShift';
import type { PatternRow } from '../../lib/overtimeShift';
import type { CalendarKind } from '../../lib/breakCalc';
import { todayJstStr } from '../../lib/breakCalc';
import { dispatchEmail, getUserEmail } from '../../lib/notificationDispatch';

// 経理（管理者）が「この日の打刻が遅いが残業か」を本人に確認する画面。
// ・1人 × 複数日をまとめて送る（給与計算で1人ぶんのタイムカードを見ながら拾うため）
// ・通常シフトは自動表示。経理が入れるのは打刻だけ（転記を減らすのが最大の時短）
// ・送信すると、その日だけ締め後でも報告できる許可が自動で付く（RPC側）
// ・すでに残業の記録がある日は送らない（二度聞きの防止）

interface StaffRow { id: string; name: string; role_title: string | null }

interface DayInput { work_date: string; clock_in: string; clock_out: string }
interface InquiryDay {
  id: string; work_date: string; shift_start: string | null; shift_end: string | null;
  clock_in: string | null; clock_out: string | null;
  answer: 'pending' | 'worked' | 'not_worked' | 'unknown';
  answer_reason: string | null; answer_note: string | null; result_report_id: string | null;
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
const ANSWER_LABEL: Record<string, string> = {
  pending: '未回答', worked: '業務をしていた', not_worked: '打刻が遅れただけ', unknown: '思い出せない',
};

// 一言の文例。
// ⚠️ 「残業ではないですよね」のように、答えを誘導する書き方は入れないこと。
//    経理（立場が上）から届く確認なので、押し付けに読めるとサービス残業の同意記録になる。
const MESSAGE_EXAMPLES = [
  'この日の打刻について確認させてください',
  '業務をしていた場合は、残業として報告してください',
  '給与計算のため確認させてください',
];

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
  const [existingDates, setExistingDates] = useState<Set<string>>(new Set());
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
    if (!targetId) { setPatterns([]); setExistingDates(new Set()); return; }
    (async () => {
      const { data } = await supabase.from('weekly_shift_patterns').select('*').eq('user_id', targetId);
      setPatterns((data ?? []) as PatternRow[]);
    })();
  }, [targetId]);

  // 選んだ日の会社カレンダーと、すでに残業の記録がある日を取得
  useEffect(() => {
    const dates = rows.map(r => r.work_date);
    if (!targetId || dates.length === 0) { setExistingDates(new Set()); return; }
    (async () => {
      const { data: cal } = await supabase.from('company_calendar').select('date, kind').in('date', dates);
      setCalendarKinds(Object.fromEntries((cal ?? []).map(c => [c.date, c.kind as CalendarKind])));
      const { data: rep } = await supabase.from('overtime_reports')
        .select('work_date').eq('applicant_id', targetId).in('work_date', dates).neq('status', 'cancelled');
      setExistingDates(new Set((rep ?? []).map(r => r.work_date)));
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
    }
    setInquiries(list);
  }, []);

  const loadClockRows = useCallback(async () => {
    const { data } = await supabase.from('overtime_reports')
      .select('id, applicant_id, work_date, reason, clock_in_reported, clock_out_reported, accounting_checked_at')
      .contains('application_types', ['clock_only']).neq('status', 'cancelled')
      .order('work_date', { ascending: false }).limit(60);
    setClockRows((data ?? []) as ClockOnlyRow[]);
  }, []);

  useEffect(() => { loadInquiries(); loadClockRows(); }, [loadInquiries, loadClockRows]);

  const addDate = () => {
    if (!newDate) return;
    if (rows.some(r => r.work_date === newDate)) { setErr('その日はすでに追加されています'); return; }
    setErr('');
    setRows(prev => [...prev, { work_date: newDate, clock_in: '', clock_out: '' }].sort((a, b) => (a.work_date < b.work_date ? -1 : 1)));
    setNewDate('');
  };

  const sendable = useMemo(() => rows.filter(r => !existingDates.has(r.work_date)), [rows, existingDates]);

  const validate = (): string => {
    if (!targetId) return '対象者を選んでください';
    if (sendable.length === 0) return '送れる日がありません（すでに記録がある日は送れません）';
    for (const r of sendable) {
      if (!r.clock_out && !r.clock_in) return `${md(r.work_date)}の打刻を入力してください`;
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
          shift_start: ns.start_time ? ns.start_time.slice(0, 5) : null,
          shift_end: ns.end_time ? ns.end_time.slice(0, 5) : null,
          clock_in: r.clock_in || null,
          clock_out: r.clock_out || null,
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
      <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: 14, marginBottom: 16 }}>
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
                  const dup = existingDates.has(r.work_date);
                  return (
                    <tr key={r.work_date} style={{ borderBottom: `1px solid ${border}`, opacity: dup ? 0.55 : 1 }}>
                      <td style={{ padding: '6px 8px', color: text, whiteSpace: 'nowrap' }}>{md(r.work_date)}（{dowOf(r.work_date)}）</td>
                      <td style={{ padding: '6px 8px', color: subText, whiteSpace: 'nowrap' }}>
                        {dup ? '⚠️ この日は既に記録があります' : `${hm(ns.start_time)}〜${hm(ns.end_time)}`}
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <input type="time" value={r.clock_in} disabled={dup}
                          onChange={e => setRows(prev => prev.map((p, j) => j === i ? { ...p, clock_in: e.target.value } : p))}
                          style={{ ...inputStyle, width: 110 }} />
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <input type="time" value={r.clock_out} disabled={dup}
                          onChange={e => setRows(prev => prev.map((p, j) => j === i ? { ...p, clock_out: e.target.value } : p))}
                          style={{ ...inputStyle, width: 110 }} />
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                        {/* ✕ を使う（🗑 は環境によって□に化ける） */}
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

      {/* ② 送信した確認 */}
      <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: 14, marginBottom: 16 }}>
        <h4 style={{ margin: '0 0 10px', fontSize: 14, color: text }}>送信した確認</h4>
        {inquiries.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: subText }}>まだありません</p>
        ) : inquiries.map(i => (
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
              {i.status === 'open' && (
                <button onClick={() => setWithdrawTarget(i.id)}
                  style={{ marginLeft: 'auto', background: 'none', border: `1px solid ${border}`, borderRadius: 6, cursor: 'pointer', padding: '3px 10px', fontSize: 11.5, color: subText }}>
                  取り下げる
                </button>
              )}
            </div>
            {withdrawTarget === i.id && (
              <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '8px 12px', margin: '8px 0' }}>
                <p style={{ margin: '0 0 8px', fontSize: 12.5, color: '#842029' }}>この確認を取り下げます（本人には出なくなります）</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => doWithdraw(i.id)} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#dc3545', color: '#fff', cursor: 'pointer', fontSize: 12.5 }}>取り下げる</button>
                  <button onClick={() => setWithdrawTarget(null)} style={{ padding: '6px 14px', borderRadius: 6, border: `1px solid ${border}`, background: 'transparent', color: text, cursor: 'pointer', fontSize: 12.5 }}>キャンセル</button>
                </div>
              </div>
            )}
            <div style={{ marginTop: 6 }}>
              {(i.days ?? []).map(d => (
                <div key={d.id} style={{ fontSize: 12, color: subText, lineHeight: 1.9 }}>
                  {md(d.work_date)}（{dowOf(d.work_date)}）　シフト {hm(d.shift_start)}〜{hm(d.shift_end)}　打刻 {hm(d.clock_in)}〜{hm(d.clock_out)}
                  　→ <span style={{ color: d.answer === 'pending' ? subText : text, fontWeight: d.answer === 'pending' ? 'normal' : 'bold' }}>{ANSWER_LABEL[d.answer]}</span>
                  {d.answer_reason && `（${d.answer_reason}）`}
                  {d.answer_note && `（${d.answer_note}）`}
                  {d.answer === 'worked' && !d.result_report_id && <span style={{ color: '#b45309' }}>　※残業の報告待ち</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* ③ 打刻ズレの記録（経理の突き合わせ） */}
      <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: 14 }}>
        <h4 style={{ margin: '0 0 6px', fontSize: 14, color: text }}>打刻ズレの記録（残業なし）</h4>
        <p style={{ margin: '0 0 10px', fontSize: 12, color: subText, lineHeight: 1.7 }}>
          突き合わせが済んだら「確認済み」にしてください。<b>確認済みにすると本人は取り消せなくなります</b>。
        </p>
        {clockRows.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: subText }}>まだありません</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <tbody>
                {clockRows.map(r => (
                  <tr key={r.id} style={{ borderBottom: `1px solid ${border}` }}>
                    <td style={{ padding: '7px 8px', whiteSpace: 'nowrap' }}>
                      <input type="checkbox" checked={!!r.accounting_checked_at} onChange={() => toggleChecked(r)} />
                    </td>
                    <td style={{ padding: '7px 8px', color: text, whiteSpace: 'nowrap' }}>{md(r.work_date)}（{dowOf(r.work_date)}）</td>
                    <td style={{ padding: '7px 8px', color: text, whiteSpace: 'nowrap' }}>{names[r.applicant_id] ?? ''}</td>
                    <td style={{ padding: '7px 8px', color: subText, whiteSpace: 'nowrap' }}>打刻 {hm(r.clock_in_reported)}〜{hm(r.clock_out_reported)}</td>
                    <td style={{ padding: '7px 8px', color: subText }}>{r.reason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default OvertimeClockInquiryPanel;
