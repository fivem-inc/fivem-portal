import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import type { AdminLeaveRequest } from '../../types';

// 管理者が休暇申請の内容を直接修正するモーダル。
// 理由必須 → 確認ステップ（本人へ通知が届く旨を提示）→ 原子的RPC(admin_edit_leave_request) → 本人へ通知。
// alert/confirm は使わずインラインUIで完結する。

const LEAVE_TYPES = ['有給休暇', 'バースデー休暇（有給）', '慶弔休暇', '調整休', 'その他'];

interface Props {
  record: AdminLeaveRequest;
  isDarkMode: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const parseDates = (s?: string): string[] => { try { return s ? JSON.parse(s) : []; } catch { return []; } };
const parseLocs = (s?: string | null): Record<string, string> => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

const LeaveEditModal: React.FC<Props> = ({ record, isDarkMode, onClose, onSaved }) => {
  const [leaveType, setLeaveType] = useState(record.leave_type);
  const [leaveTypeOther, setLeaveTypeOther] = useState(record.leave_type_other ?? '');
  const [dates, setDates] = useState<string[]>(parseDates(record.leave_dates));
  const [locs, setLocs] = useState<Record<string, string>>(parseLocs(record.leave_locations));
  const [purpose, setPurpose] = useState(record.purpose ?? '');
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
  const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 14 };
  const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 'bold', color: text, marginBottom: 4, display: 'block' };

  const typeLabel = (t: string, other: string) => (t === 'その他' ? (other.trim() || 'その他') : t);
  const locLine = (ds: string[], m: Record<string, string>) => ds.map(d => `${d.slice(5)}:${m[d] || '未設定'}`).join('、');

  // 変更差分（表示・保存用）
  const changes = useMemo(() => {
    const c: Record<string, { old: unknown; new: unknown }> = {};
    if (typeLabel(record.leave_type, record.leave_type_other ?? '') !== typeLabel(leaveType, leaveTypeOther))
      c.leave_type = { old: typeLabel(record.leave_type, record.leave_type_other ?? ''), new: typeLabel(leaveType, leaveTypeOther) };
    const oldDates = parseDates(record.leave_dates);
    if (JSON.stringify(oldDates) !== JSON.stringify(dates)) c.leave_dates = { old: oldDates, new: dates };
    const oldLocLine = locLine(oldDates, parseLocs(record.leave_locations));
    if (oldLocLine !== locLine(dates, locs)) c.leave_locations = { old: oldLocLine, new: locLine(dates, locs) };
    if ((record.purpose ?? '') !== purpose) c.purpose = { old: record.purpose ?? '', new: purpose };
    if ((record.reason ?? '') !== reason) c.reason = { old: record.reason ?? '', new: reason };
    return c;
  }, [record, leaveType, leaveTypeOther, dates, locs, purpose, reason]);

  const changedCount = Object.keys(changes).length;
  const FIELD_LABELS: Record<string, string> = { leave_type: '種別', leave_dates: '休暇日', leave_locations: '校', purpose: '用途', reason: '理由' };
  const summary = Object.keys(changes).map(k => FIELD_LABELS[k] ?? k).join('・') + 'を修正';

  const setLoc = (d: string, v: string) => setLocs(prev => ({ ...prev, [d]: v }));
  const addDate = () => setDates(prev => [...prev, '']);
  const removeDate = (i: number) => setDates(prev => prev.filter((_, idx) => idx !== i));

  const goConfirm = () => {
    setError('');
    if (leaveType === 'その他' && !leaveTypeOther.trim()) { setError('種別「その他」の内容を入力してください。'); return; }
    if (dates.some(d => !d)) { setError('空の休暇日があります。日付を入力するか削除してください。'); return; }
    if (dates.length === 0) { setError('休暇日を1日以上入力してください。'); return; }
    if (changedCount === 0) { setError('変更された項目がありません。'); return; }
    if (!changeReason.trim()) { setError('修正理由を入力してください（本人へ通知されます）。'); return; }
    setPhase('confirm');
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    const sorted = [...dates].sort();
    const cleanLocs: Record<string, string> = {};
    dates.forEach(d => { if (locs[d]) cleanLocs[d] = locs[d]; });
    const { error: rpcErr } = await supabase.rpc('admin_edit_leave_request', {
      p_id: record.id,
      p_leave_type: leaveType,
      p_leave_type_other: leaveType === 'その他' ? (leaveTypeOther.trim() || null) : null,
      p_leave_dates: JSON.stringify(dates),
      p_leave_locations: Object.keys(cleanLocs).length ? JSON.stringify(cleanLocs) : null,
      p_purpose: purpose.trim() || null,
      p_reason: reason.trim() || null,
      p_start_date: sorted[0] || null,
      p_end_date: sorted[sorted.length - 1] || null,
      p_changes: changes,
      p_change_summary: summary,
      p_change_reason: changeReason.trim(),
    });
    if (rpcErr) { setSaving(false); setError('保存に失敗しました: ' + rpcErr.message); return; }

    // Googleカレンダー再同期（受理済みのみ反映される想定。失敗しても保存は成立）
    if (record.status === 'approved' || record.status === 'manager_approved') {
      try {
        await supabase.functions.invoke('gcal-sync', {
          body: { action: 'upsert', source_type: 'leave', source_id: record.id, dates, name: record.profile?.name ?? '', leave_type: leaveType, locations: locs },
        });
      } catch (e) { console.error('[gcal-sync] 休暇修正の再同期失敗:', e); }
    }

    // 本人へ通知（履歴の欠落は起きないが、通知は補助なので失敗しても保存は成立）
    await supabase.from('notifications').insert({
      user_id: record.user_id,
      message: '管理者が申請内容を修正しました',
      sub_message: `${summary}　理由：${changeReason.trim()}`,
      source_type: 'leave_request',
      reference_id: record.id,
      event_key: 'leave:admin_edited',
      read: false,
    }).then(null, () => {});

    setSaving(false);
    onSaved();
  };

  const btn = (bg: string, fg = '#fff'): React.CSSProperties => ({ padding: '10px', borderRadius: 8, border: 'none', background: bg, color: fg, fontWeight: 'bold', cursor: saving ? 'default' : 'pointer' });

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: cardBg, borderRadius: 12, padding: 20, width: '100%', maxWidth: 440, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 16, fontWeight: 'bold', color: text, marginBottom: 4 }}>申請内容を修正</div>
        <div style={{ fontSize: 12, color: sub, marginBottom: 14 }}>{record.profile?.name}　（{record.status === 'approved' ? '受理済み' : record.status}）</div>

        {phase === 'edit' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={labelStyle}>種別</label>
              <select style={inputStyle} value={leaveType} onChange={e => setLeaveType(e.target.value)}>
                {LEAVE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              {leaveType === 'その他' && (
                <input style={{ ...inputStyle, marginTop: 8 }} value={leaveTypeOther} onChange={e => setLeaveTypeOther(e.target.value)} placeholder="種別の内容" />
              )}
            </div>
            <div>
              <label style={labelStyle}>休暇日・校</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {dates.map((d, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="date" style={{ ...inputStyle, flex: '0 0 150px' }} value={d} onChange={e => { const nv = e.target.value; setDates(prev => prev.map((x, idx) => idx === i ? nv : x)); }} />
                    <select style={{ ...inputStyle, flex: 1 }} value={locs[d] || ''} onChange={e => setLoc(d, e.target.value)}>
                      <option value="">校を選択</option>
                      {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
                    </select>
                    <button onClick={() => removeDate(i)} aria-label="この日を削除" style={{ flex: 'none', padding: '6px 9px', borderRadius: 8, border: `1px solid ${border}`, background: 'transparent', color: '#dc3545', cursor: 'pointer' }}>✕</button>
                  </div>
                ))}
                <button onClick={addDate} style={{ alignSelf: 'flex-start', padding: '5px 12px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: text, cursor: 'pointer', fontSize: 12 }}>＋ 日を追加</button>
              </div>
            </div>
            <div>
              <label style={labelStyle}>用途</label>
              <input style={inputStyle} value={purpose} onChange={e => setPurpose(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>理由</label>
              <textarea style={{ ...inputStyle, minHeight: 50, resize: 'vertical' }} value={reason} onChange={e => setReason(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>修正理由（必須・本人へ通知されます）</label>
              <textarea style={{ ...inputStyle, minHeight: 50, resize: 'vertical' }} value={changeReason} onChange={e => setChangeReason(e.target.value)} placeholder="例：本人申告の校に誤りがあったため" />
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
              <div style={{ fontSize: 13, fontWeight: 'bold', color: isDarkMode ? '#ffe082' : '#7c4d00', marginBottom: 8 }}>以下の内容で修正し、{record.profile?.name}さんに通知が届きます</div>
              {Object.entries(changes).map(([k, d]) => (
                <div key={k} style={{ fontSize: 12, color: text, marginBottom: 3 }}>
                  <span style={{ fontWeight: 'bold' }}>{FIELD_LABELS[k] ?? k}</span>：
                  <span style={{ color: isDarkMode ? '#f0999b' : '#a32d2d' }}>{Array.isArray(d.old) ? (d.old.join('・') || '(なし)') : (String(d.old) || '(空)')}</span>
                  {' → '}
                  <span style={{ color: isDarkMode ? '#97c459' : '#3b6d11' }}>{Array.isArray(d.new) ? (d.new.join('・') || '(なし)') : (String(d.new) || '(空)')}</span>
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

export default LeaveEditModal;
