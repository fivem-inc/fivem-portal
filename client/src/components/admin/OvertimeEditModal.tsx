import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { calcTotalBreak, calcLaborMinutes, checkLegalBreak, timeToMin, minToTime, formatSignedMin, formatMin, type WorkSegment } from '../../lib/breakCalc';

// 管理者が残業レコードの内容を直接修正するモーダル。
// 休憩・実労働・差分・法定警告は申請フォームと同じ breakCalc で再計算（エンジン二重化を回避）。
// entry_type='manual' 限定（自動計上行は対象外）。理由必須 → 確認 → 原子的RPC → 本人通知。

interface Seg { phase: 'planned' | 'actual'; seg_no: number; start_min: number; end_min: number; }
export interface OvertimeRecord {
  id: string;
  applicant_id: string;
  applicantName?: string;
  work_date: string;
  entry_type: string;
  normal_shift: { labor_minutes: number; start_time?: string | null; end_time?: string | null; location?: string | null; [k: string]: unknown } | null;
  break_minutes: number | null;
  break_manual: boolean;
  labor_minutes: number | null;
  diff_minutes: number | null;
  reason: string | null;
  location: string | null;
  application_types?: string[] | null;
  segments: Seg[];
}

interface Props {
  record: OvertimeRecord;
  isDarkMode: boolean;
  onClose: () => void;
  onSaved: () => void;
}

// 分→"HH:MM"（翌日跨ぎは24時間で丸めて入力欄用に戻す）
const minToInput = (m: number): string => minToTime(m).replace('翌', '').padStart(5, '0');

