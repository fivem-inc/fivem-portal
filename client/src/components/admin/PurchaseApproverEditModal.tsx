import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../lib/supabaseClient';
import type { PurchaseRequestCSVRow } from '../../utils';

interface PurchaseApproverEditModalProps {
  record: PurchaseRequestCSVRow;
  isDarkMode: boolean;
  names: Record<string, string>;
  onClose: () => void;
  onChanged: () => void;
}

interface RemovedEntry { id: string; reason: string; editedAt: string }

// 全員承認・マネージャー承認ルートで、休職・退職などにより長期間回答できない承認者を
// 対象リストから外す機能。外さないと「全員回答待ち」が永久に止まってしまうための対策。
// 外した人は「戻す」ボタンで再度加えることもできる。
const PurchaseApproverEditModal: React.FC<PurchaseApproverEditModalProps> = ({ record, isDarkMode, names, onClose, onChanged }) => {
  const approverField: 'board_approver_ids' | 'requested_manager_ids' | null =
    (record.board_approver_ids?.length ?? 0) > 0 ? 'board_approver_ids'
    : (record.requested_manager_ids?.length ?? 0) > 0 ? 'requested_manager_ids'
    : null;
  const [approverIds, setApproverIds] = useState<string[]>(
    approverField === 'board_approver_ids' ? (record.board_approver_ids ?? [])
    : approverField === 'requested_manager_ids' ? (record.requested_manager_ids ?? [])
    : []
  );
  const [removedEntries, setRemovedEntries] = useState<RemovedEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [removingApproverId, setRemovingApproverId] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState('');
  const [removingSaving, setRemovingSaving] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const cardBg = isDarkMode ? '#2d2d3e' : '#ffffff';
  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const subText = isDarkMode ? '#aaaaaa' : '#666666';
  const inputBg = isDarkMode ? '#3a3a5c' : '#f8f9fa';

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
    border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 14,
  };

  // 過去の編集履歴から、この承認者項目に対する変更ログを読み込み、
  // 「現在は外れているが、過去に外された記録がある人」を一覧化する
  const fetchRemovedHistory = useCallback(async () => {
    if (!approverField) { setLoadingHistory(false); return; }
    setLoadingHistory(true);
    const { data } = await supabase
      .from('purchase_request_edit_log')
      .select('changes, edited_at')
      .eq('purchase_request_id', record.id)
      .order('edited_at', { ascending: true });

    const latestReasonById: Record<string, RemovedEntry> = {};
    (data ?? []).forEach(log => {
      const diff = (log.changes as Record<string, { old?: unknown; new?: unknown; reason?: string }>)[approverField];
      if (!diff || !Array.isArray(diff.old) || !Array.isArray(diff.new)) return;
      const oldIds = diff.old as string[];
      const newIds = diff.new as string[];
      const removed = oldIds.filter(id => !newIds.includes(id));
      const restored = newIds.filter(id => !oldIds.includes(id));
      removed.forEach(id => {
        latestReasonById[id] = { id, reason: diff.reason ?? '', editedAt: log.edited_at };
      });
      restored.forEach(id => { delete latestReasonById[id]; });
    });

    setRemovedEntries(Object.values(latestReasonById).filter(e => !approverIds.includes(e.id)));
    setLoadingHistory(false);
  }, [approverField, record.id, approverIds]);

  useEffect(() => { fetchRemovedHistory(); }, [fetchRemovedHistory]);

  const handleRemoveApprover = async (approverId: string) => {
    if (!approverField || !removeReason.trim()) { setRemoveError('外す理由を入力してください。'); return; }
    setRemovingSaving(true);
    setRemoveError('');

    const nextIds = approverIds.filter(id => id !== approverId);
    const { error: updateError } = await supabase.from('purchase_requests').update({ [approverField]: nextIds }).eq('id', record.id);
    if (updateError) {
      setRemovingSaving(false);
      setRemoveError('保存に失敗しました: ' + updateError.message);
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('purchase_request_edit_log').insert({
      purchase_request_id: record.id,
      edited_by: user?.id ?? null,
      changes: { [approverField]: { old: approverIds, new: nextIds, reason: removeReason.trim() } },
    });

    setApproverIds(nextIds);
    setRemovingApproverId(null);
    setRemoveReason('');
    setRemovingSaving(false);
    await fetchRemovedHistory();
    onChanged();
  };

  const handleRestoreApprover = async (approverId: string) => {
    if (!approverField) return;
    setRestoringId(approverId);

    const nextIds = [...approverIds, approverId];
    const { error: updateError } = await supabase.from('purchase_requests').update({ [approverField]: nextIds }).eq('id', record.id);
    if (updateError) {
      setRestoringId(null);
      setRemoveError('保存に失敗しました: ' + updateError.message);
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('purchase_request_edit_log').insert({
      purchase_request_id: record.id,
      edited_by: user?.id ?? null,
      changes: { [approverField]: { old: approverIds, new: nextIds, reason: '外したメンバーを元に戻した' } },
    });

    setApproverIds(nextIds);
    setRestoringId(null);
    await fetchRemovedHistory();
    onChanged();
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: cardBg, borderRadius: 12, padding: 20, width: '100%', maxWidth: 380, maxHeight: '85vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 'bold', color: text }}>👤 承認メンバーの編集</div>
          <button type="button" onClick={onClose} style={{ border: 'none', background: 'transparent', color: subText, fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: subText, marginBottom: 12 }}>
          休職・退職などで長期間回答できない人を外せます。外すと「全員回答待ち」の母数から除外されます。
        </div>

        {approverIds.length === 0 ? (
          <div style={{ fontSize: 13, color: subText }}>対象の承認者がいません</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {approverIds.map(id => (
              <div key={id} style={{ padding: 8, background: inputBg, borderRadius: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 13, color: text }}>{names[id] ?? '不明'}</span>
                  {removingApproverId !== id && (
                    <button type="button" onClick={() => { setRemovingApproverId(id); setRemoveReason(''); setRemoveError(''); }}
                      style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid #dc3545', background: 'transparent', color: '#dc3545', fontSize: 11, fontWeight: 'bold', cursor: 'pointer' }}>
                      外す
                    </button>
                  )}
                </div>
                {removingApproverId === id && (
                  <div style={{ marginTop: 6 }}>
                    <textarea value={removeReason} onChange={e => setRemoveReason(e.target.value)} placeholder="外す理由を入力してください（例：休職中のため）" rows={2}
                      style={{ ...inputStyle, minHeight: 40, resize: 'vertical' as const, marginBottom: 6 }} />
                    {removeError && <div style={{ fontSize: 11, color: '#842029', marginBottom: 6 }}>{removeError}</div>}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" onClick={() => { setRemovingApproverId(null); setRemoveReason(''); setRemoveError(''); }} disabled={removingSaving}
                        style={{ padding: '4px 8px', background: '#6c757d', color: '#fff', border: '2px solid #545b62', borderRadius: 4, cursor: removingSaving ? 'default' : 'pointer', fontSize: 11, fontWeight: 'bold' }}>
                        キャンセル
                      </button>
                      <button type="button" onClick={() => handleRemoveApprover(id)} disabled={removingSaving || !removeReason.trim()}
                        style={{ padding: '4px 8px', background: '#dc3545', color: '#fff', border: '2px solid #bd2130', borderRadius: 4, cursor: (removingSaving || !removeReason.trim()) ? 'default' : 'pointer', fontSize: 11, fontWeight: 'bold' }}>
                        {removingSaving ? '処理中...' : 'この人を外す'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {!loadingHistory && removedEntries.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 'bold', color: subText, marginBottom: 6 }}>外したメンバー</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {removedEntries.map(entry => (
                <div key={entry.id} style={{ padding: 8, background: isDarkMode ? '#3a2020' : '#fff5f5', border: `1px solid ${isDarkMode ? '#5c3030' : '#f5c2c7'}`, borderRadius: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 13, color: text }}>{names[entry.id] ?? '不明'}</span>
                    <button type="button" onClick={() => handleRestoreApprover(entry.id)} disabled={restoringId === entry.id}
                      style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid #28a745', background: 'transparent', color: '#28a745', fontSize: 11, fontWeight: 'bold', cursor: restoringId === entry.id ? 'default' : 'pointer' }}>
                      {restoringId === entry.id ? '処理中...' : '↩ 戻す'}
                    </button>
                  </div>
                  {entry.reason && <div style={{ fontSize: 11, color: subText, marginTop: 2 }}>理由：{entry.reason}</div>}
                  <div style={{ fontSize: 10, color: subText, marginTop: 2 }}>{new Date(entry.editedAt).toLocaleString('ja-JP')}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          style={{ width: '100%', marginTop: 16, padding: '10px', borderRadius: 8, border: `1px solid ${border}`, background: 'transparent', color: text, fontWeight: 'bold', cursor: 'pointer' }}
        >
          閉じる
        </button>
      </div>
    </div>
  );
};

export default PurchaseApproverEditModal;
