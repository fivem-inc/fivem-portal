import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';

const FIELD_LABELS: Record<string, string> = {
  item_name: '品目名', quantity: '数量', amount: '金額', purchased_at: '購入日',
  store_name: '購入先', purpose: '用途', location: '使用先', instructed_by: '指示者',
  payment_method: '支払方法', notes: '備考',
  board_approver_ids: '承認者（全員承認）', requested_manager_ids: '承認者（マネージャー）',
};

interface EditLogRow {
  id: string;
  edited_by: string | null;
  edited_at: string;
  changes: Record<string, { old: string | number | null; new: string | number | null; reason?: string }>;
}

interface PurchaseRequestEditHistoryModalProps {
  purchaseRequestId: string;
  isDarkMode: boolean;
  onClose: () => void;
}

const formatValue = (v: string | number | null) => (v === null || v === '' ? '(空)' : String(v));

const PurchaseRequestEditHistoryModal: React.FC<PurchaseRequestEditHistoryModalProps> = ({ purchaseRequestId, isDarkMode, onClose }) => {
  const [logs, setLogs] = useState<EditLogRow[]>([]);
  const [editorNames, setEditorNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('purchase_request_edit_log')
        .select('id, edited_by, edited_at, changes')
        .eq('purchase_request_id', purchaseRequestId)
        .order('edited_at', { ascending: false });
      const rows = (data ?? []) as EditLogRow[];
      setLogs(rows);

      const editorIds = [...new Set(rows.map(r => r.edited_by).filter((id): id is string => !!id))];
      if (editorIds.length > 0) {
        const { data: profs } = await supabase.from('profiles').select('id, name').in('id', editorIds);
        const namesMap: Record<string, string> = {};
        (profs ?? []).forEach((p: { id: string; name: string }) => { namesMap[p.id] = p.name; });
        setEditorNames(namesMap);
      }

      setLoading(false);
    })();
  }, [purchaseRequestId]);

  const cardBg = isDarkMode ? '#2d2d3e' : '#ffffff';
  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const subText = isDarkMode ? '#aaaaaa' : '#666666';
  const inputBg = isDarkMode ? '#3a3a5c' : '#f8f9fa';

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10001, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: cardBg, borderRadius: 12, padding: 20, width: '100%', maxWidth: 420, maxHeight: '85vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 'bold', color: text }}>修正履歴</div>
          <button type="button" onClick={onClose} style={{ border: 'none', background: 'transparent', color: subText, fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>

        {loading && <div style={{ color: subText, fontSize: 13 }}>読み込み中...</div>}
        {!loading && logs.length === 0 && <div style={{ color: subText, fontSize: 13 }}>修正履歴はありません</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {logs.map(log => (
            <div key={log.id} style={{ padding: 10, background: inputBg, borderRadius: 8 }}>
              <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>
                {new Date(log.edited_at).toLocaleString('ja-JP')}（{editorNames[log.edited_by ?? ''] ?? '不明'}）
              </div>
              {Object.entries(log.changes).map(([field, diff]) => (
                <div key={field} style={{ fontSize: 12, color: text, marginBottom: 2 }}>
                  <span style={{ fontWeight: 'bold' }}>{FIELD_LABELS[field] ?? field}</span>：
                  <span style={{ color: '#dc3545' }}>{formatValue(diff.old)}</span>
                  {' → '}
                  <span style={{ color: '#28a745' }}>{formatValue(diff.new)}</span>
                  {diff.reason && (
                    <div style={{ marginTop: 2, color: subText }}>理由：{diff.reason}</div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>

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

export default PurchaseRequestEditHistoryModal;
