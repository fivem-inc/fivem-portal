import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { calcSegsBreak, parseSegments, segMinutes, formatSegs, segFirstStart, segLastEnd, joinSegLocations, MAX_SEGS, type Seg } from '../../lib/shiftCalc';

// 管理者が勤務変更報告の内容を直接修正するモーダル。
// 本人の報告画面と同じ「時間帯」方式（勤務1〜3・行ごとの勤務地）で入力する。
// 休憩・実労働は申請時と同じ shiftCalc で自動再計算（エンジン二重化を回避）。
// 🚨 休憩・実労働が保存値と違うときも「変更あり」として保存できる
//    （旧ルールで休憩を引きすぎた過去の報告を、時刻を触らずに直せるように）。
// 理由必須 → 確認ステップ（本人へ通知が届く旨）→ 原子的RPC(admin_edit_shift_report) → 本人へ通知。

export type AppType = 'overtime' | 'holiday_work' | 'early_leave' | 'tardiness' | 'absence' | 'early_start' | 'location_change';
const TYPE_LABELS: Record<AppType, string> = {
  overtime: '残業', holiday_work: '休日出勤', early_leave: '早退', tardiness: '遅刻',
  absence: '欠勤', early_start: '早出', location_change: '勤務地変更',
};
const ALL_TYPES = Object.keys(TYPE_LABELS) as AppType[];

export interface ShiftRecord {
  id: string;
  applicant_id: string;
  applicantName?: string;
  work_date: string;
  application_type: AppType;
  application_types: AppType[];
  reason: string;
  actual_location: string | null;
  actual_start: string | null;
  actual_end: string | null;
  actual_outing_start: string | null;
  actual_outing_end: string | null;
  actual_segments?: unknown;
  break_minutes: number | null;
  labor_minutes: number | null;
  status: string;
}

