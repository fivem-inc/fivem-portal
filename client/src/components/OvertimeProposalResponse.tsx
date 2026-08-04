import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { insertNotification } from '../lib/notifications';
import { timeToMin, calcPayPeriodStartJst, formatSignedMin } from '../lib/breakCalc';
import { notifyOvertimeNewRequest } from '../lib/overtimeNotify';
import { shouldSend, dispatchEmail, dispatchSiteNotification, getUserEmail } from '../lib/notificationDispatch';
import { sendLeaveSlack } from '../lib/leaveSlack';
import type { CalendarKind } from '../lib/breakCalc';
import { buildTimeAdjustReport, resolveNormalShift } from '../lib/overtimeShift';
import type { PatternRow } from '../lib/overtimeShift';

// 残業調整 提案の回答画面（第1段：時間調整のみ）。
// 通知バナー → /overtime?proposal=<id> から開く。
// ・相手（recipient）本人・status=open … 候補を選択/カスタム/見送りして回答。受諾で overtime_reports を作成。
// ・それ以外（提案者・上長・管理者、または回答済み） … 読み取り専用で内容と結果を表示。
// 受諾時の残業記録は lib/overtimeShift の buildTimeAdjustReport（申請フォームと同一計算）で作る。

interface OptionRow {
  id: string; kind: 'late_start' | 'early_end' | 'chosei_off';
  work_date: string; adjust_time: string | null; location: string | null;
  offset_minutes: number; note: string | null;
  selection: 'pending' | 'accepted' | 'declined' | 'custom';
  custom_date: string | null; custom_time: string | null;
  result_type: string | null; result_id: string | null;
}
interface ProposalRow {
  id: string; proposer_id: string; recipient_id: string; pay_period_start: string;
  overtime_snapshot_minutes: number | null; remarks: string | null;
  response_due_date: string | null; status: 'open' | 'responded' | 'withdrawn';
  recipient_note: string | null;
}

const KIND_LABEL: Record<string, string> = { late_start: '遅出（出勤を遅く）', early_end: '早退（退勤を早く）', chosei_off: '調整休' };
const fmtMin = (min: number): string => {
  const s = min < 0 ? '−' : ''; const a = Math.abs(min);
  const h = Math.floor(a / 60), mm = a % 60;
  return `${s}${h > 0 ? `${h}時間` : ''}${mm > 0 || h === 0 ? `${mm}分` : ''}`;
};

interface Props { proposalId: string; currentUserId: string; isDark: boolean; onClose: () => void; }

