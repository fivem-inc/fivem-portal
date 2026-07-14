import React, { useState, useEffect, useCallback } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { supabase } from '../../lib/supabaseClient';
import {
  fetchAllAnnouncements,
  createAnnouncement,
  setAnnouncementActive,
  deleteAnnouncement,
  type Announcement,
} from '../../lib/announcements';

// 社内お知らせ管理タブ。
// ・上部：新規お知らせの作成フォーム（タイトル＋本文）＋「📱イメージを見る」プレビュー
// ・下部：これまでのお知らせ履歴（表示中/停止トグル・削除）
// 削除は confirm() を使わず、インライン確認UI（削除しますか？[削除する][やめる]）で行う。
const AnnouncementsTab: React.FC = () => {
  const { isDarkMode } = useAdminPanel();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(false);

  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const bg = isDarkMode ? '#343a40' : 'white';
  const text = isDarkMode ? '#fff' : '#333';
  const subText = isDarkMode ? '#adb5bd' : '#666';
  const borderColor = isDarkMode ? '#6c757d' : '#ddd';
  const inputBg = isDarkMode ? '#495057' : 'white';

  const load = useCallback(async () => {
    setLoading(true);
    const data = await fetchAllAnnouncements();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const canCreate = title.trim().length > 0 && body.trim().length > 0 && !creating;

  const handleCreate = async () => {
    if (!canCreate) return;
    setCreating(true);
    const { data: userData } = await supabase.auth.getUser();
    const { error } = await createAnnouncement(title.trim(), body.trim(), userData.user?.id ?? null);
    setCreating(false);
    if (error) return;
    setTitle('');
    setBody('');
    setShowPreview(false);
    setCreated(true);
    setTimeout(() => setCreated(false), 3000);
    load();
  };

  const handleToggle = async (item: Announcement) => {
    setBusyId(item.id);
    const { error } = await setAnnouncementActive(item.id, !item.active);
    setBusyId(null);
    if (error) return;
    setItems(prev => prev.map(a => a.id === item.id ? { ...a, active: !a.active } : a));
  };

  const handleDelete = async (id: string) => {
    setBusyId(id);
    const { error } = await deleteAnnouncement(id);
    setBusyId(null);
    setConfirmDeleteId(null);
    if (error) return;
    setItems(prev => prev.filter(a => a.id !== id));
  };

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  return (
    <div>
      {/* ── 新規作成 ── */}
      <div style={{ marginBottom: 24 }}>
        <div style={{
          background: '#E3F2FD',
          borderLeft: '3px solid #1565C0',
          borderRadius: '0 6px 6px 0',
          padding: '8px 12px',
          fontSize: 13, fontWeight: 500,
          color: '#0D47A1',
          marginBottom: 8,
        }}>
          📢 お知らせを出す
        </div>

        <div style={{ background: bg, border: `0.5px solid ${borderColor}`, borderRadius: 12, padding: '14px 16px' }}>
          <div style={{ fontSize: 12, color: subText, lineHeight: 1.7, marginBottom: 12 }}>
            全スタッフのホーム画面の上部にお知らせバナーを表示します。<br />
            作成すると「表示中」になり、下の履歴からいつでも停止・再開・削除できます。
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>タイトル</div>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="例：年末年始の休業について"
              style={{
                width: '100%', boxSizing: 'border-box', padding: '8px 10px',
                border: `0.5px solid ${borderColor}`, borderRadius: 8,
                background: inputBg, color: text, fontSize: 13,
              }}
            />
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>本文</div>
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder="お知らせの内容を入力してください"
              rows={3}
              style={{
                width: '100%', boxSizing: 'border-box', padding: '8px 10px',
                border: `0.5px solid ${borderColor}`, borderRadius: 8,
                background: inputBg, color: text, fontSize: 13, lineHeight: 1.6,
                resize: 'vertical', fontFamily: 'inherit',
              }}
            />
          </div>

          {/* イメージ（スタッフ画面での実際の見え方）プレビュー */}
          <div style={{ marginBottom: 14 }}>
            <button type="button" onClick={() => setShowPreview(v => !v)}
              style={{ fontSize: 12, padding: '5px 14px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: 'none', color: text, cursor: 'pointer' }}>
              {showPreview ? 'イメージを閉じる' : '📱 イメージを見る'}
            </button>
            {showPreview && (
              <div style={{ marginTop: 10, background: isDarkMode ? '#2d3136' : '#f4f6f4', borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 11, color: subText, marginBottom: 8 }}>スタッフのホーム画面に、こう表示されます</div>
                <div style={{ background: '#e7f1fb', border: '1px solid #b6d4f2', borderRadius: 10, padding: '12px 14px', maxWidth: 360 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <span style={{ fontSize: 20, flexShrink: 0 }}>📢</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 'bold', color: '#0d47a1', marginBottom: 2 }}>{title.trim() || 'お知らせのタイトル'}</div>
                      <div style={{ fontSize: 12.5, color: '#1565c0', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{body.trim() || 'お知らせの本文がここに表示されます'}</div>
                    </div>
                    <span style={{ fontSize: 16, color: '#5a8bc0', flexShrink: 0, lineHeight: 1 }}>✕</span>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: subText, marginTop: 8 }}>※スタッフは右上の ✕ で個別に閉じられます。</div>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={handleCreate}
              disabled={!canCreate}
              style={{
                padding: '7px 22px', borderRadius: 8, border: 'none',
                background: canCreate ? '#1565C0' : (isDarkMode ? '#495057' : '#ccc'),
                color: '#fff', fontSize: 13, fontWeight: 'bold',
                cursor: canCreate ? 'pointer' : 'default',
              }}>
              {creating ? '送信中...' : 'お知らせを出す'}
            </button>
            {created && <span style={{ fontSize: 12, color: '#28a745', fontWeight: 600 }}>✓ お知らせを出しました</span>}
          </div>
        </div>
      </div>

      {/* ── 履歴 ── */}
      <div>
        <div style={{
          background: isDarkMode ? '#2d3136' : '#f1f3f5',
          borderLeft: `3px solid ${isDarkMode ? '#6c757d' : '#adb5bd'}`,
          borderRadius: '0 6px 6px 0',
          padding: '8px 12px',
          fontSize: 13, fontWeight: 500,
          color: subText,
          marginBottom: 8,
        }}>
          🗒️ これまでのお知らせ（履歴）
        </div>

        {loading ? (
          <div style={{ fontSize: 13, color: subText, padding: '8px 2px' }}>読み込み中...</div>
        ) : items.length === 0 ? (
          <div style={{ fontSize: 13, color: subText, padding: '8px 2px' }}>まだお知らせはありません。</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {items.map(item => (
              <div key={item.id} style={{
                background: bg,
                border: `0.5px solid ${item.active ? '#1565C0' : borderColor}`,
                borderRadius: 12, padding: '12px 14px',
                opacity: item.active ? 1 : 0.75,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                    background: item.active ? '#e7f1fb' : (isDarkMode ? '#495057' : '#e9ecef'),
                    color: item.active ? '#1565C0' : subText,
                  }}>
                    {item.active ? '表示中' : '停止中'}
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 'bold', color: text, flex: 1, minWidth: 0 }}>{item.title}</span>
                  <span style={{ fontSize: 11, color: subText, whiteSpace: 'nowrap' }}>{fmtDate(item.created_at)}</span>
                </div>

                <div style={{ fontSize: 13, color: text, lineHeight: 1.7, whiteSpace: 'pre-wrap', marginBottom: 10 }}>{item.body}</div>

                {confirmDeleteId === item.id ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12.5, color: '#dc3545', fontWeight: 600 }}>このお知らせを削除しますか？（元に戻せません）</span>
                    <button onClick={() => handleDelete(item.id)} disabled={busyId === item.id}
                      style={{ fontSize: 12, padding: '5px 14px', borderRadius: 8, border: 'none', background: '#dc3545', color: '#fff', fontWeight: 600, cursor: busyId === item.id ? 'default' : 'pointer' }}>
                      {busyId === item.id ? '削除中...' : '削除する'}
                    </button>
                    <button onClick={() => setConfirmDeleteId(null)} disabled={busyId === item.id}
                      style={{ fontSize: 12, padding: '5px 14px', borderRadius: 8, border: `0.5px solid ${borderColor}`, background: 'none', color: text, cursor: 'pointer' }}>
                      やめる
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button onClick={() => handleToggle(item)} disabled={busyId === item.id}
                      style={{ fontSize: 12, padding: '5px 14px', borderRadius: 8, border: `0.5px solid ${borderColor}`, background: 'none', color: text, cursor: busyId === item.id ? 'default' : 'pointer' }}>
                      {busyId === item.id ? '...' : (item.active ? '表示を停止' : '再表示する')}
                    </button>
                    <button onClick={() => setConfirmDeleteId(item.id)} disabled={busyId === item.id}
                      style={{ fontSize: 12, padding: '5px 14px', borderRadius: 8, border: '0.5px solid #f1b0b7', background: 'none', color: '#dc3545', cursor: 'pointer' }}>
                      削除
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default AnnouncementsTab;