interface Props {
  record: ShiftRecord;
  isDarkMode: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const getTypes = (r: ShiftRecord): AppType[] => (r.application_types?.length ? r.application_types : [r.application_type]);
const toMin = (t: string): number => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

const ShiftEditModal: React.FC<Props> = ({ record, isDarkMode, onClose, onSaved }) => {
  const [types, setTypes] = useState<AppType[]>(getTypes(record));
  const [workDate, setWorkDate] = useState(record.work_date);
  // 過去の報告（開始・終了＋外出）も時間帯に復元して同じ形で編集する
  const [segs, setSegs] = useState<Seg[]>(() => {
    const parsed = parseSegments(record.actual_segments ?? null, record.actual_start, record.actual_end, record.actual_outing_start, record.actual_outing_end, record.actual_location);
    return parsed.length > 0 ? parsed : [{ start: '', end: '', location: record.actual_location ?? undefined }];
  });
  const [locOther, setLocOther] = useState<boolean[]>([]);
  const [reason, setReason] = useState(record.reason ?? '');
  const [changeReason, setChangeReason] = useState('');
  const [workplaces, setWorkplaces] = useState<string[]>([]);
  const [phase, setPhase] = useState<'edit' | 'confirm'>('edit');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    supabase.from('master_options').select('value').eq('category', 'workplace').order('sort_order')
      .then(({ data }) => { if (data) setWorkplaces(data.map((r: { value: string }) => r.value)); });
  }, []);

  const cardBg = isDarkMode ? '#2d2d3e' : '#fff';
  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const text = isDarkMode ? '#eee' : '#222';
  const sub = isDarkMode ? '#adb5bd' : '#666';
  const inputBg = isDarkMode ? '#3a3a5c' : '#f8f9fa';
  const inputStyle: React.CSSProperties = { boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 14, colorScheme: isDarkMode ? 'dark' : 'light' };
  const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 'bold', color: text, marginBottom: 4, display: 'block' };

  const isAbsence = types.includes('absence');
  // 勤務地セレクトの「その他（自由入力）」判定（本人の報告画面と同じ）
  const isOtherLoc = (s: Seg, i: number): boolean =>
    locOther[i] ?? (!!s.location && workplaces.length > 0 && !workplaces.includes(s.location));

  const validSegs = useMemo(() => segs.filter(s => s.start && s.end), [segs]);
  // 休憩・実労働の自動再計算（時間帯ごとに計算して合算。本人の報告画面と同じ）
  const { breakMin, laborMin } = useMemo(() => {
    if (isAbsence || validSegs.length === 0) return { breakMin: null as number | null, laborMin: null as number | null };
    const b = calcSegsBreak(validSegs);
    return { breakMin: b, laborMin: Math.max(0, segMinutes(validSegs) - b) };
  }, [isAbsence, validSegs]);

  const fmtMin = (m: number | null) => (m == null ? '-' : `${Math.floor(m / 60)}時間${m % 60 > 0 ? (m % 60) + '分' : ''}`);

  const changes = useMemo(() => {
    const c: Record<string, { old: unknown; new: unknown }> = {};
    const oldTypes = getTypes(record).map(t => TYPE_LABELS[t]).join('＋');
    const newTypes = types.map(t => TYPE_LABELS[t]).join('＋');
    if (oldTypes !== newTypes) c.types = { old: oldTypes, new: newTypes };
    if (record.work_date !== workDate) c.work_date = { old: record.work_date, new: workDate };
    const oldSegs = parseSegments(record.actual_segments ?? null, record.actual_start, record.actual_end, record.actual_outing_start, record.actual_outing_end, record.actual_location);
    const oldRange = formatSegs(oldSegs) || '(なし)';
    const newRange = isAbsence ? '(なし)' : (formatSegs(validSegs) || '(なし)');
    if (oldRange !== newRange) c.actual_time = { old: oldRange, new: newRange };
    const oldLoc = record.actual_location ?? '';
    const newLoc = isAbsence ? '' : joinSegLocations(validSegs);
    if (oldLoc !== newLoc) c.actual_location = { old: oldLoc, new: newLoc };
    // 🚨 休憩・実労働の再計算結果が保存値と違うときも「変更あり」に数える。
    //    旧ルール（拘束時間で判定）で休憩を引きすぎた報告は、時刻が正しくても数字だけズレているため
    if ((record.break_minutes ?? null) !== breakMin) c.break_minutes = { old: `${record.break_minutes ?? 0}分`, new: breakMin == null ? '-' : `${breakMin}分` };
    if ((record.labor_minutes ?? null) !== laborMin) c.labor_minutes = { old: fmtMin(record.labor_minutes), new: fmtMin(laborMin) };
    if ((record.reason ?? '') !== reason) c.reason = { old: record.reason ?? '', new: reason };
    return c;
  }, [record, types, workDate, validSegs, isAbsence, breakMin, laborMin, reason]);

  const changedCount = Object.keys(changes).length;
  const FIELD_LABELS: Record<string, string> = { types: '種別', work_date: '勤務日', actual_location: '勤務地', actual_time: '勤務時間', break_minutes: '休憩', labor_minutes: '実労働', reason: '理由' };
  const summary = Object.keys(changes).map(k => FIELD_LABELS[k] ?? k).join('・') + 'を修正';

  const toggleType = (t: AppType) => setTypes(prev => (prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]));

  const goConfirm = () => {
    setError('');
    if (types.length === 0) { setError('種別を1つ以上選択してください。'); return; }
    if (!isAbsence) {
      if (segs.some(s => !s.start || !s.end)) { setError('勤務時間の開始・終了を入力してください。'); return; }
      if (segs.some(s => s.start === s.end)) { setError('開始と終了が同じ時間の行があります。'); return; }
      if (segs.some(s => toMin(s.end) < toMin(s.start))) { setError('終了が開始より前の行があります。'); return; }
      if (segs.some((s, i) => i > 0 && toMin(s.start) < toMin(segs[i - 1].end))) { setError('勤務の時間が重なっています。順番に入力してください。'); return; }
      if (segs.some(s => !(s.location ?? '').trim())) { setError('勤務地を選択してください。'); return; }
    }
    if (changedCount === 0) { setError('変更された項目がありません。'); return; }
    if (!changeReason.trim()) { setError('修正理由を入力してください（本人へ通知されます）。'); return; }
    setPhase('confirm');
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    // 保存の形は本人の報告画面と同じ：時間帯を jsonb に全部入れ、
    // 最初の開始／最後の終了と最初の空き（＝外出）を従来の列にも書いて互換を保つ
    const cleanSegs: Seg[] = isAbsence ? [] : validSegs.map(s => ({ start: s.start, end: s.end, location: (s.location ?? '').trim() }));
    const { error: rpcErr } = await supabase.rpc('admin_edit_shift_report', {
      p_id: record.id,
      p_application_types: types,
      p_work_date: workDate,
      p_actual_location: isAbsence ? null : (joinSegLocations(cleanSegs) || null),
      p_actual_start: !isAbsence && cleanSegs.length > 0 ? segFirstStart(cleanSegs) : null,
      p_actual_end: !isAbsence && cleanSegs.length > 0 ? segLastEnd(cleanSegs) : null,
      p_actual_outing_start: !isAbsence && cleanSegs.length >= 2 ? cleanSegs[0].end : null,
      p_actual_outing_end: !isAbsence && cleanSegs.length >= 2 ? cleanSegs[1].start : null,
      p_actual_segments: isAbsence ? null : cleanSegs,
      p_break_minutes: breakMin,
      p_labor_minutes: laborMin,
      p_reason: reason.trim(),
      p_changes: changes,
      p_change_summary: summary,
      p_change_reason: changeReason.trim(),
    });
    if (rpcErr) { setSaving(false); setError('保存に失敗しました: ' + rpcErr.message); return; }

    await supabase.from('notifications').insert({
      user_id: record.applicant_id,
      message: '管理者が勤務変更報告を修正しました',
      sub_message: `${summary}　理由：${changeReason.trim()}`,
      source_type: 'shift_report',
      reference_id: record.id,
      event_key: 'shift:admin_edited',
      read: false,
    }).then(null, () => {});

    setSaving(false);
    onSaved();
  };

  const btn = (bg: string, fg = '#fff'): React.CSSProperties => ({ padding: '10px', borderRadius: 8, border: 'none', background: bg, color: fg, fontWeight: 'bold', cursor: saving ? 'default' : 'pointer' });

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: cardBg, borderRadius: 12, padding: 20, width: '100%', maxWidth: 460, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 16, fontWeight: 'bold', color: text, marginBottom: 4 }}>勤務変更報告を修正</div>
        <div style={{ fontSize: 12, color: sub, marginBottom: 14 }}>{record.applicantName ?? ''}</div>

        {phase === 'edit' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={labelStyle}>種別（複数可）</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {ALL_TYPES.map(t => (
                  <button key={t} onClick={() => toggleType(t)}
                    style={{ padding: '5px 10px', borderRadius: 8, border: `1px solid ${types.includes(t) ? '#007bff' : border}`, background: types.includes(t) ? '#007bff' : inputBg, color: types.includes(t) ? '#fff' : text, cursor: 'pointer', fontSize: 12 }}>
                    {TYPE_LABELS[t]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label style={labelStyle}>勤務日</label>
              <input type="date" style={{ ...inputStyle, width: '100%' }} value={workDate} onChange={e => setWorkDate(e.target.value)} />
            </div>
            {!isAbsence && (
              <div>
                <label style={labelStyle}>勤務時間・勤務地</label>
                {segs.map((s, i) => {
                  const other = isOtherLoc(s, i);
                  return (
                    <div key={i} style={{ marginBottom: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                        <span style={{ fontSize: 12, color: sub, minWidth: 40, flexShrink: 0 }}>勤務{i + 1}</span>
                        <input type="time" style={{ ...inputStyle, flex: 1, minWidth: 0 }} value={s.start} onChange={e => setSegs(prev => prev.map((p, j) => j === i ? { ...p, start: e.target.value } : p))} />
                        <span style={{ color: sub, flexShrink: 0 }}>〜</span>
                        <input type="time" style={{ ...inputStyle, flex: 1, minWidth: 0 }} value={s.end} onChange={e => setSegs(prev => prev.map((p, j) => j === i ? { ...p, end: e.target.value } : p))} />
                        {segs.length > 1 && (
                          <button type="button" onClick={() => { setSegs(prev => prev.filter((_, j) => j !== i)); setLocOther(prev => prev.filter((_, j) => j !== i)); }}
                            aria-label={`勤務${i + 1}を削除`}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: sub, flexShrink: 0 }}>🚫</button>
                        )}
                      </div>
                      <div style={{ paddingLeft: 46 }}>
                        <select style={{ ...inputStyle, width: '100%' }}
                          value={other ? 'その他' : (s.location ?? '')}
                          onChange={e => {
                            const v = e.target.value;
                            setLocOther(prev => { const n = [...prev]; n[i] = v === 'その他'; return n; });
                            setSegs(prev => prev.map((p, j) => j === i ? { ...p, location: v === 'その他' ? '' : v } : p));
                          }}>
                          <option value="">勤務地を選択してください</option>
                          {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
                          <option value="その他">その他（自由入力）</option>
                        </select>
                        {other && (
                          <input type="text" style={{ ...inputStyle, width: '100%', marginTop: 6 }} value={s.location ?? ''}
                            onChange={e => setSegs(prev => prev.map((p, j) => j === i ? { ...p, location: e.target.value } : p))}
                            placeholder="勤務地を入力してください" />
                        )}
                      </div>
                    </div>
                  );
                })}
                {segs.length < MAX_SEGS && (
                  <button type="button" onClick={() => setSegs(prev => [...prev, { start: '', end: '' }])}
                    style={{ background: isDarkMode ? '#2c3e50' : '#e8f4fd', border: `1px solid ${isDarkMode ? '#4a90d9' : '#90caf9'}`, borderRadius: 8, cursor: 'pointer', padding: '6px 12px', fontSize: 12.5, color: isDarkMode ? '#fff' : '#1565c0', width: '100%', marginBottom: 8 }}>
                    ＋ 勤務時間帯を追加（外出・戻りがある場合）
                  </button>
                )}
                <div style={{ fontSize: 12, color: sub }}>自動計算：休憩 {breakMin ?? 0}分　実労働 {fmtMin(laborMin)}</div>
                {(record.break_minutes ?? null) !== breakMin && (
                  <div style={{ fontSize: 12, color: '#fd7e14', marginTop: 2 }}>⚠️ 保存されている休憩（{record.break_minutes ?? 0}分）と違います。保存すると新しい計算で上書きされます。</div>
                )}
              </div>
            )}
            <div>
              <label style={labelStyle}>理由</label>
              <textarea style={{ ...inputStyle, width: '100%', minHeight: 46, resize: 'vertical' }} value={reason} onChange={e => setReason(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>修正理由（必須・本人へ通知されます）</label>
              <textarea style={{ ...inputStyle, width: '100%', minHeight: 46, resize: 'vertical' }} value={changeReason} onChange={e => setChangeReason(e.target.value)} placeholder="例：本人申告の退勤時刻に誤りがあったため" />
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
              <button onClick={() => setPhase('edit')} disabled={saving} style={{ ...btn('transparent', text), border: `1px solid ${border}` }}>戻る</button>
              <button onClick={handleSave} disabled={saving} style={btn('#fd7e14')}>{saving ? '送信中...' : '修正して通知'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ShiftEditModal;
