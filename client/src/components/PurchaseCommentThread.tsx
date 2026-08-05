import React, { useState } from 'react';
import { postPurchaseComment, type PurchaseComment } from '../lib/purchaseComments';

// 備品購入申請の「質問・回答」。履歴・承認画面・管理画面の3か所で共用する。
//
// 🚨 使われずに終わらせないための決まりごと（過去の失敗の再発防止）
//  ・0件でも必ず入口を出す（「対応中マーク」が他人に見えず意味を成さなかった件と同型）
//  ・文字だけの見出しにしない。枠付きボタン＋動詞（「質問する」）にする
//    （定型メッセージの折りたたみが「押せると気づけなかった」失敗があった）
//  ・発言者の名前と役職を必ず出す（誰が答えるべきか分からないと放置される）

interface Props {
  requestId: string;
  itemName: string;
  comments: PurchaseComment[];
  names: Record<string, string>;
  roles?: Record<string, string>;
  currentUserId: string;
  currentUserName: string;
  isDark: boolean;
  /** 承認画面など、最初から開いておきたい場所で true */
  defaultOpen?: boolean;
  onPosted: () => void;
}

const fmt = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const PurchaseCommentThread: React.FC<Props> = ({
  requestId, itemName, comments, names, roles, currentUserId, currentUserName,
  isDark, defaultOpen = false, onPosted,
}) => {
  const [open, setOpen] = useState(defaultOpen || comments.length > 0);
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const text = isDark ? '#e9ecef' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#5a6268' : '#dee2e6';
  const cardBg = isDark ? '#343a40' : '#fff';
  const innerBg = isDark ? '#2c3e50' : '#f1f7fd';

  const submit = async () => {
    setSaving(true); setError('');
    const res = await postPurchaseComment({
      requestId, body, authorId: currentUserId, authorName: currentUserName, itemName,
    });
    setSaving(false);
    if (!res.ok) { setError(res.error ?? '送信に失敗しました'); return; }
    setBody('');
    onPosted();
  };

  // 最後の発言が自分以外なら「回答待ち」。種別を選ばせず状態で表すので入力の手間がない
  const last = comments[comments.length - 1];
  const waiting = !!last && last.author_id !== currentUserId;

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        style={{
          marginTop: 8, padding: '7px 14px', borderRadius: 8, cursor: 'pointer',
          border: `1px solid ${isDark ? '#4a90d9' : '#90caf9'}`,
          background: isDark ? '#2c3e50' : '#e8f4fd',
          color: isDark ? '#fff' : '#1565c0', fontSize: 12.5, fontWeight: 'bold',
        }}>
        💬 質問する
      </button>
    );
  }

  return (
    <div style={{ marginTop: 8, background: innerBg, border: `1px solid ${border}`, borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 'bold', color: text }}>
          💬 質問・回答{comments.length > 0 ? `（${comments.length}件）` : ''}
        </span>
        {waiting && (
          <span style={{ fontSize: 11, fontWeight: 'bold', color: '#fff', background: '#e24b4a', borderRadius: 10, padding: '2px 8px' }}>
            回答待ち
          </span>
        )}
        <button type="button" onClick={() => setOpen(false)}
          style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11.5, color: subText }}>
          ▲ 閉じる
        </button>
      </div>

      {comments.map(c => (
        <div key={c.id} style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 6, padding: '7px 10px', marginBottom: 6 }}>
          <div style={{ fontSize: 11.5, color: subText, marginBottom: 3 }}>
            {names[c.author_id] ?? '不明'}
            {roles?.[c.author_id] && `（${roles[c.author_id]}）`}
            　{fmt(c.created_at)}
          </div>
          <div style={{ fontSize: 13, color: text, whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{c.body}</div>
        </div>
      ))}

      {comments.length === 0 && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: subText }}>まだやりとりはありません</p>
      )}

      {error && (
        <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 6, padding: '6px 10px', marginBottom: 6 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: '#842029' }}>{error}</p>
        </div>
      )}

      <textarea value={body} onChange={e => setBody(e.target.value)} rows={2}
        placeholder="例：この見積の送料は含まれていますか？"
        style={{
          width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 6,
          border: `1px solid ${border}`, background: cardBg, color: text, fontSize: 13, resize: 'vertical',
        }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        <button type="button" onClick={submit} disabled={saving || !body.trim()}
          style={{
            padding: '7px 16px', borderRadius: 8, border: 'none', cursor: body.trim() ? 'pointer' : 'default',
            background: body.trim() ? '#1976d2' : (isDark ? '#495057' : '#ced4da'),
            color: '#fff', fontSize: 12.5, fontWeight: 'bold',
          }}>
          {saving ? '送信中...' : '送信'}
        </button>
        <span style={{ fontSize: 11, color: subText }}>送信すると取り消せません</span>
      </div>
    </div>
  );
};

export default PurchaseCommentThread;
