import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { insertNotification } from '../lib/notifications';
import { resolveNormalShift, buildTimeAdjustReport, normalShiftTimeText } from '../lib/overtimeShift';
import { ERROR_BORDER, errorBg, scrollToFirstError } from '../lib/formHighlight';
import type { PatternRow } from '../lib/overtimeShift';

// 残業調整 提案作成シート（時間調整＝遅出/早退／調整休＝時間外調整休）。
// 部門集計→個人詳細（MemberDetailView）から開く。上長が相手の残業残高を見ながら候補を組み、提案を作成する。
// ・相殺分は "見込み"（提案時点の曜日パターンから算出）。確定は相手の受諾時。
// ・strong 強制ではない丁寧な提案。テンプレ（過去提案の複製）にも対応（initialCandidates/initialRemarks）。

type Kind = 'late_start' | 'early_end' | 'chosei_off';
export interface DraftCandidate { kind: Kind; date: string; time: string; location: string; note: string; }
interface Candidate extends DraftCandidate { tmpId: string; }

const KIND_LABEL: Record<Kind, string> = { late_start: '🟢 遅出（出勤を遅く）', early_end: '🟣 早退（退勤を早く）', chosei_off: '🟠 時間外調整休（1日）' };
// 種別の文字色（ダークモードでは暗い背景でも読めるよう明るめの色に切替）
const KIND_COLOR: Record<Kind, { light: string; dark: string }> = {
  late_start: { light: '#558b2f', dark: '#8fd19e' }, // 緑
  early_end:  { light: '#7b1fa2', dark: '#ce93d8' }, // 紫
  chosei_off: { light: '#b7770d', dark: '#ffb74d' }, // 橙
};
const fmtMin = (min: number): string => {
  const s = min < 0 ? '−' : ''; const a = Math.abs(min);
  const h = Math.floor(a / 60), mm = a % 60;
  return `${s}${h > 0 ? `${h}時間` : ''}${mm > 0 || h === 0 ? `${mm}分` : ''}`;
};
// ISO日付 → "2026/07/27（月）"
const jpDate = (iso: string): string => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dow = ['日', '月', '火', '水', '木', '金', '土'][new Date(iso + 'T00:00:00').getDay()];
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}（${dow}）`;
};

// タップで開閉する日付フィールド（スマホで1タップ確定・OSピッカー不要）
const DateField: React.FC<{ value: string; onChange: (d: string) => void; isDark: boolean; placeholder?: string }> = ({ value, onChange, isDark, placeholder }) => {
  const [open, setOpen] = useState(false);
  const base = value ? new Date(value + 'T00:00:00') : new Date();
  const [vy, setVy] = useState(base.getFullYear());
  const [vm, setVm] = useState(base.getMonth());
  const text = isDark ? '#f8f9fa' : '#212529';
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const inputBg = isDark ? '#2b3035' : '#fff';
  const fmt = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const daysInMonth = new Date(vy, vm + 1, 0).getDate();
  const firstDay = new Date(vy, vm, 1).getDay();
  const t = new Date(); const todayStr = fmt(t.getFullYear(), t.getMonth(), t.getDate());
  const cells: (number | null)[] = [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const prev = () => { if (vm === 0) { setVy(y => y - 1); setVm(11); } else setVm(m => m - 1); };
  const next = () => { if (vm === 11) { setVy(y => y + 1); setVm(0); } else setVm(m => m + 1); };
  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)} style={{ width: '100%', textAlign: 'left', padding: '9px 12px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: value ? text : sub, fontSize: 14, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{value ? jpDate(value) : (placeholder ?? '日付を選ぶ')}</span>
        <span style={{ fontSize: 12, color: sub }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ background: isDark ? '#495057' : '#f8f9fa', borderRadius: 10, padding: 12, border: `1px solid ${border}`, marginTop: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <button type="button" onClick={prev} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: text, padding: '0 10px', lineHeight: 1 }}>‹</button>
            <span style={{ fontWeight: 'bold', color: text, fontSize: 15 }}>{vy}年 {vm + 1}月</span>
            <button type="button" onClick={next} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: text, padding: '0 10px', lineHeight: 1 }}>›</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
            {['日', '月', '火', '水', '木', '金', '土'].map((d, i) => (<div key={d} style={{ textAlign: 'center', fontSize: 11, fontWeight: 'bold', color: i === 0 ? '#e74c3c' : i === 6 ? '#3498db' : text, padding: '3px 0' }}>{d}</div>))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
            {cells.map((day, i) => {
              if (!day) return <div key={`e-${i}`} />;
              const iso = fmt(vy, vm, day);
              const sel = iso === value; const isT = iso === todayStr;
              const dow = (firstDay + day - 1) % 7;
              return (
                <button key={iso} type="button" onClick={() => { onChange(iso); setOpen(false); }}
                  style={{ padding: '10px 2px', minHeight: 40, borderRadius: 6, border: isT ? '2px solid #007bff' : '1px solid transparent', background: sel ? '#28a745' : 'transparent', color: sel ? '#fff' : dow === 0 ? '#e74c3c' : dow === 6 ? '#3498db' : text, cursor: 'pointer', fontSize: 13, fontWeight: sel ? 'bold' : 'normal', textAlign: 'center' }}>
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
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
  // 入力が足りない候補カードを薄赤にする（lib/formHighlight.ts の共通色）
  const [errIds, setErrIds] = useState<Set<string>>(new Set());
  // 相手に通知が飛ぶため、送信前の確認画面を出す
  const [showConfirm, setShowConfirm] = useState(false);

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
  const kindColor = (k: Kind) => isDark ? KIND_COLOR[k].dark : KIND_COLOR[k].light;
  // シフトの校名を校の選択値に変換。移動表記(A→B)は行き先を採用し、空白差を無視して勤務地一覧に寄せる。
  // 一覧に無くてもクリーンな校名をそのまま返す（select側でフォールバック表示するため空にしない）。
  const pickWorkplace = (loc: string | null | undefined): string => {
    if (!loc) return '';
    const dest = loc.includes('→') ? (loc.split('→').pop() ?? loc) : loc;
    const raw = dest.trim();
    const norm = (s: string) => s.replace(/[\s　]/g, '');
    return workplaces.find(w => w === raw) ?? workplaces.find(w => norm(w) === norm(raw)) ?? raw;
  };
  // 日付変更時：その日の通常シフトの校に自動追従。時刻は「提案する調整後の時刻」なので触らない。
  const handleDateChange = (id: string, newDate: string) => {
    const patch: Partial<Candidate> = { date: newDate };
    if (newDate) {
      const wp = pickWorkplace(resolveNormalShift(patterns, newDate, null).location);
      if (wp) patch.location = wp;
    }
    updateCandidate(id, patch);
  };

  const handleSubmit = () => {
    setError('');
    setErrIds(new Set());
    if (candidates.length === 0) { setError('候補を1つ以上追加してください'); return; }
    // 足りない候補をまとめて薄赤にする（どの候補が原因か分からないと直せない）
    const bad = new Set<string>();
    for (const c of candidates) {
      const needsTime = c.kind !== 'chosei_off';
      if (!c.date || (needsTime && !c.time) || !c.location) bad.add(c.tmpId);
    }
    if (bad.size > 0) {
      setError('各候補の日付・時刻・校を入力してください');
      setErrIds(bad);
      scrollToFirstError([...bad]);
      return;
    }
    for (const c of candidates) {
      if (existingDates.has(c.date)) { setError(`${c.date} は既に残業記録があります。別の日を選んでください`); setErrIds(new Set([c.tmpId])); scrollToFirstError([c.tmpId]); return; }
    }
    // 相手に通知が飛ぶので、送信前に内容を確認できるようにする
    setShowConfirm(true);
  };

  const doSubmit = async () => {
    setShowConfirm(false);
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
            <strong style={{ color: remaining <= 0 ? (isDark ? '#5dd882' : '#28a745') : (isDark ? '#ffd166' : '#b7770d') }}>{fmtMin(remaining)}</strong>
          </div>
          {totalOffset > 0 && <div style={{ fontSize: 11.5, color: subText, marginTop: 2 }}>（見込み相殺 {fmtMin(totalOffset)}）</div>}
        </div>

        {candidates.map(c => {
          const dup = c.date && existingDates.has(c.date);
          const isChosei = c.kind === 'chosei_off';
          return (
            <div
              key={c.tmpId} data-err-field={c.tmpId}
              style={{
                border: `1px solid ${dup || errIds.has(c.tmpId) ? ERROR_BORDER : border}`, borderRadius: 10, padding: 12, marginBottom: 10,
                background: dup || errIds.has(c.tmpId) ? errorBg(isDark) : 'transparent',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 'bold', color: kindColor(c.kind) }}>{KIND_LABEL[c.kind]}</span>
                <button onClick={() => removeCandidate(c.tmpId)} style={{ background: 'none', border: 'none', color: subText, cursor: 'pointer', fontSize: 16 }}>✕</button>
              </div>
              <div style={{ fontSize: 11, color: subText, marginBottom: 2 }}>日付</div>
              <DateField value={c.date} onChange={d => handleDateChange(c.tmpId, d)} isDark={isDark} placeholder="日付を選ぶ" />
              {c.date && (() => {
                const ns = resolveNormalShift(patterns, c.date, null);
                const timeStr = normalShiftTimeText(ns);
                const hasShift = !!timeStr;
                return (
                  <div style={{ fontSize: 11.5, color: subText, marginTop: 6 }}>
                    {hasShift
                      ? `🕘 通常シフト ${timeStr}${ns.location ? `［${ns.location}］` : ''}（労働 ${fmtMin(ns.labor_minutes)}）`
                      : '🕘 この日は通常お休みです'}
                  </div>
                );
              })()}
              {!isChosei && (
                <label style={{ fontSize: 11, color: subText, display: 'block', marginTop: 8 }}>{c.kind === 'late_start' ? '出勤時刻（提案する時刻）' : '退勤時刻（提案する時刻）'}
                  <input type="time" value={c.time} onChange={e => updateCandidate(c.tmpId, { time: e.target.value })} style={{ ...selStyle, width: '100%', marginTop: 2, colorScheme: isDark ? 'dark' : 'light' }} />
                </label>
              )}
              <label style={{ fontSize: 11, color: subText, display: 'block', marginTop: 8 }}>校
                <select value={c.location} onChange={e => updateCandidate(c.tmpId, { location: e.target.value })} style={{ ...selStyle, width: '100%', marginTop: 2 }}>
                  <option value="">選択してください</option>
                  {c.location && !workplaces.includes(c.location) && <option value={c.location}>{c.location}</option>}
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

        {candidates.length === 0 && (
          <div style={{ border: `1px dashed ${border}`, borderRadius: 10, padding: '16px 12px', marginBottom: 10, textAlign: 'center', color: subText, fontSize: 12.5, lineHeight: 1.7 }}>
            まだ候補がありません。<br />下のボタンで、取れそうな日を追加してください ↓
          </div>
        )}
        <div style={{ fontSize: 12.5, fontWeight: 'bold', color: text, margin: '2px 0 6px' }}>
          {candidates.length === 0 ? '候補を追加（種別を選んでください・いくつでもOK）' : '＋ 別の候補を追加する'}
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <button onClick={() => addCandidate('late_start')} style={{ flex: 1, minWidth: 130, padding: 10, borderRadius: 8, border: `1px dashed ${border}`, background: 'none', color: kindColor('late_start'), cursor: 'pointer', fontSize: 13, fontWeight: 'bold' }}>＋ 遅出</button>
          <button onClick={() => addCandidate('early_end')} style={{ flex: 1, minWidth: 130, padding: 10, borderRadius: 8, border: `1px dashed ${border}`, background: 'none', color: kindColor('early_end'), cursor: 'pointer', fontSize: 13, fontWeight: 'bold' }}>＋ 早退</button>
          <button onClick={() => addCandidate('chosei_off')} style={{ flex: 1, minWidth: 130, padding: 10, borderRadius: 8, border: `1px dashed ${border}`, background: 'none', color: kindColor('chosei_off'), cursor: 'pointer', fontSize: 13, fontWeight: 'bold' }}>＋ 調整休</button>
        </div>
        <p style={{ margin: '0 0 14px', fontSize: 11, color: subText }}>※ まず遅出・早退で相殺し、足りない分だけ調整休がおすすめです。</p>

        <label style={{ fontSize: 12, color: subText, display: 'block', marginBottom: 12 }}>備考（任意・相手にも表示。カレンダー等には残りません）
          <textarea value={remarks} onChange={e => setRemarks(e.target.value)} rows={2} placeholder="例：〇〇の対応を△△さんに依頼済み" style={{ ...selStyle, width: '100%', marginTop: 4, resize: 'vertical' }} />
        </label>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>お返事の目安日（任意）</div>
          <DateField value={dueDate} onChange={setDueDate} isDark={isDark} placeholder="日付を選ぶ（任意）" />
        </div>

        {error && <div style={{ color: '#842029', fontSize: 13, marginBottom: 12, padding: '8px 12px', background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 6 }}>⚠️ {error}</div>}

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, padding: 12, background: '#6c757d', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, cursor: 'pointer' }}>キャンセル</button>
          <button onClick={handleSubmit} disabled={submitting} style={{ flex: 2, padding: 12, background: submitting ? '#9ec8f0' : '#1565c0', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 'bold', cursor: submitting ? 'not-allowed' : 'pointer' }}>
            {submitting ? '送信中...' : '提案を送る'}
          </button>
        </div>
      </div>

      {/* 送信前の確認画面。相手（部下・同格）に通知が飛ぶ操作なので、内容を読み合わせてから送る */}
      {showConfirm && (
        <div
          onClick={() => setShowConfirm(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
        >
          <div onClick={e => e.stopPropagation()} style={{ background: cardBg, borderRadius: 12, padding: 18, width: '100%', maxWidth: 420, maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ fontSize: 15, fontWeight: 'bold', color: text, marginBottom: 4, textAlign: 'center' }}>この内容で提案します</div>
            <div style={{ fontSize: 12, color: subText, marginBottom: 12, textAlign: 'center' }}>
              {recipientName}さんに通知が届きます（お返事は任意です）
            </div>

            <div style={{ border: `1px solid ${border}`, borderRadius: 8, padding: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>候補（{candidates.length}件）</div>
              {candidates.map(c => (
                <div key={c.tmpId} style={{ fontSize: 13, color: text, marginBottom: 4 }}>
                  <span style={{ color: kindColor(c.kind), fontWeight: 'bold' }}>{KIND_LABEL[c.kind]}</span>
                  <div style={{ paddingLeft: 4 }}>
                    {jpDate(c.date)}
                    {c.kind !== 'chosei_off' && c.time && `　${c.time}`}
                    {c.location && `　${c.location}`}
                  </div>
                  {c.note.trim() && <div style={{ fontSize: 12, color: subText, paddingLeft: 4 }}>{c.note}</div>}
                </div>
              ))}
            </div>

            {remarks.trim() && (
              <div style={{ fontSize: 13, color: text, marginBottom: 8 }}>
                <span style={{ color: subText }}>ひとこと：</span>{remarks}
              </div>
            )}
            {dueDate && (
              <div style={{ fontSize: 13, color: text, marginBottom: 8 }}>
                <span style={{ color: subText }}>お返事の目安：</span>{jpDate(dueDate)}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button onClick={() => setShowConfirm(false)} style={{ flex: 1, padding: 12, background: 'transparent', color: text, border: `1px solid ${border}`, borderRadius: 10, fontSize: 14, cursor: 'pointer' }}>修正する</button>
              <button onClick={doSubmit} disabled={submitting} style={{ flex: 2, padding: 12, background: submitting ? '#9ec8f0' : '#1565c0', color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 'bold', cursor: submitting ? 'not-allowed' : 'pointer' }}>
                {submitting ? '送信中...' : 'この内容で提案を送る'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default OvertimeProposalSheet;
