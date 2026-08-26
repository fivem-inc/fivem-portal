import React, { useState, useEffect, useCallback } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { supabase } from '../../lib/supabaseClient';
import {
  fetchAllAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  setAnnouncementActive,
  deleteAnnouncement,
  type Announcement,
  type AnnouncementInput,
  type RemindFrequency,
} from '../../lib/announcements';
import {
  dateInputToStartIso,
  dateInputToEndIso,
  isoToDateInput,
  isoToShortDate,
  effectiveStatus,
  STATUS_LABEL,
  type EffectiveStatus,
} from '../../lib/announcementDates';

// 社内お知らせ管理タブ。
// ・上部：新規作成／編集フォーム（タイトル＋本文＋「詳細設定」で表示期間・リマインド）
// ・下部：これまでのお知らせ履歴（実効ステータス・期間・リマインド表示／停止・編集・削除）
// alert()/confirm() は使わず、検証エラー・削除確認はすべてインラインで表示する。
const DEFAULT_REMIND_DAYS = '3';

const AnnouncementsTab: React.FC = () => {
  const { isDarkMode } = useAdminPanel();

  // フォーム状態（新規・編集で共用。editingId が null なら新規）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [notifyCreatePush, setNotifyCreatePush] = useState(false);
  const [notifyCreateEmail, setNotifyCreateEmail] = useState(false);
  const [remindInApp, setRemindInApp] = useState(false);
  const [remindPush, setRemindPush] = useState(false);
  const [remindEmail, setRemindEmail] = useState(false);
  const [remindDaysBefore, setRemindDaysBefore] = useState(DEFAULT_REMIND_DAYS);
  const [remindFrequency, setRemindFrequency] = useState<RemindFrequency>('once');
  const [showDetails, setShowDetails] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');

  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const bg = isDarkMode ? '#343a40' : 'white';
  const text = isDarkMode ? '#fff' : '#333';
  const subText = isDarkMode ? '#adb5bd' : '#666';
  const borderColor = isDarkMode ? '#6c757d' : '#ddd';
  const inputBg = isDarkMode ? '#495057' : 'white';
  const colorScheme = isDarkMode ? 'dark' : 'light';

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '8px 10px',
    border: `0.5px solid ${borderColor}`, borderRadius: 8,
    background: inputBg, color: text, fontSize: 13,
  };

  const load = useCallback(async () => {
    setLoading(true);
    const data = await fetchAllAnnouncements();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const resetForm = () => {
    setEditingId(null);
    setTitle(''); setBody('');
    setStartDate(''); setEndDate('');
    setNotifyCreatePush(false); setNotifyCreateEmail(false);
    setRemindInApp(false); setRemindPush(false); setRemindEmail(false);
    setRemindDaysBefore(DEFAULT_REMIND_DAYS);
    setRemindFrequency('once');
    setShowDetails(false);
    setShowPreview(false);
  };

  // 終了日が未設定だとリマインド（終了日基準）は成立しないので使えない
  const hasEnd = endDate.trim().length > 0;
  // 開始日 > 終了日 は不正
  const dateOrderError = !!startDate && !!endDate && startDate > endDate;
  const remindOn = hasEnd && (remindInApp || remindPush || remindEmail);

  const canSubmit =
    title.trim().length > 0 && body.trim().length > 0 && !dateOrderError && !saving;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    const input: AnnouncementInput = {
      title: title.trim(),
      body: body.trim(),
      starts_at: dateInputToStartIso(startDate),
      ends_at: dateInputToEndIso(endDate),
      notify_on_create_push: notifyCreatePush,
      notify_on_create_email: notifyCreateEmail,
      remind_in_app: hasEnd && remindInApp,
      remind_push: hasEnd && remindPush,
      remind_email: hasEnd && remindEmail,
      remind_days_before: Math.max(1, parseInt(remindDaysBefore, 10) || 3),
      remind_frequency: remindFrequency,
    };
    if (editingId) {
      const { error } = await updateAnnouncement(editingId, input);
      setSaving(false);
      if (error) return;
    } else {
      const { data, error } = await createAnnouncement(input, (await supabase.auth.getUser()).data.user?.id ?? null);
      if (error || !data) { setSaving(false); return; }
      // 作成時通知（プッシュ／メール）はサーバー側で全員へ配信。失敗してもお知らせ自体は作成済み。
      if (input.notify_on_create_push || input.notify_on_create_email) {
        await supabase.functions.invoke('announcement-notify', { body: { id: data.id } });
      }
      setSaving(false);
    }
    const msg = editingId ? '✓ お知らせを更新しました' : '✓ お知らせを出しました';
    resetForm();
    setSavedMsg(msg);
    setTimeout(() => setSavedMsg(''), 3000);
    load();
  };

  const handleEdit = (item: Announcement) => {
    setEditingId(item.id);
    setTitle(item.title);
    setBody(item.body);
    setStartDate(isoToDateInput(item.starts_at));
    setEndDate(isoToDateInput(item.ends_at));
    setNotifyCreatePush(item.notify_on_create_push);
    setNotifyCreateEmail(item.notify_on_create_email);
    setRemindInApp(item.remind_in_app);
    setRemindPush(item.remind_push);
    setRemindEmail(item.remind_email);
    setRemindDaysBefore(String(item.remind_days_before ?? 3));
    setRemindFrequency(item.remind_frequency ?? 'once');
    // 期間やリマインド等が設定済みなら詳細を開いた状態で編集させる
    setShowDetails(!!(item.starts_at || item.ends_at || item.notify_on_create_push ||
      item.notify_on_create_email || item.remind_in_app || item.remind_push || item.remind_email));
    setShowPreview(false);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
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
    if (editingId === id) resetForm();
    setItems(prev => prev.filter(a => a.id !== id));
  };

  const fmtDateTime = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  // 履歴カードの期間テキスト（例：12/25〜12/28 ／ 〜12/28 ／ 12/25〜）
  const periodText = (a: Announcement): string => {
    const s = isoToShortDate(a.starts_at);
    const e = isoToShortDate(a.ends_at);
    if (!s && !e) return '';
    return `${s}〜${e}`;
  };

  const remindText = (a: Announcement): string => {
    if (!a.remind_in_app && !a.remind_push && !a.remind_email) return '';
    const ways: string[] = [];
    if (a.remind_in_app) ways.push('アプリ内');
    if (a.remind_push) ways.push('通知');
    if (a.remind_email) ways.push('メール');
    const freq = a.remind_frequency === 'daily' ? '毎日' : '1回';
    return `${a.remind_days_before}日前から${ways.join('＋')}（${freq}）`;
  };

  // 作成時通知（プッシュ／メール）の履歴表示テキスト
  const createNotifyText = (a: Announcement): string => {
    const ways: string[] = [];
    if (a.notify_on_create_push) ways.push('通知');
    if (a.notify_on_create_email) ways.push('メール');
    return ways.length ? `作成時：${ways.join('＋')}で連絡` : '';
  };

  const statusStyle = (s: EffectiveStatus): React.CSSProperties => {
    const map: Record<EffectiveStatus, { bg: string; fg: string }> = {
      showing: { bg: '#e7f1fb', fg: '#1565C0' },
      scheduled: { bg: isDarkMode ? '#4d3b1f' : '#fff3e0', fg: isDarkMode ? '#ffcc80' : '#e65100' },
      ended: { bg: isDarkMode ? '#495057' : '#e9ecef', fg: subText },
      stopped: { bg: isDarkMode ? '#495057' : '#e9ecef', fg: subText },
    };
    const c = map[s];
    return { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: c.bg, color: c.fg };
  };

  return (
    <div>
      {/* ── 新規作成 / 編集 ── */}
      <div style={{ marginBottom: 24 }}>
        <div style={{
          background: editingId ? '#FFF3E0' : '#E3F2FD',
          borderLeft: `3px solid ${editingId ? '#E65100' : '#1565C0'}`,
          borderRadius: '0 6px 6px 0',
          padding: '8px 12px',
          fontSize: 13, fontWeight: 500,
          color: editingId ? '#E65100' : '#0D47A1',
          marginBottom: 8,
        }}>
          {editingId ? '✏️ お知らせを編集' : '📢 お知らせを出す'}
        </div>

        <div style={{ background: bg, border: `0.5px solid ${borderColor}`, borderRadius: 12, padding: '14px 16px' }}>
          <div style={{ fontSize: 12, color: subText, lineHeight: 1.7, marginBottom: 12 }}>
            全スタッフのホーム画面の上部にお知らせバナーを表示します。<br />
            作成すると「表示中」になり、下の履歴からいつでも停止・編集・削除できます。
          </div>

          <div style={{ marginBottom: 12 }}>
            <label htmlFor="ann-title" style={{ display: 'block', fontSize: 12, color: subText, marginBottom: 4 }}>タイトル</label>
            <input id="ann-title" type="text" value={title} onChange={e => setTitle(e.target.value)}
              placeholder="例：年末年始の休業について" style={inputStyle} />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label htmlFor="ann-body" style={{ display: 'block', fontSize: 12, color: subText, marginBottom: 4 }}>本文</label>
            <textarea id="ann-body" value={body} onChange={e => setBody(e.target.value)}
              placeholder="お知らせの内容を入力してください" rows={3}
              style={{ ...inputStyle, lineHeight: 1.6, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>

          {/* 詳細設定（表示期間・リマインド）：既定は折りたたみ */}
          <div style={{ marginBottom: 14 }}>
            <button type="button" onClick={() => setShowDetails(v => !v)}
              style={{ fontSize: 12, padding: '5px 14px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: 'none', color: text, cursor: 'pointer' }}>
              {showDetails ? '詳細設定を閉じる ▲' : '詳細設定（表示期間・リマインド）を開く ▼'}
            </button>

            {showDetails && (
              <div style={{ marginTop: 10 }}>
                {/* 表示期間 */}
                <div style={{ padding: 12, background: isDarkMode ? '#2d3136' : '#f8fafc', border: `0.5px solid ${borderColor}`, borderRadius: 10, marginBottom: 12 }}>
                  <div style={{ fontSize: 12, color: isDarkMode ? '#90caf9' : '#0D47A1', fontWeight: 500, marginBottom: 8 }}>📅 表示する期間（任意）</div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <label htmlFor="ann-start" style={{ display: 'block', fontSize: 11, color: subText, marginBottom: 4 }}>開始日時</label>
                      <input id="ann-start" type="datetime-local" value={startDate} max={endDate || undefined}
                        onChange={e => setStartDate(e.target.value)} style={{ ...inputStyle, colorScheme }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <label htmlFor="ann-end" style={{ display: 'block', fontSize: 11, color: subText, marginBottom: 4 }}>終了日時（＝期限）</label>
                      <input id="ann-end" type="datetime-local" value={endDate} min={startDate || undefined}
                        onChange={e => setEndDate(e.target.value)} style={{ ...inputStyle, colorScheme }} />
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: subText, marginTop: 6, lineHeight: 1.6 }}>
                    開始日時を空にすると<strong>今すぐ</strong>表示、終了日時を空にすると<strong>期限なし</strong>（手動停止まで）。
                  </div>
                  {dateOrderError && (
                    <div style={{ fontSize: 12, color: '#dc3545', fontWeight: 600, marginTop: 6 }}>⚠️ 開始日時は終了日時より前にしてください。</div>
                  )}
                </div>

                {/* 作成時に知らせる */}
                <div style={{ padding: 12, background: isDarkMode ? '#22323a' : '#f0f7fa', border: `0.5px solid ${isDarkMode ? '#3a5a6c' : '#cfe4f2'}`, borderRadius: 10, marginBottom: 12 }}>
                  <div style={{ fontSize: 12, color: isDarkMode ? '#90caf9' : '#0D47A1', fontWeight: 500, marginBottom: 4 }}>📣 作成時に知らせる（投稿した瞬間に1回・任意）</div>
                  <div style={{ fontSize: 11, color: subText, marginBottom: 8 }}>アプリ内バナーは設定に関係なく表示されます。開いていない人にも届けたいときに使います。</div>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: text, marginBottom: 8, cursor: 'pointer' }}>
                    <input type="checkbox" checked={notifyCreatePush} onChange={e => setNotifyCreatePush(e.target.checked)} style={{ marginTop: 2 }} />
                    <span>プッシュ通知で知らせる<br /><span style={{ fontSize: 11, color: subText }}>通知をONにしている人のスマホに届きます</span></span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: text, cursor: 'pointer' }}>
                    <input type="checkbox" checked={notifyCreateEmail} onChange={e => setNotifyCreateEmail(e.target.checked)} style={{ marginTop: 2 }} />
                    <span>メールで知らせる<br /><span style={{ fontSize: 11, color: subText }}>全員のメールに届きます（通知OFFの人にも気づいてもらえます）</span></span>
                  </label>
                </div>

                {/* リマインド */}
                <div style={{ padding: 12, background: isDarkMode ? '#3a3222' : '#fff8f0', border: `0.5px solid ${isDarkMode ? '#6c5a3a' : '#f2e2cf'}`, borderRadius: 10 }}>
                  <div style={{ fontSize: 12, color: isDarkMode ? '#ffcc80' : '#854F0B', fontWeight: 500, marginBottom: 8 }}>🔔 期限が近づいたらもう一度知らせる（任意）</div>
                  {!hasEnd && (
                    <div style={{ fontSize: 11, color: subText, marginBottom: 8 }}>※ 終了日を決めると使えます。</div>
                  )}
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: hasEnd ? text : subText, marginBottom: 8, cursor: hasEnd ? 'pointer' : 'default' }}>
                    <input type="checkbox" checked={hasEnd && remindInApp} disabled={!hasEnd}
                      onChange={e => setRemindInApp(e.target.checked)} style={{ marginTop: 2 }} />
                    <span>アプリ内でもう一度表示する<br /><span style={{ fontSize: 11, color: subText }}>閉じた人にも再表示（アプリを開いたとき。通知は鳴りません）</span></span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: hasEnd ? text : subText, marginBottom: 8, cursor: hasEnd ? 'pointer' : 'default' }}>
                    <input type="checkbox" checked={hasEnd && remindPush} disabled={!hasEnd}
                      onChange={e => setRemindPush(e.target.checked)} style={{ marginTop: 2 }} />
                    <span>通知でも知らせる<br /><span style={{ fontSize: 11, color: subText }}>通知をONにしている人のスマホにプッシュ通知が届きます</span></span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: hasEnd ? text : subText, marginBottom: 10, cursor: hasEnd ? 'pointer' : 'default' }}>
                    <input type="checkbox" checked={hasEnd && remindEmail} disabled={!hasEnd}
                      onChange={e => setRemindEmail(e.target.checked)} style={{ marginTop: 2 }} />
                    <span>メールでも知らせる<br /><span style={{ fontSize: 11, color: subText }}>全員のメールに届きます（通知OFFの人にも気づいてもらえます）</span></span>
                  </label>

                  {remindOn && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: text, flexWrap: 'wrap' }}>
                        <span>終了日の</span>
                        <input type="number" min={1} inputMode="numeric" value={remindDaysBefore}
                          onChange={e => setRemindDaysBefore(e.target.value)}
                          style={{ ...inputStyle, width: 56, padding: '6px 8px', textAlign: 'center' }} />
                        <span>日前からリマインド</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: text, flexWrap: 'wrap' }}>
                        <span>回数：</span>
                        {(['once', 'daily'] as RemindFrequency[]).map(f => (
                          <button key={f} type="button" onClick={() => setRemindFrequency(f)}
                            style={{
                              fontSize: 12, padding: '5px 12px', borderRadius: 8, cursor: 'pointer',
                              border: `0.5px solid ${remindFrequency === f ? '#1565C0' : borderColor}`,
                              background: remindFrequency === f ? '#1565C0' : 'none',
                              color: remindFrequency === f ? '#fff' : text, fontWeight: remindFrequency === f ? 700 : 400,
                            }}>
                            {f === 'once' ? '期間中1回だけ' : '期間中は毎日'}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
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

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={handleSubmit} disabled={!canSubmit}
              style={{
                padding: '7px 22px', borderRadius: 8, border: 'none',
                background: canSubmit ? '#1565C0' : (isDarkMode ? '#495057' : '#ccc'),
                color: '#fff', fontSize: 13, fontWeight: 'bold',
                cursor: canSubmit ? 'pointer' : 'default',
              }}>
              {saving ? '保存中...' : (editingId ? '更新する' : 'お知らせを出す')}
            </button>
            {editingId && (
              <button onClick={resetForm} disabled={saving}
                style={{ fontSize: 12, padding: '6px 16px', borderRadius: 8, border: `0.5px solid ${borderColor}`, background: 'none', color: text, cursor: 'pointer' }}>
                編集をやめる
              </button>
            )}
            {savedMsg && <span style={{ fontSize: 12, color: '#28a745', fontWeight: 600 }}>{savedMsg}</span>}
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
          📋 これまでのお知らせ（履歴）
        </div>

        {loading ? (
          <div style={{ fontSize: 13, color: subText, padding: '8px 2px' }}>読み込み中...</div>
        ) : items.length === 0 ? (
          <div style={{ fontSize: 13, color: subText, padding: '8px 2px' }}>まだお知らせはありません。</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {items.map(item => {
              const status = effectiveStatus(item);
              const period = periodText(item);
              const remind = remindText(item);
              const createNotify = createNotifyText(item);
              const isEditing = editingId === item.id;
              return (
              <div key={item.id} style={{
                background: bg,
                border: `0.5px solid ${isEditing ? '#E65100' : (status === 'showing' ? '#1565C0' : borderColor)}`,
                borderRadius: 12, padding: '12px 14px',
                opacity: status === 'showing' || status === 'scheduled' ? 1 : 0.75,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                  <span style={statusStyle(status)}>{STATUS_LABEL[status]}</span>
                  <span style={{ fontSize: 14, fontWeight: 'bold', color: text, flex: 1, minWidth: 0 }}>{item.title}</span>
                  <span style={{ fontSize: 11, color: subText, whiteSpace: 'nowrap' }}>{fmtDateTime(item.created_at)}</span>
                </div>

                <div style={{ fontSize: 13, color: text, lineHeight: 1.7, whiteSpace: 'pre-wrap', marginBottom: 8 }}>{item.body}</div>

                {(period || remind || createNotify) && (
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11.5, color: subText, marginBottom: 10 }}>
                    {period && <span>📅 {period}</span>}
                    {createNotify && <span>📣 {createNotify}</span>}
                    {remind && <span>⏰ {remind}</span>}
                  </div>
                )}

                {status === 'ended' && (
                  <div style={{ fontSize: 11.5, color: subText, marginBottom: 8 }}>
                    期限切れです。「編集」で終了日を延ばすと再表示できます。
                  </div>
                )}

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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {status !== 'ended' && (
                      <button onClick={() => handleToggle(item)} disabled={busyId === item.id}
                        style={{ fontSize: 12, padding: '5px 14px', borderRadius: 8, border: `0.5px solid ${borderColor}`, background: 'none', color: text, cursor: busyId === item.id ? 'default' : 'pointer' }}>
                        {busyId === item.id ? '...' : (item.active ? '表示を停止' : '再表示する')}
                      </button>
                    )}
                    <button onClick={() => handleEdit(item)}
                      style={{ fontSize: 12, padding: '5px 14px', borderRadius: 8, border: `0.5px solid ${borderColor}`, background: 'none', color: text, cursor: 'pointer' }}>
                      編集
                    </button>
                    <button onClick={() => setConfirmDeleteId(item.id)} disabled={busyId === item.id}
                      style={{ fontSize: 12, padding: '5px 14px', borderRadius: 8, border: '0.5px solid #f1b0b7', background: 'none', color: '#dc3545', cursor: 'pointer' }}>
                      削除
                    </button>
                  </div>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default AnnouncementsTab;
