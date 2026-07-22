import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { insertNotification } from '../lib/notifications';
import { resolveNormalShift, buildTimeAdjustReport } from '../lib/overtimeShift';
import type { PatternRow } from '../lib/overtimeShift';

// 残業調整 提案作成シート（時間調整＝遅出/早退／調整休＝時間外調整休）。
// 部門集計→個人詳細（MemberDetailView）から開く。上長が相手の残業残高を見ながら候補を組み、提案を作成する。
// ・相殺分は "見込み"（提案時点の曜日パターンから算出）。確定は相手の受諾時。
// ・strong 強制ではない丁寧な提案。テンプレ（過去提案の複製）にも対応（initialCandidates/initialRemarks）。

type Kind = 'late_start' | 'early_end' | 'chosei_off';
export interface DraftCandidate { kind: Kind; date: string; time: string; location: string; note: string; }
interface Candidate extends DraftCandidate { tmpId: string; }

const KIND_LABEL: Record<Kind, string> = { late_start: '🟢 遅出（出勤を遅く）', early_end: '🟣 早退（退勤を早く）', chosei_off: '🟠 時間外調整休（1日）' };
const fmtMin = (min: number): string => {
  const s = min < 0 ? '−' : ''; const a = Math.abs(min);
  const h = Math.floor(a / 60), mm = a % 60;
  return `${s}${h > 0 ? `${h}時間` : ''}${mm > 0 || h === 0 ? `${mm}分` : ''}`;
};

interface Props {
  proposerId: string;
  proposerName: string;
  recipientId: string;
  recipientName: string;
  period: string;
  currentOvertimeMinutes: number;
  isDark: boolean;
  initialCandidates?: DraftCandidate[]; // テンプレ複製用
  initialRemarks?: string;
  onClose: () => void;
  onSubmitted: () => void;
}

