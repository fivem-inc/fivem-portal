import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { timeToMin, minToTime, formatMin, formatSignedMin, type WorkSegment } from '../../lib/breakCalc';
import { editPhaseOf, editFigures, editChanges, saveAdminOvertimeEdit, EDIT_FIELD_LABELS, typesForClockOnlyEdit } from '../../lib/overtimeAdminEdit';
import { OT_TYPE_INFO, isOvertimeType } from '../../lib/overtimeTypes';

// 管理者が残業レコードの内容を直接修正するモーダル。
// 休憩・実労働・差分・法定警告は申請フォームと同じ breakCalc で再計算（エンジン二重化を回避）。
// entry_type='manual' 限定（自動計上行は対象外）。理由必須 → 確認 → 原子的RPC → 本人通知。
// 計算・変更点・保存は lib/overtimeAdminEdit.ts（打刻の確認のカードの［この時刻で申請を直す］と共用）。

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
  furikae_origin_date?: string | null;
  furikae_origin_location?: string | null;
  /** 「開始が遅い／早く終わる理由」で押した事情（adj／event／telework）。札の表記だけを変える（typeLabelFor・2026-09-26） */
  late_situation?: string | null;
  early_situation?: string | null;
  created_at?: string | null;
  confirmed_at?: string | null;
  /** 実績報告のとき、事前申請の内容から変わった理由（変更が無ければ null） */
  change_reason?: string | null;
  segments: Seg[];
}

interface Props {
  record: OvertimeRecord;
  isDarkMode: boolean;
  onClose: () => void;
  /** warning：保存はできたが、カレンダーや打刻の確認の札だけ失敗したとき（打刻の確認から開いたときだけ渡す） */
  onSaved: (warning?: string) => void;
  /** 打刻の確認のカードの「休憩なども直す」から開いたとき（2026-10-13）。本人が入れた時間で始め、保存したら確認を「直しました」にする */
  clockInquiry?: { dayId: string; segments: { start_min: number; end_min: number }[] | null; note: string | null };
}

// 分→"HH:MM"（翌日跨ぎは24時間で丸めて入力欄用に戻す）
const minToInput = (m: number): string => minToTime(m).replace('翌', '').padStart(5, '0');

const OvertimeEditModal: React.FC<Props> = ({ record, isDarkMode, onClose, onSaved, clockInquiry }) => {
  // 編集対象phase：実績があれば実績、無ければ予定
  const phase = editPhaseOf(record);
  const initialSegs = record.segments.filter(s => s.phase === phase).sort((a, b) => a.seg_no - b.seg_no);
  // 打刻の確認から開いたときは、本人が入れた正しい時間から始める
  const startSegs = clockInquiry?.segments && clockInquiry.segments.length > 0 ? clockInquiry.segments : initialSegs;

  const [rows, setRows] = useState<{ start: string; end: string }[]>(
    startSegs.length ? startSegs.map(s => ({ start: minToInput(s.start_min), end: minToInput(s.end_min % 1440) })) : [{ start: '', end: '' }],
  );
  const [breakManual, setBreakManual] = useState(record.break_manual);
  const [breakManualMin, setBreakManualMin] = useState(String(record.break_minutes ?? 0));
  const [reason, setReason] = useState(record.reason ?? '');
  const [locMode, setLocMode] = useState<'select' | 'other'>('select');
  const [location, setLocation] = useState(record.location ?? '');   // select時に選んだ校
  const [locationOther, setLocationOther] = useState('');            // その他（自由記載）
  const [workDate, setWorkDate] = useState(record.work_date);
  const [changeReason, setChangeReason] = useState(clockInquiry?.segments && clockInquiry.segments.length > 0 ? '打刻の確認のお答えのとおり' : '');
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

  const baseLabor = record.normal_shift?.labor_minutes ?? 0;
  const { autoBreak, breakMin, laborMin, diffMin, legalOk } = editFigures(workSegments, breakManual, parseInt(breakManualMin, 10) || 0, baseLabor);
  const legal = { ok: legalOk };

  const { changes, summary } = useMemo(
    () => editChanges(record, { workDate, segs: workSegments, breakMin, diffMin, location: effectiveLocation, reason }),
    [record, workDate, workSegments, breakMin, diffMin, effectiveLocation, reason],
  );

  // 打刻ズレの時間を変えて差が出たら、種類も直す（2026-10-13）
  const fixTypes = typesForClockOnlyEdit(record.application_types, workSegments, diffMin, record.normal_shift as { start_time?: string | null; end_time?: string | null; end_time2?: string | null } | null);
  const typeName = (ts: string[]) => ts.map(t => (isOvertimeType(t) ? OT_TYPE_INFO[t].label : t)).join('・');
  const allChanges = fixTypes ? { ...changes, application_types: { old: '打刻ズレ', new: typeName(fixTypes) } } : changes;
  const allSummary = fixTypes ? summary.replace(/を修正$/, '・種別を修正') : summary;
  const changedCount = Object.keys(allChanges).length;
  const FIELD_LABELS: Record<string, string> = { ...EDIT_FIELD_LABELS, application_types: '種別' };

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
    const res = await saveAdminOvertimeEdit({
      record, workDate, segs: workSegments,
      breakManual, breakMin, laborMin, diffMin, legalOk,
      reason: reason.trim(), location: effectiveLocation, changes: allChanges, summary: allSummary,
      applicationTypes: fixTypes ?? undefined,
      changeReason: changeReason.trim(),
      clockInquiryDayId: clockInquiry?.dayId,
    });
    if (res.error) { setSaving(false); setError(res.error); return; }
    const gcalMsg = 'Googleカレンダーへの反映に失敗しました。時間をおいて再度保存するか、管理者にご連絡ください。';

    if (clockInquiry) {
      // 打刻の確認から開いたとき：保存はできているので閉じる（失敗した部分は打刻の確認の画面に出す）
      setSaving(false);
      onSaved([res.resolveError, res.gcalFailed ? '修正は保存されましたが、' + gcalMsg : ''].filter(Boolean).join(' ') || undefined);
      return;
    }
    if (res.gcalFailed) {
      setError('修正は保存されましたが、' + gcalMsg);
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
            {clockInquiry && (
              <div style={{ padding: '8px 10px', borderRadius: 8, background: isDarkMode ? '#3a2e10' : '#fff8e1', border: `1px solid ${isDarkMode ? '#8a6d1f' : '#ffe08a'}`, fontSize: 12.5, color: text, lineHeight: 1.7 }}>
                打刻の確認のお答え：{clockInquiry.segments && clockInquiry.segments.length > 0
                  ? clockInquiry.segments.map(s => `${minToTime(s.start_min)}〜${minToTime(s.end_min)}`).join('、') : '（時間の答えはありません）'}
                {clockInquiry.note && <><br />ひとこと：{clockInquiry.note}</>}
              </div>
            )}
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
            <div style={{ fontSize: 12, color: sub }}>実労働 {formatMin(laborMin)}　差分 {formatSignedMin(diffMin)}{!legal.ok && <span style={{ color: '#dc3545', marginLeft: 8 }}>⚠️ 休憩が法定基準に不足</span>}</div>
            {fixTypes && (
              <div style={{ padding: '8px 10px', borderRadius: 8, background: '#fff3cd', border: '1px solid #ffe0a3', fontSize: 12.5, color: '#664d03', lineHeight: 1.7 }}>
                ⚠️ この記録は「打刻ズレ（残業なし）」です。時間を変えて差が出たので、保存すると種類を「{typeName(fixTypes)}」に直します。
              </div>
            )}
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
              {Object.entries(allChanges).map(([k, d]) => (
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