const OvertimeProposalResponse: React.FC<Props> = ({ proposalId, currentUserId, isDark, onClose }) => {
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const cardBg = isDark ? '#343a40' : '#fff';
  const inputBg = isDark ? '#2b3035' : '#fff';
  const selStyle: React.CSSProperties = { padding: '7px', borderRadius: 8, border: `1px solid ${border}`, fontSize: 14, background: inputBg, color: text, boxSizing: 'border-box' };

  const [proposal, setProposal] = useState<ProposalRow | null>(null);
  const [options, setOptions] = useState<OptionRow[]>([]);
  const [proposerName, setProposerName] = useState('');
  const [proposerRole, setProposerRole] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  // 相手の回答用ローカル状態（optionId→{chosen,date,time}）
  const [picks, setPicks] = useState<Record<string, { chosen: boolean; date: string; time: string }>>({});
  const [note, setNote] = useState('');
  const [patterns, setPatterns] = useState<PatternRow[]>([]);
  const [calendarKinds, setCalendarKinds] = useState<Record<string, CalendarKind | null>>({});
  const [existingDates, setExistingDates] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<null | 'accepted' | 'declined'>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const { data: p, error: pErr } = await supabase.from('overtime_adjustment_proposals').select('*').eq('id', proposalId).maybeSingle();
      if (!alive) return;
      if (pErr || !p) { setLoadError('提案が見つからないか、閲覧権限がありません'); setLoading(false); return; }
      const prop = p as ProposalRow;
      setProposal(prop);
      const { data: opts } = await supabase.from('overtime_adjustment_proposal_options').select('*').eq('proposal_id', proposalId).order('work_date');
      const optRows = (opts as OptionRow[] | null) ?? [];
      setOptions(optRows);
      setPicks(Object.fromEntries(optRows.map(o => [o.id, { chosen: false, date: o.work_date, time: (o.adjust_time ?? '').slice(0, 5) }])));
      const { data: prof } = await supabase.from('profiles').select('name, role_title').eq('id', prop.proposer_id).maybeSingle();
      setProposerName((prof as { name: string } | null)?.name ?? '');
      setProposerRole((prof as { role_title: string | null } | null)?.role_title ?? '');
      // 相手本人＆未回答のときだけ、受諾に必要なシフト等を取得
      if (prop.recipient_id === currentUserId && prop.status === 'open') {
        const { data: pat } = await supabase.from('weekly_shift_patterns').select('*').eq('user_id', prop.recipient_id);
        setPatterns((pat as PatternRow[] | null) ?? []);
        const dates = [...new Set(optRows.map(o => o.work_date))];
        if (dates.length) {
          const { data: cal } = await supabase.from('company_calendar').select('date, kind').in('date', dates);
          const cmap: Record<string, CalendarKind | null> = {};
          for (const c of ((cal as { date: string; kind: CalendarKind }[] | null) ?? [])) cmap[c.date] = c.kind;
          setCalendarKinds(cmap);
          const { data: ex } = await supabase.from('overtime_reports').select('work_date').eq('applicant_id', prop.recipient_id).eq('pay_period_start', prop.pay_period_start).neq('status', 'cancelled');
          setExistingDates(new Set(((ex as { work_date: string }[] | null) ?? []).map(r => r.work_date)));
        }
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [proposalId, currentUserId]);

  const isRecipient = proposal?.recipient_id === currentUserId;
  const canRespond = isRecipient && proposal?.status === 'open';

  // 時間調整の受諾レコード算出（既存フォームと同一計算）。調整休は別途 leave_requests。
  const buildFor = (o: OptionRow) => {
    if (o.kind === 'chosei_off') return null;
    const pk = picks[o.id]; if (!pk) return null;
    return buildTimeAdjustReport(patterns, pk.date, calendarKinds[pk.date] ?? null, o.kind, pk.time);
  };
  // 各候補の見込み相殺（分・正の値）。調整休＝その日の通常労働／時間調整＝−diff。
  const offsetPreview = (o: OptionRow): number => {
    const pk = picks[o.id]; if (!pk?.date) return 0;
    if (o.kind === 'chosei_off') return resolveNormalShift(patterns, pk.date, calendarKinds[pk.date] ?? null).labor_minutes;
    const b = buildFor(o); return b?.ok ? -b.diff_minutes : 0;
  };
  const chosenTotal = useMemo(() => {
    if (!canRespond) return 0;
    return options.reduce((s, o) => (picks[o.id]?.chosen ? s + offsetPreview(o) : s), 0);
  }, [picks, options, patterns, calendarKinds, canRespond]);

  const setPick = (id: string, patch: Partial<{ chosen: boolean; date: string; time: string }>) =>
    setPicks(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const submitAccept = async () => {
    if (!proposal) return;
    setError('');
    const chosen = options.filter(o => picks[o.id]?.chosen);
    if (chosen.length === 0) { setError('候補を1つ以上選ぶか、「後日あらためて調整する」を押してください'); return; }
    // 事前検証（buildＯＫ・同日重複なし）
    for (const o of chosen) {
      const pk = picks[o.id];
      const isChosei = o.kind === 'chosei_off';
      if (!pk.date || (!isChosei && !pk.time)) { setError('選んだ候補の日付・時刻を入れてください'); return; }
      if (existingDates.has(pk.date)) { setError(`${pk.date} は既に残業記録があります。別日でのカスタムか、この候補は外してください`); return; }
      if (!isChosei) { const b = buildFor(o); if (!b || !b.ok) { setError(`${pk.date} はこの日のシフトから調整分を計算できませんでした`); return; } }
    }
    setSubmitting(true);
    try {
      // 1) 排他クレーム（二重回答防止）。responded に一回だけ遷移＋selection反映
      const respOptions = options.map(o => {
        const pk = picks[o.id];
        const chosenIt = !!pk?.chosen;
        const customized = chosenIt && (pk.date !== o.work_date || pk.time !== (o.adjust_time ?? '').slice(0, 5));
        return { option_id: o.id, selection: chosenIt ? (customized ? 'custom' : 'accepted') : 'declined',
          custom_date: chosenIt ? pk.date : null, custom_time: chosenIt ? pk.time : null };
      });
      const { data: claimed, error: rErr } = await supabase.rpc('respond_overtime_adjustment_proposal', { p_proposal_id: proposal.id, p_note: note.trim() || null, p_options: respOptions });
      if (rErr) { setError('回答の記録に失敗しました：' + rErr.message); setSubmitting(false); return; }
      if (claimed === false) { setError('この提案は既に回答済みです'); setSubmitting(false); setDone('accepted'); return; }

      // 回答者名（提案者への通知に使う）。profiles を正とし、取れなければ従来どおりのフォールバック
      const { data: meProf } = await supabase.from('profiles').select('name').eq('id', currentUserId).maybeSingle();
      const responderName = (meProf as { name?: string } | null)?.name
        ?? (await supabase.auth.getUser()).data.user?.user_metadata?.name
        ?? 'スタッフ';

      // 2) 受諾ぶんを作成。時間調整＝overtime_reports（既存計算）／調整休＝leave_requests(pending)。
      for (const o of chosen) {
        const pk = picks[o.id];
        if (o.kind === 'chosei_off') {
          // 時間外調整休：pending で作成→上長の通常承認(approved)で相殺トリガ発火(R1)。
          // トリガ条件 chosei_sub_type='zangyou' を明示し、reason にも「時間外調整休」を埋め込む。
          const { data: lr, error: lrErr } = await supabase.from('leave_requests').insert({
            user_id: currentUserId, leave_type: '調整休', leave_type_other: null,
            leave_dates: JSON.stringify([pk.date]),
            leave_locations: JSON.stringify({ [pk.date]: o.location ?? '' }),
            chosei_origin_locations: null, chosei_sub_type: 'zangyou',
            start_date: pk.date, end_date: pk.date,
            purpose: '残業調整（提案受諾）', reason: `時間外調整休${o.note ? `（${o.note}）` : ''}`,
            status: 'pending', current_approver: 'first', approver_id: proposal.proposer_id,
          }).select('id').single();
          if (lrErr || !lr) continue;
          await supabase.from('overtime_adjustment_proposal_options').update({ result_type: 'leave_request', result_id: (lr as { id: string }).id }).eq('id', o.id);
          // 提案者（＝この休暇申請の承認者）へ leave:new_request を送る。
          // 通常の休暇申請（LeaveRequest.tsx）と同じ配線：Slack＋サイト通知＋メール。
          // これが無いと「回答しました」の通知だけで、承認待ちが1件増えたことが伝わらない
          // （残業側の受諾は notifyOvertimeNewRequest を送っており、それと対になる）。
          try {
            const vars = {
              申請者名: responderName,
              休暇種別: '調整休',
              申請日数: '1',
              リンク: 'https://fivem-portal.vercel.app/leave-approvals',
            };
            if (await shouldSend('leave:new_request', 'slack')) {
              await sendLeaveSlack('new_request', proposerName || 'スタッフ', proposerRole || 'リーダー');
            }
            await dispatchSiteNotification('leave:new_request', vars,
              { applicant: currentUserId, leader: proposal.proposer_id },
              insertNotification, 'leave_request:pending_approval', (lr as { id: string }).id);
            const applicantEmail = (await getUserEmail(currentUserId)) ?? '';
            const proposerEmail = (await getUserEmail(proposal.proposer_id)) ?? '';
            await dispatchEmail('leave:new_request', vars,
              { applicant: applicantEmail, leader: proposerEmail, approver: proposerEmail });
          } catch (e) {
            // 通知の失敗で受諾自体（申請の作成）は失敗させない
            console.error('[proposal-accept] leave:new_request 通知の送信失敗:', e);
          }
          continue;
        }
        const b = buildFor(o)!;
        const { data: rep, error: repErr } = await supabase.from('overtime_reports').insert({
          applicant_id: currentUserId, submitted_by: currentUserId, entry_type: 'manual',
          work_date: pk.date, pay_period_start: calcPayPeriodStartJst(pk.date), is_post_hoc: false,
          status: 'requested', normal_shift: b.normal_shift, break_minutes: b.break_minutes, break_manual: false,
          labor_minutes: b.labor_minutes, diff_minutes: b.diff_minutes, legal_warning: false,
          reason: `残業調整の提案を受諾${o.note ? `（${o.note}）` : ''}`, location: o.location,
          application_types: b.application_types, reviewer_id: proposal.proposer_id,
        }).select('id').single();
        if (repErr || !rep) continue; // 同日重複(23505)等は個別スキップ（部分成功を許容）
        const reportId = (rep as { id: string }).id;
        // セグメント（planned）
        // seg_no は 1 始まり。DBの制約が check (seg_no between 1 and 3) なので、
        // 0 始まりだと配列ごと弾かれ「時間帯が1件も入らない」状態になる（実際にそうなっていた）
        const { error: segErr } = await supabase.from('overtime_report_segments').insert(
          b.segments.map((s, i) => {
            const st = timeToMin(s.start) ?? 0; let en = timeToMin(s.end) ?? st; if (en <= st) en += 1440;
            return { report_id: reportId, phase: 'planned', seg_no: i + 1, start_min: st, end_min: en };
          })
        );
        if (segErr) { setError('時間帯の保存に失敗しました：' + segErr.message); setSubmitting(false); return; }
        await supabase.from('overtime_adjustment_proposal_options').update({ result_type: 'overtime_report', result_id: reportId }).eq('id', o.id);
        // 提案者＝この申請の確認依頼先。通常の申請と同じく「申請が届きました」を送る
        // （提案への回答通知だけでは、確認待ちが1件増えたことが伝わらないため）
        await notifyOvertimeNewRequest({
          reportId,
          reviewerId: proposal.proposer_id,
          applicantName: responderName,
          phaseLabel: '事前申請',
          dateLabel: pk.date,
          timeLabel: formatSignedMin(b.diff_minutes),
        }).then(null, () => {});
      }
      // 3) 提案者への回答通知は RPC（respond_overtime_adjustment_proposal）の中で作られる。
      //    ここでクライアントから insert すると、回答者が一般・パート・フロア責任者のとき
      //    notifications の INSERT ポリシー（リーダー以上限定）で弾かれ、無言で届かない
      setDone('accepted');
    } catch (e) {
      setError('送信に失敗しました：' + String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const submitDecline = async () => {
    if (!proposal) return;
    setSubmitting(true); setError('');
    try {
      const respOptions = options.map(o => ({ option_id: o.id, selection: 'declined', custom_date: null, custom_time: null }));
      const { data: claimed, error: rErr } = await supabase.rpc('respond_overtime_adjustment_proposal', { p_proposal_id: proposal.id, p_note: note.trim() || null, p_options: respOptions });
      if (rErr) { setError('記録に失敗しました：' + rErr.message); setSubmitting(false); return; }
      if (claimed === false) { setDone('declined'); setSubmitting(false); return; }
      // 提案者への通知は RPC の中で作られる（クライアントからは RLS で入らない）
      setDone('declined');
    } catch (e) {
      setError('送信に失敗しました：' + String(e)); setSubmitting(false);
    }
  };

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '8px 0' }}>
      <button onClick={onClose} style={{ background: 'none', border: `1px solid ${border}`, borderRadius: 8, cursor: 'pointer', fontSize: 12.5, color: subText, padding: '5px 10px', marginBottom: 12 }}>← 戻る</button>

      {loading ? <p style={{ color: subText, textAlign: 'center' }}>読み込み中…</p>
      : loadError ? <p style={{ color: subText, textAlign: 'center', lineHeight: 1.7 }}>{loadError}</p>
      : proposal && (
        <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${border}`, padding: 16 }}>
          <h3 style={{ margin: '0 0 6px', fontSize: 16, color: text }}>🕐 残業調整のご提案</h3>

          {done ? (
            <div style={{ padding: '12px 14px', background: isDark ? '#1b4d1b' : '#f0fff4', border: `1px solid ${isDark ? '#2d5a2d' : '#c3e6cb'}`, borderRadius: 8, fontSize: 13.5, color: isDark ? '#a3d9a3' : '#1e7e34', lineHeight: 1.7 }}>
              {done === 'accepted' ? '✓ 回答しました。ありがとうございます。選んだ調整は残業記録に反映され、上長の確認後に確定します。' : '✓ 承知しました。無理なさらず、別日・後日で調整してください。'}
            </div>
          ) : canRespond ? (
            <>
              <p style={{ margin: '0 0 12px', fontSize: 13, color: subText, lineHeight: 1.7 }}>
                お疲れ様です。残業分の調整日についての相談です。下の候補から調整可能な日があれば選んでください（複数選択可）。提案日での調整が難しければ、「後日あらためて調整する」で問題ありません。
              </p>
              {proposal.remarks && <div style={{ marginBottom: 12, padding: '8px 12px', background: inputBg, borderRadius: 8, fontSize: 12.5, color: text }}>📝 {proposal.remarks}</div>}
              {proposal.response_due_date && <p style={{ margin: '0 0 12px', fontSize: 12, color: subText }}>🗓 {proposal.response_due_date} までにお返事をいただけると助かります（任意）</p>}

              {options.map(o => {
                const pk = picks[o.id]; if (!pk) return null;
                const isChosei = o.kind === 'chosei_off';
                const dup = existingDates.has(pk.date);
                const off = offsetPreview(o);
                const calcOk = isChosei ? off > 0 : !!buildFor(o)?.ok;
                return (
                  <div key={o.id} style={{ border: `1px solid ${pk.chosen ? '#1565c0' : border}`, borderRadius: 10, padding: 12, marginBottom: 10, background: pk.chosen ? (isDark ? '#14304d' : '#f0f7ff') : 'transparent' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                      <input type="checkbox" checked={pk.chosen} onChange={e => setPick(o.id, { chosen: e.target.checked })} style={{ width: 20, height: 20 }} />
                      <span style={{ fontSize: 14, fontWeight: 'bold', color: o.kind === 'late_start' ? '#558b2f' : o.kind === 'early_end' ? '#7b1fa2' : '#b7770d' }}>{KIND_LABEL[o.kind]}</span>
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: isChosei ? '1fr' : '1fr 1fr', gap: 8, marginTop: 8 }}>
                      <label style={{ fontSize: 11, color: subText }}>日付
                        <input type="date" value={pk.date} onChange={e => setPick(o.id, { date: e.target.value })} style={{ ...selStyle, width: '100%', marginTop: 2 }} />
                      </label>
                      {!isChosei && (
                        <label style={{ fontSize: 11, color: subText }}>{o.kind === 'late_start' ? '出勤時刻' : '退勤時刻'}
                          <input type="time" value={pk.time} onChange={e => setPick(o.id, { time: e.target.value })} style={{ ...selStyle, width: '100%', marginTop: 2 }} />
                        </label>
                      )}
                    </div>
                    {o.location && <div style={{ fontSize: 11.5, color: subText, marginTop: 6 }}>校：{o.location}</div>}
                    {o.note && <div style={{ fontSize: 11.5, color: subText, marginTop: 2 }}>メモ：{o.note}</div>}
                    <div style={{ fontSize: 11.5, color: dup ? '#dc3545' : subText, marginTop: 6 }}>
                      {dup ? '⚠️ この日は既に残業記録があります。別日にしてください'
                        : calcOk ? `相殺見込み：${fmtMin(off)}` : 'この日のシフトから相殺分を計算できません'}
                    </div>
                  </div>
                );
              })}

              <div style={{ background: isDark ? '#1a3a5c' : '#e8f4fd', borderRadius: 10, padding: '8px 12px', marginBottom: 12, fontSize: 13, color: text }}>
                選択中の相殺見込み：<strong>{fmtMin(chosenTotal)}</strong>
              </div>

              <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="ひとこと（任意）例：この期間は忙しいため、来期に調整します" style={{ ...selStyle, width: '100%', marginBottom: 12, resize: 'vertical' }} />
              {error && <div style={{ color: '#dc3545', fontSize: 13, marginBottom: 10 }}>⚠️ {error}</div>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button onClick={submitAccept} disabled={submitting} style={{ padding: 12, background: submitting ? '#9ec8f0' : '#1565c0', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 'bold', cursor: submitting ? 'not-allowed' : 'pointer' }}>選んだ日で調整する</button>
                <button onClick={submitDecline} disabled={submitting} style={{ padding: 11, background: 'none', color: subText, border: `1px solid ${border}`, borderRadius: 10, fontSize: 13.5, cursor: submitting ? 'not-allowed' : 'pointer' }}>後日あらためて調整する</button>
              </div>
            </>
          ) : (
            // 読み取り専用（提案者・上長・管理者、または回答済み）
            <>
              <p style={{ margin: '0 0 10px', fontSize: 12.5, color: subText }}>
                提案者：{proposerName} ／ 状態：{proposal.status === 'open' ? '未回答' : proposal.status === 'responded' ? '回答あり' : '取り下げ'}
              </p>
              {proposal.remarks && <div style={{ marginBottom: 10, padding: '8px 12px', background: inputBg, borderRadius: 8, fontSize: 12.5, color: text }}>📝 {proposal.remarks}</div>}
              {options.map(o => (
                <div key={o.id} style={{ border: `1px solid ${border}`, borderRadius: 10, padding: '10px 12px', marginBottom: 8, fontSize: 13, color: text }}>
                  <div style={{ fontWeight: 'bold' }}>{KIND_LABEL[o.kind]}　{(o.custom_date ?? o.work_date)}　{(o.custom_time ?? o.adjust_time ?? '').slice(0, 5)}</div>
                  <div style={{ fontSize: 12, color: subText, marginTop: 2 }}>
                    {o.selection === 'accepted' ? '✓ 採用' : o.selection === 'custom' ? '✓ 採用（変更あり）' : o.selection === 'declined' ? '— 見送り' : '未回答'}
                    {o.location ? `／校：${o.location}` : ''}
                  </div>
                </div>
              ))}
              {proposal.recipient_note && <div style={{ marginTop: 8, fontSize: 12.5, color: subText }}>相手のひとこと：{proposal.recipient_note}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default OvertimeProposalResponse;
