import React, { useState } from 'react';
import { submitCorrectionRequest } from '../lib/correctionRequest';
import type { CorrectionTargetType, CorrectionChange, CorrectionRequestKind } from '../lib/correctionRequest';

// 本人が「どこを直したいか」入力するフィールド定義
export interface CorrectionField {
  key: string;
  label: string;               // 例：日付 / 校 / 時間
  current: string;             // 現在の値（表示・差分のfrom）
  inputType?: 'text' | 'date'; // 新値の入力形式（既定 text）
  placeholder?: string;
}

interface Props {
  targetType: CorrectionTargetType;
  targetId: string;
  targetLabel: string;         // 例：「休暇 7/3（木） 上桂校」
  fields: CorrectionField[];
  requesterName: string;
  isDarkMode: boolean;
  initialKind?: CorrectionRequestKind;  // カードのどちらの入口から開いたか（既定 edit）
  onClose: () => void;
  onSubmitted: () => void;
}

const PURPLE = '#534AB7';
const RED = '#A32D2D';

const CorrectionRequestModal: React.FC<Props> = ({
  targetType, targetId, targetLabel, fields, requesterName, isDarkMode, initialKind = 'edit', onClose, onSubmitted,
}) => {
  const [kind, setKind] = useState<CorrectionRequestKind>(initialKind);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [newVals, setNewVals] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const isCancel = kind === 'cancel';
  const accent = isCancel ? RED : PURPLE;

  const cardBg = isDarkMode ? '#2b3035' : '#fff';
  const text = isDarkMode ? '#f8f9fa' : '#212529';
  const sub = isDarkMode ? '#adb5bd' : '#6c757d';
  const border = isDarkMode ? '#495057' : '#dee2e6';
  const innerBg = isDarkMode ? '#343a40' : '#f8f9fa';
  const chipOn = { background: isDarkMode ? '#3C3489' : '#EEEDFE', color: isDarkMode ? '#CECBF6' : '#26215C', border: `1px solid ${PURPLE}` };
  const chipOff = { background: innerBg, color: sub, border: `1px solid ${border}` };

  const toggle = (key: string) => {
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  };

  const inputStyle: React.CSSProperties = {
    flex: 1, padding: '7px 10px', borderRadius: 8, border: `1px solid ${border}`,
    background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 14,
  };

  const buildChanges = (): CorrectionChange[] => {
    const out: CorrectionChange[] = [];
    for (const f of fields) {
      if (!selected.has(f.key)) continue;
      const to = (newVals[f.key] ?? '').trim();
      if (!to || to === f.current) continue;
      out.push({ label: f.label, from: f.current || '（未設定）', to });
    }
    return out;
  };

  const handleSubmit = async () => {
    setErr('');
    const changes = isCancel ? [] : buildChanges();
    let msg = message.trim();
    if (isCancel) {
      // 取消依頼は理由必須
      if (!msg) { setErr('取り消したい理由を入力してください'); return; }
    } else {
      // 修正依頼：構造化のみのときは差分から本文を自動生成
      if (!msg && changes.length > 0) msg = changes.map(c => `${c.label}：${c.from}→${c.to}`).join(' / ');
      if (!msg && changes.length === 0) {
        setErr('直したい内容を入力してください（項目を選ぶか、補足を書いてください）');
        return;
      }
    }
    setBusy(true);
    const { error } = await submitCorrectionRequest({
      targetType, targetId, message: msg, changes, requestKind: kind, requesterName, targetLabel,
    });
    setBusy(false);
    if (error) {
      setErr(error.includes('対応待ち') ? 'この申請には対応待ちの依頼が既にあります。' : `送信できませんでした：${error}`);
      return;
    }
    onSubmitted();
  };

  const segStyle = (on: boolean, activeColor: string): React.CSSProperties => ({
    flex: 1, textAlign: 'center', cursor: 'pointer', fontSize: 13, fontWeight: 'bold', padding: '8px 0', borderRadius: 8,
    background: on ? activeColor : 'transparent', color: on ? '#fff' : sub,
    border: `1px solid ${on ? activeColor : border}`,
  });

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: cardBg, borderRadius: 12, padding: 20, width: '100%', maxWidth: 440, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 16, fontWeight: 'bold', color: text, marginBottom: 2 }}>
          {isCancel ? '管理者に取消を依頼' : '管理者に修正を依頼'}
        </div>
        <div style={{ fontSize: 12, color: sub, marginBottom: 14 }}>{targetLabel}</div>

        {/* 修正／取消の切替 */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <div onClick={() => { setKind('edit'); setErr(''); }} style={segStyle(!isCancel, PURPLE)}>内容を直したい</div>
          <div onClick={() => { setKind('cancel'); setErr(''); }} style={segStyle(isCancel, RED)}>取り消したい</div>
        </div>

        {!isCancel && (
          <>
            <div style={{ fontSize: 12, color: sub, marginBottom: 6 }}>直したい項目をタップ</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
              {fields.map(f => (
                <span key={f.key} onClick={() => toggle(f.key)}
                  style={{ cursor: 'pointer', fontSize: 13, padding: '6px 12px', borderRadius: 999, ...(selected.has(f.key) ? chipOn : chipOff) }}>
                  {selected.has(f.key) ? '✓ ' : ''}{f.label}
                </span>
              ))}
            </div>

            {fields.filter(f => selected.has(f.key)).map(f => (
              <div key={f.key} style={{ background: innerBg, borderRadius: 8, padding: 12, marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: sub, marginBottom: 6 }}>{f.label}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 }}>
                  <span style={{ color: sub, textDecoration: 'line-through', whiteSpace: 'nowrap' }}>{f.current || '未設定'}</span>
                  <span style={{ color: sub }}>→</span>
                  <input
                    type={f.inputType === 'date' ? 'date' : 'text'}
                    value={newVals[f.key] ?? ''}
                    placeholder={f.placeholder ?? '希望する値'}
                    onChange={e => setNewVals(v => ({ ...v, [f.key]: e.target.value }))}
                    style={inputStyle}
                  />
                </div>
              </div>
            ))}
          </>
        )}

        {isCancel && (
          <div style={{ background: isDarkMode ? '#3a1f1f' : '#FCEBEB', color: isDarkMode ? '#F7C1C1' : RED, fontSize: 12.5, padding: '8px 10px', borderRadius: 8, marginBottom: 12 }}>
            この申請を「取り消してほしい」と管理者に依頼します。取り消しは管理者が行います。
          </div>
        )}

        <div style={{ fontSize: 12, color: sub, margin: '4px 0 6px' }}>{isCancel ? '取り消したい理由（必須）' : '補足（任意）'}</div>
        <textarea value={message} onChange={e => setMessage(e.target.value)}
          placeholder={isCancel ? '例：予定が変わり不要になりました' : '例：日付を1日勘違いしていました'}
          style={{ width: '100%', minHeight: 56, padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`, background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 14, boxSizing: 'border-box', resize: 'vertical' }} />

        {err && <div style={{ color: '#dc3545', fontSize: 13, marginTop: 10 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" onClick={onClose} disabled={busy}
            style={{ padding: '10px 14px', borderRadius: 8, border: `1px solid ${border}`, background: 'transparent', color: text, fontWeight: 'bold', cursor: busy ? 'default' : 'pointer' }}>
            キャンセル
          </button>
          <button type="button" onClick={handleSubmit} disabled={busy}
            style={{ padding: '10px 16px', borderRadius: 8, border: 'none', background: accent, color: '#fff', fontWeight: 'bold', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1 }}>
            {busy ? '送信中…' : isCancel ? '取消を依頼する' : 'この内容で依頼する'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CorrectionRequestModal;
