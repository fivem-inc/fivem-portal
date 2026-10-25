// 申請の［削除］を押したときの確認（理由は必須・2026-10-23 ユーザー確定 案A）。
// 休暇・残業・勤務変更・交通費（管理画面）と、勤務変更のページの本人の削除が同じこれを使う。消す処理は lib/deleteApplication
import React, { useState } from 'react';
import { backBtn, primaryBtn } from '../lib/buttonStyles';
import { DELETE_REASON_MAX, DELETE_REASON_PRESETS } from '../lib/deleteApplication';

interface Props {
  /** 何を消すか（例：「見本 花子さん　振替休日　10/7（火）」）。複数行可 */
  detail: React.ReactNode;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

const DeleteReasonDialog: React.FC<Props> = ({ detail, busy, error, onCancel, onConfirm }) => {
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const empty = !reason.trim();
  const submit = () => {
    setTried(true);
    if (empty || busy) return;
    onConfirm(reason.trim());
  };
  return (
    <div role="dialog" aria-modal="true" aria-label="申請の削除"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      {/* 地は白で固定（確認の窓・ライト／ダーク共通） */}
      <div style={{ background: '#fff', color: '#212529', borderRadius: 12, padding: '18px 20px', width: 420, maxWidth: '100%', textAlign: 'left' }}>
        <div style={{ fontSize: 15, fontWeight: 'bold' }}>この申請を削除します</div>
        <div style={{ fontSize: 13, color: '#495057', marginTop: 6, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{detail}</div>
        <div style={{ fontSize: 13, color: '#495057', marginTop: 4, lineHeight: 1.7 }}>削除すると元に戻せません。内容は管理画面の「削除の記録」に残ります。</div>
        <label style={{ display: 'block', fontSize: 13, fontWeight: 'bold', margin: '12px 0 6px' }}>
          削除の理由<span style={{ color: '#dc3545' }}> *</span>
        </label>
        <input type="text" value={reason} maxLength={DELETE_REASON_MAX} disabled={busy}
          onChange={e => setReason(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit(); }}
          placeholder="例：同じ日に二重に入っていたため"
          aria-label="削除の理由"
          style={{ width: '100%', boxSizing: 'border-box', border: `1px solid ${tried && empty ? '#dc3545' : '#ced4da'}`, borderRadius: 8, padding: '8px 10px', fontSize: 14, background: '#fff', color: '#212529' }} />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          {DELETE_REASON_PRESETS.map(p => (
            <button key={p} type="button" disabled={busy} onClick={() => setReason(p)}
              style={{ fontSize: 12, border: '1px solid #90caf9', background: '#e3f2fd', color: '#1565c0', borderRadius: 14, padding: '3px 10px', cursor: 'pointer' }}>{p}</button>
          ))}
        </div>
        {tried && empty && <div style={{ color: '#dc3545', fontSize: 12.5, marginTop: 6 }}>削除の理由を入力してください</div>}
        {error && <div style={{ color: '#dc3545', fontSize: 12.5, marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button type="button" onClick={onCancel} disabled={busy} style={{ ...backBtn(false), flex: 1 }}>やめる</button>
          <button type="button" onClick={submit} disabled={busy} style={{ ...primaryBtn({ danger: true, disabled: busy }), flex: 2 }}>
            {busy ? '削除しています…' : '削除する'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeleteReasonDialog;
