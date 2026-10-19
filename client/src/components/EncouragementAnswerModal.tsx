import React, { useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { ENC_CHOICES, ENC_OTHER_LEAVE_GUIDE } from '../lib/encouragementDay';
import { dayOffConflictText } from '../lib/dayOffConflictText';
import { syncEncouragementCalendar } from '../lib/gcalEncouragement';
import { BTN_BLUE } from '../lib/buttonStyles';

// 有休奨励日への回答（2026-10-19 にホーム（App.tsx）と休暇申請（LeaveRequest.tsx）の2か所のコピーを1つにまとめた）
// ・選択肢は lib/encouragementDay の ENC_CHOICES（管理画面の回答の修正と同じ）
// ・保存は DB の answer_encouragement_day 1本（回答と休暇を同じ処理で作る・2026-09-12）。
//   🚨 rpc は 4xx/5xx でも例外にならない。error と ok の両方を見る（CLAUDE.md）
// ・送ったあと、その日の Google カレンダーの予定を作り直す（待たない・失敗しても回答は済んでいる）
// ・止められたとき（休暇の重なり・奨励日の決まり）は DB が作った文をそのまま出す（'DAYOFF_CONFLICT|<文>'）

export interface EncAnswerDay { id: string; target_date: string; deadline: string }

const fmt = (d: string) => {
  const x = new Date(d + 'T00:00:00Z');
  return `${x.getUTCFullYear()}年${x.getUTCMonth() + 1}月${x.getUTCDate()}日(${['日', '月', '火', '水', '木', '金', '土'][x.getUTCDay()]})`;
};

const EncouragementAnswerModal: React.FC<{
  day: EncAnswerDay;
  isDark: boolean;
  onClose: () => void;
  /** 送れたあと（一覧の読み直し・成功の知らせなど） */
  onDone: () => void;
}> = ({ day, isDark, onClose, onDone }) => {
  const [choice, setChoice] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const text = isDark ? '#fff' : '#333';
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const picked = ENC_CHOICES.find(c => c.value === choice) ?? null;
  const needsNote = !!picked?.needsNote;
  const canSend = !!picked && (!needsNote || !!note.trim()) && !submitting;

  const submit = async () => {
    if (!picked || !canSend) return;
    setSubmitting(true);
    setError('');
    const { data, error: err } = await supabase.rpc('answer_encouragement_day', {
      p_day_id: day.id,
      p_choice: picked.value,
      p_note: note.trim() || null,
      p_working: picked.working === true,
    });
    const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; reason?: string } | null;
    if (err || !row?.ok) {
      setError(dayOffConflictText(err?.message) ?? (err?.message || row?.reason || '送信できませんでした。通信を確認してもう一度お試しください。'));
      setSubmitting(false);
      return;
    }
    void syncEncouragementCalendar(day.target_date);
    setSubmitting(false);
    onDone();
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: isDark ? '#343a40' : '#fff', borderRadius: 16, padding: 24, width: '100%', maxWidth: 420, maxHeight: '90vh', overflowY: 'auto', boxSizing: 'border-box' }}>
        <h3 style={{ margin: '0 0 4px', color: text, fontSize: 16 }}>📅 有休奨励日への回答</h3>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: sub }}>対象日: {fmt(day.target_date)} ／ 期限: {fmt(day.deadline)}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          {ENC_CHOICES.map(c => {
            const selected = choice === c.value;
            return (
              <button key={c.value} type="button" onClick={() => { setChoice(c.value); setError(''); }} style={{
                padding: '12px 16px', borderRadius: 10, border: selected ? `2px solid ${c.color}` : `1px solid ${isDark ? '#6c757d' : '#dee2e6'}`,
                background: selected ? c.color : (isDark ? '#495057' : '#f8f9fa'),
                color: selected ? '#fff' : text, fontSize: 14, fontWeight: selected ? 'bold' : 'normal', cursor: 'pointer', textAlign: 'left',
              }}>
                {c.label}
                {c.sub && <div style={{ fontSize: 11.5, fontWeight: 'normal', marginTop: 2 }}>{c.sub}</div>}
              </button>
            );
          })}
        </div>
        {needsNote && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: sub, display: 'block', marginBottom: 4 }}>内容（必須）</label>
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${isDark ? '#6c757d' : '#ccc'}`, background: isDark ? '#495057' : '#fff', color: text, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
              placeholder={choice === 4 ? '例：イベントのため出勤' : '例：忌引きのため慶弔休暇を申請します'} />
          </div>
        )}
        {choice === 5 && (
          <div style={{ marginBottom: 12, padding: '8px 10px', borderRadius: 8, background: '#fff3cd', border: '1px solid #ffc107', color: '#856404', fontSize: 12.5, lineHeight: 1.6 }}>
            {ENC_OTHER_LEAVE_GUIDE}
          </div>
        )}
        {error && (
          <div style={{ marginBottom: 12, padding: '8px 10px', borderRadius: 8, background: '#f8d7da', color: '#842029', fontSize: 12, lineHeight: 1.6 }}>{error}</div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" onClick={onClose}
            style={{ flex: 1, padding: '10px 0', background: isDark ? '#495057' : '#e9ecef', color: text, border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 13 }}>キャンセル</button>
          <button type="button" disabled={!canSend} onClick={() => void submit()}
            style={{ flex: 2, padding: '10px 0', background: !canSend ? '#6c757d' : BTN_BLUE, color: '#fff', border: 'none', borderRadius: 10, cursor: canSend ? 'pointer' : 'default', fontSize: 13, fontWeight: 'bold' }}>
            {submitting ? '送信中...' : '回答を送信'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default EncouragementAnswerModal;