const OvertimeEditModal: React.FC<Props> = ({ record, isDarkMode, onClose, onSaved }) => {
  // 編集対象phase：実績があれば実績、無ければ予定
  const phase: 'planned' | 'actual' = record.segments.some(s => s.phase === 'actual') ? 'actual' : 'planned';
  const initialSegs = record.segments.filter(s => s.phase === phase).sort((a, b) => a.seg_no - b.seg_no);

  const [rows, setRows] = useState<{ start: string; end: string }[]>(
    initialSegs.length ? initialSegs.map(s => ({ start: minToInput(s.start_min), end: minToInput(s.end_min % 1440) })) : [{ start: '', end: '' }],
  );
  const [breakManual, setBreakManual] = useState(record.break_manual);
  const [breakManualMin, setBreakManualMin] = useState(String(record.break_minutes ?? 0));
  const [reason, setReason] = useState(record.reason ?? '');
  const [locMode, setLocMode] = useState<'select' | 'other'>('select');
  const [location, setLocation] = useState(record.location ?? '');   // select時に選んだ校
  const [locationOther, setLocationOther] = useState('');            // その他（自由記載）
  const [workDate, setWorkDate] = useState(record.work_date);
  const [changeReason, setChangeReason] = useState('');
  const [workplaces, setWorkplaces] = useState<string[]>([]);
  const [step, setStep] = useState<'edit' | 'confirm'>('edit');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    supabase.from('master_options').select('value').eq('category', 'workplace').order('sort_order')
      .then(({ data }) => {
        const list = data ? data.map((r: { value: string }) => r.value) : [];
        setWorkplaces(list);
        // 既存の校がマスタに無い＝自由記載だった → その他モードに寄せる
        if (record.location && list.length && !list.includes(record.location)) {
          setLocMode('other'); setLocationOther(record.location); setLocation('');
        }
      });
  }, []);

  const effectiveLocation = locMode === 'other' ? locationOther.trim() : location;

  const cardBg = isDarkMode ? '#2d2d3e' : '#fff';
  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const text = isDarkMode ? '#eee' : '#222';
  const sub = isDarkMode ? '#adb5bd' : '#666';
  const inputBg = isDarkMode ? '#3a3a5c' : '#f8f9fa';
  const inputStyle: React.CSSProperties = { boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 14 };
  const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 'bold', color: text, marginBottom: 4, display: 'block' };

  // 実務時間帯（分）。深夜跨ぎは +1440。
  const workSegments: WorkSegment[] = useMemo(() =>
    rows.map(r => {
      const st = timeToMin(r.start); let en = timeToMin(r.end);
      if (st == null || en == null) return null;
      if (en <= st) en += 1440;
      return { startMin: st, endMin: en };
    }).filter((s): s is WorkSegment => s !== null),
  [rows]);

  const autoBreak = useMemo(() => calcTotalBreak(workSegments), [workSegments]);
  const breakMin = breakManual ? (parseInt(breakManualMin, 10) || 0) : autoBreak;
  const laborMin = calcLaborMinutes(workSegments, breakMin);
  const baseLabor = record.normal_shift?.labor_minutes ?? 0;
  const diffMin = laborMin - baseLabor;
  const legal = checkLegalBreak(workSegments, breakMin);

  const segLabel = (segs: WorkSegment[]) => (segs.length ? segs.map(s => `${minToTime(s.startMin)}〜${minToTime(s.endMin)}`).join('、') : '(なし)');
  const oldSegs: WorkSegment[] = initialSegs.map(s => ({ startMin: s.start_min, endMin: s.end_min }));

  const changes = useMemo(() => {
    const c: Record<string, { old: unknown; new: unknown }> = {};
    if (record.work_date !== workDate) c.work_date = { old: record.work_date, new: workDate };
    if (segLabel(oldSegs) !== segLabel(workSegments)) c.segments = { old: segLabel(oldSegs), new: segLabel(workSegments) };
    if ((record.break_minutes ?? 0) !== breakMin) c.break_minutes = { old: `${record.break_minutes ?? 0}分`, new: `${breakMin}分` };
    if ((record.diff_minutes ?? 0) !== diffMin) c.diff_minutes = { old: formatSignedMin(record.diff_minutes ?? 0), new: formatSignedMin(diffMin) };
    if ((record.location ?? '') !== effectiveLocation) c.location = { old: record.location ?? '', new: effectiveLocation };
    if ((record.reason ?? '') !== reason) c.reason = { old: record.reason ?? '', new: reason };
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, workDate, workSegments, breakMin, diffMin, effectiveLocation, reason]);

  const changedCount = Object.keys(changes).length;
  const FIELD_LABELS: Record<string, string> = { work_date: '勤務日', segments: '時間帯', break_minutes: '休憩', diff_minutes: '差分時間', location: '校', reason: '理由' };
  const summary = Object.keys(changes).map(k => FIELD_LABELS[k] ?? k).join('・') + 'を修正';

  const setRow = (i: number, key: 'start' | 'end', v: string) => setRows(prev => prev.map((r, idx) => (idx === i ? { ...r, [key]: v } : r)));
  const addRow = () => setRows(prev => (prev.length >= 3 ? prev : [...prev, { start: '', end: '' }]));
  const removeRow = (i: number) => setRows(prev => prev.filter((_, idx) => idx !== i));

  const goConfirm = () => {
    setError('');
    if (workSegments.length === 0) { setError('勤務時間帯を入力してください。'); return; }
    const sorted = [...workSegments].sort((a, b) => a.startMin - b.startMin);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].startMin < sorted[i - 1].endMin) { setError('時間帯が重なっています。'); return; }
    if (!effectiveLocation) { setError('校を選択してください（その他の場合は入力してください）。'); return; }
    if (!reason.trim()) { setError('理由を入力してください。'); return; }
    if (changedCount === 0) { setError('変更された項目がありません。'); return; }
    if (!changeReason.trim()) { setError('修正理由を入力してください（本人へ通知されます）。'); return; }
    setStep('confirm');
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    const segPayload = workSegments.map((s, i) => ({ seg_no: i + 1, start_min: s.startMin, end_min: s.endMin }));
    const { error: rpcErr } = await supabase.rpc('admin_edit_overtime_report', {
      p_id: record.id,
      p_work_date: workDate,
      p_break_minutes: breakMin,
      p_break_manual: breakManual,
      p_labor_minutes: laborMin,
      p_diff_minutes: diffMin,
      p_legal_warning: !legal.ok,
      p_reason: reason.trim(),
      p_location: effectiveLocation,
      p_phase: phase,
      p_segments: segPayload,
      p_changes: changes,
      p_change_summary: summary,
      p_change_reason: changeReason.trim(),
    });
    if (rpcErr) { setSaving(false); setError('保存に失敗しました: ' + rpcErr.message); return; }

    await supabase.from('notifications').insert({
      user_id: record.applicant_id,
      message: '管理者が残業・時間調整の内容を修正しました',
      sub_message: `${summary}　理由：${changeReason.trim()}`,
      source_type: 'overtime_request',
      reference_id: record.id,
      event_key: 'overtime:admin_edited',
      read: false,
    }).then(null, () => {});

    // 受理後修正でカレンダーが古い日付・時刻のまま残らないよう再同期（冪等な再計算）
    const { data: syncRes, error: syncErr } = await supabase.functions.invoke('gcal-sync', {
      body: { action: 'sync', source_type: 'overtime', source_id: record.id },
    });
    const sr = syncRes as { success?: boolean } | null;
    if (syncErr || sr?.success === false) {
      setError('修正は保存されましたが、Googleカレンダーへの反映に失敗しました。時間をおいて再度保存するか、管理者にご連絡ください。');
      setSaving(false);
      return;
    }

    setSaving(false);
    onSaved();
  };

  const btn = (bg: string, fg = '#fff'): React.CSSProperties => ({ padding: '10px', borderRadius: 8, border: 'none', background: bg, color: fg, fontWeight: 'bold', cursor: saving ? 'default' : 'pointer' });

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: cardBg, borderRadius: 12, padding: 20, width: '100%', maxWidth: 460, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 16, fontWeight: 'bold', color: text, marginBottom: 4 }}>残業・時間調整を修正</div>
        <div style={{ fontSize: 12, color: sub, marginBottom: 14 }}>{record.applicantName ?? ''}　{phase === 'actual' ? '実績' : '事前申請'}</div>

        {step === 'edit' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={labelStyle}>勤務日</label>
              <input type="date" style={{ ...inputStyle, width: '100%' }} value={workDate} onChange={e => setWorkDate(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>実務時間帯（最大3枠）</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {rows.map((r, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="time" style={{ ...inputStyle, flex: 1 }} value={r.start} onChange={e => setRow(i, 'start', e.target.value)} />
                    <span style={{ color: sub }}>〜</span>
                    <input type="time" style={{ ...inputStyle, flex: 1 }} value={r.end} onChange={e => setRow(i, 'end', e.target.value)} />
                    {rows.length > 1 && <button onClick={() => removeRow(i)} aria-label="この枠を削除" style={{ flex: 'none', padding: '6px 9px', borderRadius: 8, border: `1px solid ${border}`, background: 'transparent', color: '#dc3545', cursor: 'pointer' }}>✕</button>}
                  </div>
                ))}
                {rows.length < 3 && <button onClick={addRow} style={{ alignSelf: 'flex-start', padding: '5px 12px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: text, cursor: 'pointer', fontSize: 12 }}>＋ 枠を追加</button>}
              </div>
            </div>
            <div>
              <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={breakManual} onChange={e => setBreakManual(e.target.checked)} />休憩を手修正する
              </label>
              {breakManual
                ? <input type="number" min={0} style={{ ...inputStyle, width: 120 }} value={breakManualMin} onChange={e => setBreakManualMin(e.target.value)} />
                : <div style={{ fontSize: 12, color: sub }}>自動休憩：{autoBreak}分</div>}
            </div>
            <div style={{ fontSize: 12, color: sub }}>実労働 {formatMin(laborMin)}　差分 {formatSignedMin(diffMin)}{!legal.ok && <span style={{ color: '#dc3545', marginLeft: 8 }}>⚠ 休憩が法定基準に不足</span>}</div>
            <div>
              <label style={labelStyle}>校</label>
              <select style={{ ...inputStyle, width: '100%' }} value={locMode === 'other' ? 'その他' : location}
                onChange={e => { const v = e.target.value; if (v === 'その他') { setLocMode('other'); } else { setLocMode('select'); setLocation(v); } }}>
                <option value="">校を選択</option>
                {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
                <option value="その他">その他（自由記載）</option>
              </select>
              {locMode === 'other' && (
                <input style={{ ...inputStyle, width: '100%', marginTop: 8 }} value={locationOther} onChange={e => setLocationOther(e.target.value)} placeholder="校名を入力（例：上桂校）" />
              )}
            </div>
            <div>
              <label style={labelStyle}>理由</label>
              <textarea style={{ ...inputStyle, width: '100%', minHeight: 46, resize: 'vertical' }} value={reason} onChange={e => setReason(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>修正理由（必須・本人へ通知されます）</label>
              <textarea style={{ ...inputStyle, width: '100%', minHeight: 46, resize: 'vertical' }} value={changeReason} onChange={e => setChangeReason(e.target.value)} placeholder="例：本人申告の終業時刻に誤りがあったため" />
            </div>
            {error && <div style={{ padding: 10, background: isDarkMode ? '#3a1414' : '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 8, color: isDarkMode ? '#fca5a5' : '#842029', fontSize: 13 }}>{error}</div>}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <button onClick={onClose} style={{ ...btn('transparent', text), border: `1px solid ${border}` }}>キャンセル</button>
              <button onClick={goConfirm} style={btn('#fd7e14')}>確認へ</button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ padding: 12, background: isDarkMode ? '#2a1e00' : '#fff8f0', border: '1px solid #fd7e14', borderRadius: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 'bold', color: isDarkMode ? '#ffe082' : '#7c4d00', marginBottom: 8 }}>以下の内容で修正し、{record.applicantName ?? ''}さんに通知が届きます</div>
              {Object.entries(changes).map(([k, d]) => (
                <div key={k} style={{ fontSize: 12, color: text, marginBottom: 3 }}>
                  <span style={{ fontWeight: 'bold' }}>{FIELD_LABELS[k] ?? k}</span>：
                  <span style={{ color: isDarkMode ? '#f0999b' : '#a32d2d' }}>{String(d.old) || '(空)'}</span>
                  {' → '}
                  <span style={{ color: isDarkMode ? '#97c459' : '#3b6d11' }}>{String(d.new) || '(空)'}</span>
                </div>
              ))}
              <div style={{ fontSize: 12, color: sub, marginTop: 8 }}>理由：{changeReason.trim()}</div>
            </div>
            {error && <div style={{ padding: 10, background: isDarkMode ? '#3a1414' : '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 8, color: isDarkMode ? '#fca5a5' : '#842029', fontSize: 13 }}>{error}</div>}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <button onClick={() => setStep('edit')} disabled={saving} style={{ ...btn('transparent', text), border: `1px solid ${border}` }}>戻る</button>
              <button onClick={handleSave} disabled={saving} style={btn('#fd7e14')}>{saving ? '送信中...' : '修正して通知'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default OvertimeEditModal;