const OvertimeProposalSheet: React.FC<Props> = ({
  proposerId, proposerName, recipientId, recipientName, period, currentOvertimeMinutes, isDark,
  initialCandidates, initialRemarks, onClose, onSubmitted,
}) => {
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const cardBg = isDark ? '#343a40' : '#fff';
  const inputBg = isDark ? '#2b3035' : '#fff';
  const selStyle: React.CSSProperties = { padding: '8px', borderRadius: 8, border: `1px solid ${border}`, fontSize: 14, background: inputBg, color: text, boxSizing: 'border-box' };

  const [candidates, setCandidates] = useState<Candidate[]>(
    () => (initialCandidates ?? []).map(c => ({ ...c, tmpId: Math.random().toString(36).slice(2) })),
  );
  const [remarks, setRemarks] = useState(initialRemarks ?? '');
  const [dueDate, setDueDate] = useState('');
  const [workplaces, setWorkplaces] = useState<string[]>([]);
  const [patterns, setPatterns] = useState<PatternRow[]>([]);
  const [existingDates, setExistingDates] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    supabase.from('master_options').select('value').eq('category', 'workplace').order('sort_order')
      .then(({ data }) => { if (data) setWorkplaces(data.map((r: { value: string }) => r.value)); });
    supabase.from('weekly_shift_patterns').select('*').eq('user_id', recipientId)
      .then(({ data }) => { if (data) setPatterns(data as PatternRow[]); });
    supabase.from('overtime_reports').select('work_date').eq('applicant_id', recipientId).eq('pay_period_start', period).neq('status', 'cancelled')
      .then(({ data }) => { if (data) setExistingDates(new Set((data as { work_date: string }[]).map(r => r.work_date))); });
  }, [recipientId, period]);

  // 候補1件の見込み相殺（分・正の値）。時間調整＝buildTimeAdjustReport、調整休＝その日の通常労働。
  const offsetOf = (c: Candidate): number => {
    if (!c.date) return 0;
    if (c.kind === 'chosei_off') return resolveNormalShift(patterns, c.date, null).labor_minutes;
    if (!c.time) return 0;
    const b = buildTimeAdjustReport(patterns, c.date, null, c.kind, c.time);
    return b.ok ? -b.diff_minutes : 0;
  };
  const totalOffset = useMemo(() => candidates.reduce((s, c) => s + offsetOf(c), 0), [candidates, patterns]);
  const remaining = currentOvertimeMinutes - totalOffset;

  const addCandidate = (kind: Kind) => setCandidates(cs => [...cs, { tmpId: Math.random().toString(36).slice(2), kind, date: '', time: '', location: '', note: '' }]);
  const updateCandidate = (id: string, patch: Partial<Candidate>) => setCandidates(cs => cs.map(c => c.tmpId === id ? { ...c, ...patch } : c));
  const removeCandidate = (id: string) => setCandidates(cs => cs.filter(c => c.tmpId !== id));

  const handleSubmit = async () => {
    setError('');
    if (candidates.length === 0) { setError('候補を1つ以上追加してください'); return; }
    for (const c of candidates) {
      const needsTime = c.kind !== 'chosei_off';
      if (!c.date || (needsTime && !c.time) || !c.location) { setError('各候補の日付・時刻・校を入力してください'); return; }
      if (existingDates.has(c.date)) { setError(`${c.date} は既に残業記録があります。別の日を選んでください`); return; }
    }
    setSubmitting(true);
    try {
      const { data: proposal, error: pErr } = await supabase.from('overtime_adjustment_proposals').insert({
        proposer_id: proposerId, recipient_id: recipientId, pay_period_start: period,
        overtime_snapshot_minutes: currentOvertimeMinutes, remarks: remarks.trim() || null,
        response_due_date: dueDate || null, status: 'open',
      }).select('id').single();
      if (pErr || !proposal) { setError('提案の作成に失敗しました：' + (pErr?.message ?? '')); setSubmitting(false); return; }
      const proposalId = (proposal as { id: string }).id;
      const { error: oErr } = await supabase.from('overtime_adjustment_proposal_options').insert(
        candidates.map(c => ({
          proposal_id: proposalId, kind: c.kind, work_date: c.date,
          adjust_time: c.kind === 'chosei_off' ? null : c.time,
          location: c.location, offset_minutes: offsetOf(c), note: c.note.trim() || null,
        }))
      );
      if (oErr) { setError('候補の保存に失敗しました：' + oErr.message); setSubmitting(false); return; }
      await insertNotification(
        recipientId,
        `${proposerName}さんから残業調整の提案が届きました`,
        `候補${candidates.length}件・お返事は任意です`,
        'overtime_proposal:received', proposalId, 'overtime_proposal:received',
      );
      onSubmitted();
      onClose();
    } catch (e) {
      setError('送信に失敗しました：' + String(e));
      setSubmitting(false);
    }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: cardBg, borderRadius: '16px 16px 0 0', padding: '20px 18px', width: '100%', maxWidth: 520, maxHeight: '92vh', overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 16, color: text }}>🕐 残業調整のご提案</h3>
        <p style={{ margin: '0 0 12px', fontSize: 12.5, color: subText, lineHeight: 1.6 }}>
          {recipientName}さんへ。取れそうな候補を組んでください（強制ではありません）。相殺分は見込みで、実際の分は相手の受諾時に確定します。
        </p>

        <div style={{ background: isDark ? '#1a3a5c' : '#e8f4fd', borderRadius: 10, padding: '10px 14px', marginBottom: 14 }}>
          <div style={{ fontSize: 12, color: subText }}>今期の残業</div>
          <div style={{ fontSize: 15, color: text }}>
            <strong>{fmtMin(currentOvertimeMinutes)}</strong>
            <span style={{ margin: '0 6px', color: subText }}>→ この提案で</span>
            <strong style={{ color: remaining <= 0 ? '#28a745' : (isDark ? '#ffd166' : '#b7770d') }}>{fmtMin(remaining)}</strong>
          </div>
          {totalOffset > 0 && <div style={{ fontSize: 11.5, color: subText, marginTop: 2 }}>（見込み相殺 {fmtMin(totalOffset)}）</div>}
        </div>

        {candidates.map(c => {
          const dup = c.date && existingDates.has(c.date);
          const isChosei = c.kind === 'chosei_off';
          return (
            <div key={c.tmpId} style={{ border: `1px solid ${dup ? '#f0a0a0' : border}`, borderRadius: 10, padding: 12, marginBottom: 10, background: dup ? (isDark ? '#3a2626' : '#fff5f5') : 'transparent' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 'bold', color: c.kind === 'late_start' ? '#558b2f' : c.kind === 'early_end' ? '#7b1fa2' : '#b7770d' }}>{KIND_LABEL[c.kind]}</span>
                <button onClick={() => removeCandidate(c.tmpId)} style={{ background: 'none', border: 'none', color: subText, cursor: 'pointer', fontSize: 16 }}>✕</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: isChosei ? '1fr' : '1fr 1fr', gap: 8 }}>
                <label style={{ fontSize: 11, color: subText }}>日付
                  <input type="date" value={c.date} onChange={e => updateCandidate(c.tmpId, { date: e.target.value })} style={{ ...selStyle, width: '100%', marginTop: 2 }} />
                </label>
                {!isChosei && (
                  <label style={{ fontSize: 11, color: subText }}>{c.kind === 'late_start' ? '出勤時刻' : '退勤時刻'}
                    <input type="time" value={c.time} onChange={e => updateCandidate(c.tmpId, { time: e.target.value })} style={{ ...selStyle, width: '100%', marginTop: 2 }} />
                  </label>
                )}
              </div>
              <label style={{ fontSize: 11, color: subText, display: 'block', marginTop: 8 }}>校
                <select value={c.location} onChange={e => updateCandidate(c.tmpId, { location: e.target.value })} style={{ ...selStyle, width: '100%', marginTop: 2 }}>
                  <option value="">選択してください</option>
                  {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
                </select>
              </label>
              <input type="text" value={c.note} onChange={e => updateCandidate(c.tmpId, { note: e.target.value })} placeholder="メモ（任意）" style={{ ...selStyle, width: '100%', marginTop: 8 }} />
              <div style={{ fontSize: 11.5, color: dup ? '#dc3545' : subText, marginTop: 6 }}>
                {dup ? '⚠️ この日は既に残業記録があります。別の日を選んでください'
                     : (c.date && (isChosei || c.time) ? `見込み相殺：${fmtMin(offsetOf(c))}` : '日付（と時刻）を入れると見込み相殺を表示します')}
              </div>
            </div>
          );
        })}

        <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <button onClick={() => addCandidate('late_start')} style={{ flex: 1, minWidth: 130, padding: 10, borderRadius: 8, border: `1px dashed ${border}`, background: 'none', color: '#558b2f', cursor: 'pointer', fontSize: 13, fontWeight: 'bold' }}>＋ 遅出</button>
          <button onClick={() => addCandidate('early_end')} style={{ flex: 1, minWidth: 130, padding: 10, borderRadius: 8, border: `1px dashed ${border}`, background: 'none', color: '#7b1fa2', cursor: 'pointer', fontSize: 13, fontWeight: 'bold' }}>＋ 早退</button>
          <button onClick={() => addCandidate('chosei_off')} style={{ flex: 1, minWidth: 130, padding: 10, borderRadius: 8, border: `1px dashed ${border}`, background: 'none', color: '#b7770d', cursor: 'pointer', fontSize: 13, fontWeight: 'bold' }}>＋ 調整休</button>
        </div>
        <p style={{ margin: '0 0 14px', fontSize: 11, color: subText }}>※ まず遅出・早退で相殺し、足りない分だけ調整休がおすすめです。</p>

        <label style={{ fontSize: 12, color: subText, display: 'block', marginBottom: 12 }}>備考（任意・相手にも表示。カレンダー等には残りません）
          <textarea value={remarks} onChange={e => setRemarks(e.target.value)} rows={2} placeholder="例：〇〇の対応を△△さんに依頼済み" style={{ ...selStyle, width: '100%', marginTop: 4, resize: 'vertical' }} />
        </label>
        <label style={{ fontSize: 12, color: subText, display: 'block', marginBottom: 14 }}>お返事の目安日（任意）
          <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} style={{ ...selStyle, width: '100%', marginTop: 4 }} />
        </label>

        {error && <div style={{ color: '#dc3545', fontSize: 13, marginBottom: 12, padding: '8px 12px', background: isDark ? '#3a2626' : '#fff5f5', borderRadius: 6 }}>⚠️ {error}</div>}

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, padding: 12, background: '#6c757d', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, cursor: 'pointer' }}>キャンセル</button>
          <button onClick={handleSubmit} disabled={submitting} style={{ flex: 2, padding: 12, background: submitting ? '#9ec8f0' : '#1565c0', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 'bold', cursor: submitting ? 'not-allowed' : 'pointer' }}>
            {submitting ? '送信中...' : '提案を送る'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default OvertimeProposalSheet;
