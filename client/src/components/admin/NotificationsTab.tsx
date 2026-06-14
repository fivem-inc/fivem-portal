import React, { useState, useEffect, useCallback } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { supabase } from '../../lib/supabaseClient';
import { invalidateNotificationCache } from '../../lib/notificationDispatch';

interface NotificationSetting {
  id: string;
  event_key: string;
  channel: string;
  enabled: boolean;
  recipient: string | null;
  subject: string | null;
  template: string | null;
}

interface EmailTemplate {
  id: string;
  name: string;
  subject: string | null;
  template: string | null;
  created_at: string;
}

type ChannelType = 'slack' | 'email' | 'site';

const EVENT_GROUPS = [
  {
    label: '休暇申請',
    icon: '🌿',
    headerBg: '#E8F5E9', headerBorder: '#2E7D32', headerText: '#1B5E20',
    events: [
      { key: 'leave:new_request',      label: '申請時' },
      { key: 'leave:leader_approved',  label: 'リーダー受理時' },
      { key: 'leave:manager_approved', label: 'マネージャー受理時' },
      { key: 'leave:rejected',         label: '差し戻し時' },
      { key: 'leave:cancelled',        label: '取り消し時' },
    ],
  },
  {
    label: '交通費申請',
    icon: '🚃',
    headerBg: '#E3F2FD', headerBorder: '#1565C0', headerText: '#0D47A1',
    events: [
      { key: 'expense:new_request', label: '申請時' },
    ],
  },
  {
    label: '出張報告',
    icon: '📍',
    headerBg: '#FFF3E0', headerBorder: '#E65100', headerText: '#BF360C',
    events: [
      { key: 'trip:report_end', label: '終了報告時' },
    ],
  },
  {
    label: '時間調整',
    icon: '🕐',
    headerBg: '#E8EAF6', headerBorder: '#3949AB', headerText: '#1A237E',
    events: [
      { key: 'time_adjustment:registered', label: '登録時' },
    ],
  },
];

const CHANNEL_LABELS: Record<ChannelType, string> = {
  slack: 'Slack',
  email: 'メール',
  site: 'サイト通知',
};

const CHANNEL_ICONS: Record<ChannelType, string> = {
  slack: '💬',
  email: '📧',
  site: '🔔',
};

const VARIABLES_BY_EVENT: Record<string, string[]> = {
  'leave:new_request':           ['{{承認者名}}', '{{承認者役職}}'],
  'leave:leader_approved':       ['{{承認者名}}', '{{承認者役職}}', '{{次承認者名}}'],
  'leave:manager_approved':      ['{{承認者名}}', '{{休暇種別}}'],
  'leave:rejected':              ['{{申請者名}}', '{{休暇種別}}', '{{差し戻し理由}}'],
  'leave:cancelled':             ['{{申請者名}}', '{{休暇種別}}', '{{取り消し理由}}'],
  'expense:new_request':         ['{{申請者名}}', '{{申請日}}', '{{申請内容}}', '{{項目数}}'],
  'trip:report_end':             ['{{申請者名}}', '{{申請日}}'],
  'time_adjustment:registered':  ['{{登録者名}}', '{{種別}}', '{{日付}}', '{{理由}}'],
};

// 時間調整イベント用: Slackチャンネル選択肢
const TIME_ADJ_SLACK_OPTIONS = [
  { value: 'leader',     label: '#01リーダー回覧' },
  { value: 'manager',    label: '#01マネージャー回覧' },
  { value: 'accounting', label: '#07_3経理専用' },
  { value: 'president',  label: '#03晃平先生へ' },
];

// 時間調整イベント用: 役職選択肢（メール・サイト通知）
const TIME_ADJ_ROLE_OPTIONS = ['申請者本人', 'リーダー', 'マネージャー', '管理者', '社長'];

// 時間調整用 recipient JSON パーサー
const parseRoleRecipient = (recipient: string | null): { roles: string[]; groupFilter: string } => {
  try {
    const p = JSON.parse(recipient ?? '{}');
    return {
      roles: Array.isArray(p.roles) ? p.roles : ['リーダー', 'マネージャー'],
      groupFilter: p.groupFilter ?? 'same',
    };
  } catch {
    return { roles: ['リーダー', 'マネージャー'], groupFilter: 'same' };
  }
};

const parseSlackChannels = (recipient: string | null): string[] => {
  if (!recipient) return [];
  try {
    const p = JSON.parse(recipient);
    if (Array.isArray(p.channels)) return p.channels;
  } catch { /* 旧形式: plain string */ }
  return [recipient];
};

const parseEmailSiteRecipients = (recipient: string | null): string[] => {
  if (!recipient) return ['applicant'];
  try {
    const p = JSON.parse(recipient);
    if (Array.isArray(p.recipients)) return p.recipients;
  } catch { /* 旧形式: plain string */ }
  return [recipient];
};

const TRIP_SLACK_CHANNELS = [
  { value: 'adult',              label: '#03大人へ' },
  { value: 'kids_main',          label: '#04本校こどもへ' },
  { value: 'kids_nishijin',      label: '#05_2西陣校こどもへ' },
  { value: 'kids_kamikatsura',   label: '#05_3上桂校こどもへ' },
  { value: 'kids_rakusaiguchi',  label: '#05_4洛西口校こどもへ' },
  { value: 'kids_minamisusita',  label: '#05_5南草津校こどもへ' },
  { value: 'junior',             label: '#06ジュニアへ' },
  { value: 'support',            label: '#07_1お客様サポートへ' },
];

const SLACK_CHANNEL_OPTIONS_BY_EVENT: Record<string, { value: string; label: string }[]> = {
  'leave:new_request':      [{ value: 'leader',     label: '#01リーダー回覧' }, { value: 'manager', label: '#01マネージャー回覧' }],
  'leave:leader_approved':  [{ value: 'manager',    label: '#01マネージャー回覧' }],
  'leave:manager_approved': [{ value: 'accounting', label: '#07_3閲覧禁止-経理専用' }],
  'leave:rejected':         [{ value: 'leader', label: '#01リーダー回覧' }, { value: 'manager', label: '#01マネージャー回覧' }, { value: 'accounting', label: '#07_3閲覧禁止-経理専用' }],
  'leave:cancelled':        [{ value: 'leader', label: '#01リーダー回覧' }, { value: 'manager', label: '#01マネージャー回覧' }, { value: 'accounting', label: '#07_3閲覧禁止-経理専用' }],
  'expense:new_request':    [{ value: 'expense',    label: '#07_3閲覧禁止-経理専用' }],
  'trip:report_end':        TRIP_SLACK_CHANNELS,
};

// テンプレートライブラリで使える全変数（カテゴリ別）
const TEMPLATE_VAR_GROUPS: { label: string; color: string; vars: { v: string; desc: string }[] }[] = [
  {
    label: '共通', color: '#546e7a',
    vars: [
      { v: '{{申請者名}}', desc: '申請した人の名前' },
    ],
  },
  {
    label: '休暇申請', color: '#2E7D32',
    vars: [
      { v: '{{承認者名}}',    desc: '承認する人の名前' },
      { v: '{{承認者役職}}',  desc: '承認する人の役職（リーダー等）' },
      { v: '{{次承認者名}}',  desc: '次のステップの承認者名' },
      { v: '{{休暇種別}}',    desc: '有給・特別休暇・慶弔休暇など' },
      { v: '{{差し戻し理由}}', desc: '差し戻し時のコメント' },
      { v: '{{取り消し理由}}', desc: '申請を取り消した理由' },
    ],
  },
  {
    label: '交通費申請', color: '#1565C0',
    vars: [
      { v: '{{申請日}}',   desc: '申請が行われた日付' },
      { v: '{{申請内容}}', desc: '交通費の経路・内容' },
      { v: '{{項目数}}',   desc: '経路の件数（例：3件分）' },
    ],
  },
  {
    label: '時間調整', color: '#3949AB',
    vars: [
      { v: '{{登録者名}}', desc: '登録した人の名前' },
      { v: '{{種別}}',     desc: '調整遅出 または 調整早退' },
      { v: '{{日付}}',     desc: '対象日（例：6/13）' },
      { v: '{{理由}}',     desc: '登録理由' },
    ],
  },
];

const RECIPIENT_OPTIONS: Record<string, { value: string; label: string }[]> = {
  slack: [],
  email: [
    { value: 'applicant', label: '申請者本人' },
    { value: 'leader',    label: 'リーダー' },
    { value: 'manager',   label: 'マネージャー' },
    { value: 'approver',  label: '申請先（承認者）' },
  ],
  site: [
    { value: 'applicant', label: '申請者本人' },
    { value: 'approver',  label: '申請先（承認者）' },
    { value: 'leader',    label: 'リーダー' },
    { value: 'manager',   label: 'マネージャー' },
  ],
};

const NotificationsTab: React.FC = () => {
  const { isDarkMode } = useAdminPanel();
  const [settings, setSettings] = useState<NotificationSetting[]>([]);
  const [savedSettings, setSavedSettings] = useState<NotificationSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  // テンプレートライブラリ
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [showLibrary, setShowLibrary] = useState(false);
  const [librarySelectFor, setLibrarySelectFor] = useState<{ eventKey: string; channel: ChannelType } | null>(null);
  const [editingTpl, setEditingTpl] = useState<EmailTemplate | null>(null);
  const [newTpl, setNewTpl] = useState<{ name: string; subject: string; template: string } | null>(null);
  const [tplSaving, setTplSaving] = useState(false);
  const [showVarPanel, setShowVarPanel] = useState(false);

  // プレビュー
  const [previewFor, setPreviewFor] = useState<{ eventKey: string; channel: ChannelType } | null>(null);
  const [previewVars, setPreviewVars] = useState<Record<string, string>>({});

  // テンプレートとして保存
  const [saveAsTplFor, setSaveAsTplFor] = useState<{ eventKey: string; channel: ChannelType } | null>(null);
  const [saveAsTplName, setSaveAsTplName] = useState('');

  const bg = isDarkMode ? '#343a40' : 'white';
  const text = isDarkMode ? '#fff' : '#333';
  const subText = isDarkMode ? '#adb5bd' : '#666';
  const borderColor = isDarkMode ? '#6c757d' : '#ddd';
  const inputBg = isDarkMode ? '#495057' : 'white';
  const sectionBg = isDarkMode ? '#2d3136' : '#f8f9fa';

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('notification_settings').select('*');
    if (data) { setSettings(data); setSavedSettings(data); }
    setLoading(false);
  }, []);

  const fetchTemplates = useCallback(async () => {
    const { data } = await supabase.from('email_templates').select('*').order('created_at', { ascending: false });
    if (data) setTemplates(data);
  }, []);

  useEffect(() => { fetchSettings(); fetchTemplates(); }, [fetchSettings, fetchTemplates]);

  const getSetting = (eventKey: string, channel: ChannelType): NotificationSetting | undefined =>
    settings.find(s => s.event_key === eventKey && s.channel === channel);

  const updateLocal = (eventKey: string, channel: ChannelType, patch: Partial<NotificationSetting>) => {
    setSettings(prev => prev.map(s =>
      s.event_key === eventKey && s.channel === channel ? { ...s, ...patch } : s
    ));
  };

  const handleSaveEvent = async (eventKey: string) => {
    setSaving(eventKey);
    const eventSettings = settings.filter(s => s.event_key === eventKey);
    for (const s of eventSettings) {
      await supabase.from('notification_settings').upsert({
        id: s.id,
        event_key: s.event_key,
        channel: s.channel,
        enabled: s.enabled,
        recipient: s.recipient,
        subject: s.subject,
        template: s.template,
        updated_at: new Date().toISOString(),
      });
    }
    invalidateNotificationCache();
    setSavedSettings(prev => {
      const others = prev.filter(s => s.event_key !== eventKey);
      return [...others, ...settings.filter(s => s.event_key === eventKey)];
    });
    setSaving(null);
    setSavedMsg(eventKey);
    setTimeout(() => setSavedMsg(null), 3000);
  };

  const insertVar = (eventKey: string, channel: ChannelType, field: 'template' | 'subject', variable: string) => {
    const s = getSetting(eventKey, channel);
    if (!s) return;
    const current = (field === 'template' ? s.template : s.subject) ?? '';
    updateLocal(eventKey, channel, { [field]: current + variable });
  };

  const getBadges = (eventKey: string) => {
    const channels: ChannelType[] = ['slack', 'email', 'site'];
    return channels.map(ch => {
      const s = getSetting(eventKey, ch);
      return { channel: ch, enabled: s?.enabled ?? false };
    });
  };

  const channelBadgeStyle = (enabled: boolean, channel: ChannelType): React.CSSProperties => {
    if (!enabled) return {
      fontSize: 11, padding: '2px 8px', borderRadius: 20,
      background: isDarkMode ? '#495057' : '#eee',
      color: isDarkMode ? '#adb5bd' : '#999',
    };
    const colors: Record<ChannelType, { bg: string; color: string }> = {
      slack: { bg: '#E1F5FE', color: '#0277BD' },
      email: { bg: '#E8F5E9', color: '#2E7D32' },
      site:  { bg: '#EDE7F6', color: '#4527A0' },
    };
    return { fontSize: 11, padding: '2px 8px', borderRadius: 20, ...colors[channel] };
  };

  // 現在の設定をテンプレートとして保存
  const handleSaveAsTpl = async () => {
    if (!saveAsTplFor || !saveAsTplName.trim()) return;
    const s = getSetting(saveAsTplFor.eventKey, saveAsTplFor.channel);
    if (!s) return;
    setTplSaving(true);
    await supabase.from('email_templates').insert({ name: saveAsTplName.trim(), subject: s.subject, template: s.template });
    await fetchTemplates();
    setSaveAsTplFor(null);
    setSaveAsTplName('');
    setTplSaving(false);
  };

  // テンプレート保存
  const handleSaveTpl = async (tpl: { name: string; subject: string; template: string }) => {
    if (!tpl.name.trim()) return;
    setTplSaving(true);
    await supabase.from('email_templates').insert({ name: tpl.name, subject: tpl.subject, template: tpl.template });
    await fetchTemplates();
    setNewTpl(null);
    setTplSaving(false);
  };

  const handleUpdateTpl = async () => {
    if (!editingTpl) return;
    setTplSaving(true);
    await supabase.from('email_templates').update({ name: editingTpl.name, subject: editingTpl.subject, template: editingTpl.template }).eq('id', editingTpl.id);
    await fetchTemplates();
    setEditingTpl(null);
    setTplSaving(false);
  };

  const handleDeleteTpl = async (id: string) => {
    if (!confirm('このテンプレートを削除しますか？')) return;
    await supabase.from('email_templates').delete().eq('id', id);
    await fetchTemplates();
  };

  // {{変数}} を抽出
  const extractVars = (text: string): string[] => {
    const matches = text.match(/\{\{(.+?)\}\}/g) ?? [];
    return [...new Set(matches.map(m => m.slice(2, -2).trim()))];
  };

  // テンプレートに変数を適用
  const applyVars = (text: string, vars: Record<string, string>): string =>
    text.replace(/\{\{(.+?)\}\}/g, (_, k) => vars[k.trim()] || `{{${k.trim()}}}`);

  // プレビュー用の変数一覧
  const previewAllVars = previewFor
    ? extractVars((getSetting(previewFor.eventKey, previewFor.channel)?.subject ?? '') + ' ' + (getSetting(previewFor.eventKey, previewFor.channel)?.template ?? ''))
    : [];

  // テンプレートライブラリ モーダル（コンポーネント関数にしない → 再マウント防止）
  const libraryModal = showLibrary ? (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) { setShowLibrary(false); setLibrarySelectFor(null); setNewTpl(null); setEditingTpl(null); } }}>
      <div style={{ background: bg, borderRadius: 12, padding: 24, width: '100%', maxWidth: 560, maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: text }}>
            📋 テンプレートライブラリ{librarySelectFor ? '　（選択して適用）' : ''}
          </span>
          <button onClick={() => { setShowLibrary(false); setLibrarySelectFor(null); setNewTpl(null); setEditingTpl(null); }}
            style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: subText }}>✕</button>
        </div>

        {/* 新規追加フォーム */}
        {newTpl ? (
          <div style={{ background: sectionBg, borderRadius: 8, padding: 14, marginBottom: 12, border: `0.5px solid ${borderColor}` }}>
            <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>テンプレート名</div>
            <input value={newTpl.name} onChange={e => setNewTpl({ ...newTpl, name: e.target.value })}
              placeholder="例：承認依頼 基本文"
              style={{ width: '100%', fontSize: 13, padding: '6px 10px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: inputBg, color: text, boxSizing: 'border-box', marginBottom: 10 }} />
            <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>件名</div>
            <input value={newTpl.subject} onChange={e => setNewTpl({ ...newTpl, subject: e.target.value })}
              placeholder="例：【休暇申請】承認をお願いします"
              style={{ width: '100%', fontSize: 13, padding: '6px 10px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: inputBg, color: text, boxSizing: 'border-box', marginBottom: 6 }} />
            <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>本文</div>
            <textarea value={newTpl.template} onChange={e => setNewTpl({ ...newTpl, template: e.target.value })}
              rows={5} placeholder="{{申請者名}} さんから申請が届いています。"
              style={{ width: '100%', fontSize: 12, padding: '6px 10px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: inputBg, color: text, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'monospace', marginBottom: 8 }} />
            {/* 変数パネル */}
            <button onClick={() => setShowVarPanel(p => !p)}
              style={{ fontSize: 11, padding: '4px 12px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: 'none', color: subText, cursor: 'pointer', marginBottom: showVarPanel ? 6 : 10 }}>
              📝 使える変数一覧 {showVarPanel ? '▲' : '▼'}
            </button>
            {showVarPanel && (
              <div style={{ border: `0.5px solid ${borderColor}`, borderRadius: 8, padding: 10, marginBottom: 10, background: isDarkMode ? '#2d3136' : '#fafafa' }}>
                {TEMPLATE_VAR_GROUPS.map(group => (
                  <div key={group.label} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: group.color, marginBottom: 5, paddingBottom: 3, borderBottom: `1px solid ${borderColor}` }}>
                      {group.label}
                    </div>
                    {group.vars.map(({ v, desc }) => (
                      <div key={v} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, flexWrap: 'wrap' }}>
                        <code style={{ fontSize: 11, background: '#FFF8E1', color: '#F57F17', border: '0.5px solid #FFE082', borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap' }}>{v}</code>
                        <span style={{ fontSize: 11, color: subText, flex: 1, minWidth: 100 }}>{desc}</span>
                        <button onClick={() => setNewTpl({ ...newTpl, subject: newTpl.subject + v })}
                          style={{ fontSize: 10, padding: '2px 8px', border: `0.5px solid ${borderColor}`, borderRadius: 6, background: 'none', color: text, cursor: 'pointer', whiteSpace: 'nowrap' }}>件名へ</button>
                        <button onClick={() => setNewTpl({ ...newTpl, template: newTpl.template + v })}
                          style={{ fontSize: 10, padding: '2px 8px', border: `0.5px solid ${borderColor}`, borderRadius: 6, background: 'none', color: text, cursor: 'pointer', whiteSpace: 'nowrap' }}>本文へ</button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setNewTpl(null)} style={{ fontSize: 12, padding: '5px 14px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: 'none', color: subText, cursor: 'pointer' }}>キャンセル</button>
              <button onClick={() => handleSaveTpl(newTpl)} disabled={tplSaving}
                style={{ fontSize: 12, padding: '5px 14px', border: 'none', borderRadius: 8, background: '#0277BD', color: 'white', cursor: 'pointer', opacity: tplSaving ? 0.6 : 1 }}>
                {tplSaving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setNewTpl({ name: '', subject: '', template: '' })}
            style={{ fontSize: 12, padding: '6px 14px', border: `0.5px solid #0277BD`, borderRadius: 8, background: 'none', color: '#0277BD', cursor: 'pointer', marginBottom: 12 }}>
            ＋ 新規テンプレートを追加
          </button>
        )}

        {/* テンプレート一覧 */}
        {templates.length === 0 && !newTpl && (
          <div style={{ color: subText, fontSize: 13, textAlign: 'center', padding: 24 }}>テンプレートがありません</div>
        )}
        {templates.map(tpl => (
          <div key={tpl.id} style={{ border: `0.5px solid ${borderColor}`, borderRadius: 8, padding: 12, marginBottom: 8, background: sectionBg }}>
            {editingTpl?.id === tpl.id ? (
              <>
                <input value={editingTpl.name} onChange={e => setEditingTpl({ ...editingTpl, name: e.target.value })}
                  style={{ width: '100%', fontSize: 13, padding: '5px 8px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: inputBg, color: text, boxSizing: 'border-box', marginBottom: 8, fontWeight: 600 }} />
                <input value={editingTpl.subject ?? ''} onChange={e => setEditingTpl({ ...editingTpl, subject: e.target.value })}
                  placeholder="件名"
                  style={{ width: '100%', fontSize: 12, padding: '5px 8px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: inputBg, color: text, boxSizing: 'border-box', marginBottom: 4 }} />
                <textarea value={editingTpl.template ?? ''} onChange={e => setEditingTpl({ ...editingTpl, template: e.target.value })}
                  rows={4}
                  style={{ width: '100%', fontSize: 12, padding: '5px 8px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: inputBg, color: text, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'monospace', marginBottom: 8 }} />
                <button onClick={() => setShowVarPanel(p => !p)}
                  style={{ fontSize: 11, padding: '4px 12px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: 'none', color: subText, cursor: 'pointer', marginBottom: showVarPanel ? 6 : 8 }}>
                  📝 使える変数一覧 {showVarPanel ? '▲' : '▼'}
                </button>
                {showVarPanel && (
                  <div style={{ border: `0.5px solid ${borderColor}`, borderRadius: 8, padding: 10, marginBottom: 8, background: isDarkMode ? '#2d3136' : '#fafafa' }}>
                    {TEMPLATE_VAR_GROUPS.map(group => (
                      <div key={group.label} style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: group.color, marginBottom: 5, paddingBottom: 3, borderBottom: `1px solid ${borderColor}` }}>
                          {group.label}
                        </div>
                        {group.vars.map(({ v, desc }) => (
                          <div key={v} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, flexWrap: 'wrap' }}>
                            <code style={{ fontSize: 11, background: '#FFF8E1', color: '#F57F17', border: '0.5px solid #FFE082', borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap' }}>{v}</code>
                            <span style={{ fontSize: 11, color: subText, flex: 1, minWidth: 100 }}>{desc}</span>
                            <button onClick={() => setEditingTpl({ ...editingTpl, subject: (editingTpl.subject ?? '') + v })}
                              style={{ fontSize: 10, padding: '2px 8px', border: `0.5px solid ${borderColor}`, borderRadius: 6, background: 'none', color: text, cursor: 'pointer', whiteSpace: 'nowrap' }}>件名へ</button>
                            <button onClick={() => setEditingTpl({ ...editingTpl, template: (editingTpl.template ?? '') + v })}
                              style={{ fontSize: 10, padding: '2px 8px', border: `0.5px solid ${borderColor}`, borderRadius: 6, background: 'none', color: text, cursor: 'pointer', whiteSpace: 'nowrap' }}>本文へ</button>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button onClick={() => setEditingTpl(null)} style={{ fontSize: 11, padding: '4px 12px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: 'none', color: subText, cursor: 'pointer' }}>キャンセル</button>
                  <button onClick={handleUpdateTpl} disabled={tplSaving}
                    style={{ fontSize: 11, padding: '4px 12px', border: 'none', borderRadius: 8, background: '#0277BD', color: 'white', cursor: 'pointer' }}>保存</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 600, fontSize: 13, color: text, marginBottom: 4 }}>{tpl.name}</div>
                {tpl.subject && <div style={{ fontSize: 11, color: subText, marginBottom: 2 }}>件名: {tpl.subject}</div>}
                {tpl.template && <div style={{ fontSize: 11, color: subText, whiteSpace: 'pre-wrap', maxHeight: 60, overflow: 'hidden', opacity: 0.8 }}>{tpl.template}</div>}
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  {librarySelectFor && (
                    <button onClick={() => {
                      updateLocal(librarySelectFor.eventKey, librarySelectFor.channel, { subject: tpl.subject, template: tpl.template });
                      setShowLibrary(false); setLibrarySelectFor(null);
                    }}
                      style={{ fontSize: 11, padding: '4px 12px', border: 'none', borderRadius: 8, background: '#28a745', color: 'white', cursor: 'pointer' }}>
                      この内容を適用
                    </button>
                  )}
                  <button onClick={() => setEditingTpl(tpl)}
                    style={{ fontSize: 11, padding: '4px 12px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: 'none', color: text, cursor: 'pointer' }}>編集</button>
                  <button onClick={() => handleDeleteTpl(tpl.id)}
                    style={{ fontSize: 11, padding: '4px 12px', border: `0.5px solid #dc3545`, borderRadius: 8, background: 'none', color: '#dc3545', cursor: 'pointer' }}>削除</button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  ) : null;

  // プレビュー モーダル（JSX変数）
  const previewSetting = previewFor ? getSetting(previewFor.eventKey, previewFor.channel) : null;
  const renderedSubject = previewSetting ? applyVars(previewSetting.subject ?? '', previewVars) : '';
  const renderedBody = previewSetting ? applyVars(previewSetting.template ?? '', previewVars) : '';
  const previewModal = previewFor && previewSetting ? (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) { setPreviewFor(null); setPreviewVars({}); } }}>
      <div style={{ background: bg, borderRadius: 12, padding: 24, width: '100%', maxWidth: 520, maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: text }}>👁 プレビュー</span>
          <button onClick={() => { setPreviewFor(null); setPreviewVars({}); }}
            style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: subText }}>✕</button>
        </div>

        {previewAllVars.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: subText, marginBottom: 8 }}>変数にサンプル値を入力（省略可）</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {previewAllVars.map(v => (
                <div key={v} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: '#F57F17', background: '#FFF8E1', border: '0.5px solid #FFE082', borderRadius: 20, padding: '2px 8px', whiteSpace: 'nowrap' }}>{`{{${v}}}`}</span>
                  <input
                    value={previewVars[v] ?? ''}
                    onChange={e => setPreviewVars(prev => ({ ...prev, [v]: e.target.value }))}
                    placeholder={`例：${v}`}
                    style={{ flex: 1, fontSize: 12, padding: '4px 8px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: inputBg, color: text }}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ border: `0.5px solid ${borderColor}`, borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ background: sectionBg, padding: '8px 14px', borderBottom: `0.5px solid ${borderColor}` }}>
            <span style={{ fontSize: 11, color: subText }}>件名　</span>
            <span style={{ fontSize: 13, color: text, fontWeight: 500 }}>{renderedSubject || '（件名なし）'}</span>
          </div>
          <div style={{ padding: 14 }}>
            <span style={{ fontSize: 11, color: subText, display: 'block', marginBottom: 6 }}>本文</span>
            <pre style={{ fontSize: 13, color: text, whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0, lineHeight: 1.7 }}>
              {renderedBody || '（本文なし）'}
            </pre>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  if (loading) return <div style={{ padding: 32, color: subText, textAlign: 'center' }}>読み込み中...</div>;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '16px 0' }}>
      {libraryModal}
      {previewModal}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button onClick={() => { setShowLibrary(true); setLibrarySelectFor(null); }}
          style={{ fontSize: 12, padding: '6px 16px', border: `0.5px solid #0277BD`, borderRadius: 8, background: 'none', color: '#0277BD', cursor: 'pointer' }}>
          📋 テンプレートライブラリ
        </button>
      </div>

      {EVENT_GROUPS.map(group => (
        <div key={group.label} style={{ marginBottom: 24 }}>
          <div style={{
            background: group.headerBg,
            borderLeft: `3px solid ${group.headerBorder}`,
            borderRadius: '0 6px 6px 0',
            padding: '8px 12px',
            fontSize: 13, fontWeight: 500,
            color: group.headerText,
            marginBottom: 8,
          }}>
            {group.icon} {group.label}
          </div>

          {group.events.map(event => {
            const isOpen = openEvent === event.key;
            const badges = getBadges(event.key);
            const isSaving = saving === event.key;
            const isSaved = savedMsg === event.key;
            const isDirty = settings.some(s => {
              if (s.event_key !== event.key) return false;
              const orig = savedSettings.find(o => o.id === s.id);
              if (!orig) return true;
              return s.enabled !== orig.enabled || s.recipient !== orig.recipient ||
                s.subject !== orig.subject || s.template !== orig.template;
            });

            return (
              <div key={event.key} style={{
                background: bg, border: `0.5px solid ${borderColor}`,
                borderRadius: 12, marginBottom: 8, overflow: 'hidden',
              }}>
                <div
                  onClick={() => setOpenEvent(isOpen ? null : event.key)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 16px', cursor: 'pointer',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = isDarkMode ? '#3d4349' : '#f8f9fa')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={{ fontSize: 14, fontWeight: 500, color: text }}>{event.label}</span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {badges.map(b => (
                      <span key={b.channel} style={channelBadgeStyle(b.enabled, b.channel)}>
                        {CHANNEL_ICONS[b.channel]} {b.enabled ? CHANNEL_LABELS[b.channel] : `${CHANNEL_LABELS[b.channel]} OFF`}
                      </span>
                    ))}
                    <span style={{ fontSize: 12, color: subText, marginLeft: 4 }}>{isOpen ? '▲' : '▼'}</span>
                  </div>
                </div>

                {isOpen && (
                  <div style={{ borderTop: `0.5px solid ${borderColor}`, padding: 16, background: sectionBg }}>
                    {(<>{(['slack', 'email', 'site'] as ChannelType[]).map(channel => {
                      if (event.key === 'trip:report_end' && channel === 'slack') {
                        return (
                          <div key={channel} style={{
                            fontSize: 13, color: subText, padding: '10px 14px', marginBottom: 8,
                            background: bg, border: `0.5px solid ${borderColor}`, borderRadius: 8,
                            lineHeight: 1.7,
                          }}>
                            <div>📌 出張報告のSlack通知は、申請者が報告画面でチャンネルを手動選択して送信する仕組みです。</div>
                            <div style={{ marginTop: 4 }}>通知設定画面からのON/OFF制御は対象外となります。</div>
                          </div>
                        );
                      }

                      // 時間調整: Slackチャンネル複数選択UI
                      if (event.key === 'time_adjustment:registered' && channel === 'slack') {
                        const s = getSetting(event.key, channel);
                        if (!s) return null;
                        const selectedChannels = parseSlackChannels(s.recipient);
                        return (
                          <div key={channel} style={{ background: bg, border: `0.5px solid ${borderColor}`, borderRadius: 8, padding: '12px 14px', marginBottom: 8 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: s.enabled ? 12 : 0 }}>
                              <span style={{ fontSize: 14 }}>💬</span>
                              <span style={{ fontSize: 13, fontWeight: 500, color: text, flex: 1 }}>Slack</span>
                              <div onClick={() => updateLocal(event.key, channel, { enabled: !s.enabled })} style={{
                                width: 36, height: 20, borderRadius: 10, cursor: 'pointer',
                                background: s.enabled ? '#29B6F6' : (isDarkMode ? '#6c757d' : '#ccc'),
                                position: 'relative', flexShrink: 0, transition: 'background 0.15s',
                              }}>
                                <div style={{ width: 16, height: 16, borderRadius: '50%', background: 'white', position: 'absolute', top: 2, transition: 'left 0.15s', left: s.enabled ? 18 : 2 }} />
                              </div>
                            </div>
                            {s.enabled && (
                              <div style={{ borderTop: `0.5px solid ${borderColor}`, paddingTop: 10 }}>
                                <div style={{ fontSize: 12, color: subText, marginBottom: 8 }}>送信先チャンネル（複数選択可）</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                  {TIME_ADJ_SLACK_OPTIONS.map(opt => (
                                    <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', color: text }}>
                                      <input
                                        type="checkbox"
                                        checked={selectedChannels.includes(opt.value)}
                                        onChange={e => {
                                          const newCh = e.target.checked
                                            ? [...selectedChannels, opt.value]
                                            : selectedChannels.filter(c => c !== opt.value);
                                          updateLocal(event.key, channel, { recipient: JSON.stringify({ channels: newCh }) });
                                        }}
                                      />
                                      {opt.label}
                                    </label>
                                  ))}
                                </div>
                                <div style={{ fontSize: 11, color: subText, marginTop: 10 }}>※ メッセージはシステムで自動生成されます</div>
                              </div>
                            )}
                          </div>
                        );
                      }

                      const s = getSetting(event.key, channel);
                      if (!s) return null;
                      const vars = VARIABLES_BY_EVENT[event.key] ?? [];

                      return (
                        <div key={channel} style={{
                          background: bg, border: `0.5px solid ${borderColor}`,
                          borderRadius: 8, padding: '12px 14px', marginBottom: 8,
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: s.enabled ? 12 : 0 }}>
                            <span style={{ fontSize: 14 }}>{CHANNEL_ICONS[channel]}</span>
                            <span style={{ fontSize: 13, fontWeight: 500, color: text, flex: 1 }}>
                              {CHANNEL_LABELS[channel]}
                            </span>
                            <div
                              onClick={() => updateLocal(event.key, channel, { enabled: !s.enabled })}
                              style={{
                                width: 36, height: 20, borderRadius: 10, cursor: 'pointer',
                                background: s.enabled ? '#29B6F6' : (isDarkMode ? '#6c757d' : '#ccc'),
                                position: 'relative', flexShrink: 0, transition: 'background 0.15s',
                              }}
                            >
                              <div style={{
                                width: 16, height: 16, borderRadius: '50%', background: 'white',
                                position: 'absolute', top: 2, transition: 'left 0.15s',
                                left: s.enabled ? 18 : 2,
                              }} />
                            </div>
                          </div>

                          {s.enabled && (
                            <div style={{ borderTop: `0.5px solid ${borderColor}`, paddingTop: 10 }}>
                              <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>
                                {channel === 'slack' ? '送信先チャンネル' : '宛先'}
                              </div>
                              {channel === 'slack' && event.key === 'leave:new_request' ? (
                                <div style={{
                                  fontSize: 12, padding: '6px 10px', marginBottom: 10,
                                  border: `0.5px solid ${borderColor}`, borderRadius: 8,
                                  background: sectionBg, color: subText,
                                }}>
                                  <div>申請先がリーダーの場合 → <strong style={{ color: text }}>#01リーダー回覧</strong></div>
                                  <div style={{ marginTop: 4 }}>申請先がマネージャーの場合 → <strong style={{ color: text }}>#01マネージャー回覧</strong></div>
                                  <div style={{ marginTop: 6, fontSize: 11, color: subText }}>※ 申請先の役職に応じて自動で振り分けられます</div>
                                </div>
                              ) : event.key === 'time_adjustment:registered' && channel !== 'slack' ? (
                                // 時間調整: 役職チェックボックス + グループ絞り込み
                                (() => {
                                  const { roles, groupFilter } = parseRoleRecipient(s.recipient);
                                  const updateRoleRecipient = (newRoles: string[], newFilter: string) =>
                                    updateLocal(event.key, channel, { recipient: JSON.stringify({ roles: newRoles, groupFilter: newFilter }) });
                                  return (
                                    <div style={{ marginBottom: 12 }}>
                                      <div style={{ fontSize: 12, color: subText, marginBottom: 8 }}>通知先の役職（複数選択可）</div>
                                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
                                        {TIME_ADJ_ROLE_OPTIONS.map(role => (
                                          <label key={role} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: text }}>
                                            <input
                                              type="checkbox"
                                              checked={roles.includes(role)}
                                              onChange={e => {
                                                const newRoles = e.target.checked
                                                  ? [...roles, role]
                                                  : roles.filter(r => r !== role);
                                                updateRoleRecipient(newRoles, groupFilter);
                                              }}
                                            />
                                            {role}
                                          </label>
                                        ))}
                                      </div>
                                      <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>グループ絞り込み</div>
                                      <div style={{ display: 'flex', gap: 16 }}>
                                        {[
                                          { value: 'same', label: '同グループのみ' },
                                          { value: 'all',  label: 'グループに関係なく全員' },
                                        ].map(opt => (
                                          <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: text }}>
                                            <input
                                              type="radio"
                                              name={`groupFilter_${event.key}_${channel}`}
                                              value={opt.value}
                                              checked={groupFilter === opt.value}
                                              onChange={() => updateRoleRecipient(roles, opt.value)}
                                            />
                                            {opt.label}
                                          </label>
                                        ))}
                                      </div>
                                    </div>
                                  );
                                })()
                              ) : channel === 'slack' ? (
                                // Slack: チャンネルチェックボックス（複数選択）
                                (() => {
                                  const slackOptions = SLACK_CHANNEL_OPTIONS_BY_EVENT[event.key] ?? [];
                                  const selectedChannels = parseSlackChannels(s.recipient);
                                  return (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                                      {slackOptions.map(opt => (
                                        <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', color: text }}>
                                          <input
                                            type="checkbox"
                                            checked={selectedChannels.includes(opt.value)}
                                            onChange={e => {
                                              const newCh = e.target.checked
                                                ? [...selectedChannels, opt.value]
                                                : selectedChannels.filter(c => c !== opt.value);
                                              updateLocal(event.key, channel, { recipient: JSON.stringify({ channels: newCh }) });
                                            }}
                                          />
                                          {opt.label}
                                        </label>
                                      ))}
                                    </div>
                                  );
                                })()
                              ) : (
                                // メール・サイト通知: 宛先チェックボックス（複数選択）
                                (() => {
                                  const recipientOptions = RECIPIENT_OPTIONS[channel] ?? [];
                                  const selectedRecipients = parseEmailSiteRecipients(s.recipient);
                                  return (
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
                                      {recipientOptions.map(opt => (
                                        <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: text }}>
                                          <input
                                            type="checkbox"
                                            checked={selectedRecipients.includes(opt.value)}
                                            onChange={e => {
                                              const newRecs = e.target.checked
                                                ? [...selectedRecipients, opt.value]
                                                : selectedRecipients.filter(r => r !== opt.value);
                                              updateLocal(event.key, channel, { recipient: JSON.stringify({ recipients: newRecs }) });
                                            }}
                                          />
                                          {opt.label}
                                        </label>
                                      ))}
                                    </div>
                                  );
                                })()
                              )}

                              {channel !== 'slack' && (
                                <>
                                  {channel === 'email' && (
                                    <>
                                      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                                        <button onClick={() => { setShowLibrary(true); setLibrarySelectFor({ eventKey: event.key, channel }); }}
                                          style={{ fontSize: 11, padding: '4px 12px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: 'none', color: text, cursor: 'pointer' }}>
                                          📋 テンプレートから選択
                                        </button>
                                        <button onClick={() => { setPreviewFor({ eventKey: event.key, channel }); setPreviewVars({}); }}
                                          style={{ fontSize: 11, padding: '4px 12px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: 'none', color: text, cursor: 'pointer' }}>
                                          👁 プレビュー
                                        </button>
                                        <button onClick={() => { setSaveAsTplFor({ eventKey: event.key, channel }); setSaveAsTplName(''); }}
                                          style={{ fontSize: 11, padding: '4px 12px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: 'none', color: text, cursor: 'pointer' }}>
                                          💾 テンプレートとして保存
                                        </button>
                                      </div>
                                      {saveAsTplFor?.eventKey === event.key && saveAsTplFor?.channel === channel && (
                                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, padding: '8px 10px', background: sectionBg, borderRadius: 8, border: `0.5px solid ${borderColor}` }}>
                                          <input
                                            value={saveAsTplName}
                                            onChange={e => setSaveAsTplName(e.target.value)}
                                            placeholder="テンプレート名を入力（例：承認依頼 基本文）"
                                            autoFocus
                                            onKeyDown={e => { if (e.key === 'Enter') handleSaveAsTpl(); if (e.key === 'Escape') setSaveAsTplFor(null); }}
                                            style={{ flex: 1, fontSize: 12, padding: '5px 8px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: inputBg, color: text }}
                                          />
                                          <button onClick={handleSaveAsTpl} disabled={tplSaving || !saveAsTplName.trim()}
                                            style={{ fontSize: 11, padding: '5px 12px', border: 'none', borderRadius: 8, background: saveAsTplName.trim() ? '#0277BD' : '#ccc', color: 'white', cursor: saveAsTplName.trim() ? 'pointer' : 'default' }}>
                                            {tplSaving ? '保存中...' : '保存'}
                                          </button>
                                          <button onClick={() => setSaveAsTplFor(null)}
                                            style={{ fontSize: 11, padding: '5px 10px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: 'none', color: subText, cursor: 'pointer' }}>✕</button>
                                        </div>
                                      )}
                                      <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>件名</div>
                                      <input
                                        value={s.subject ?? ''}
                                        onChange={e => updateLocal(event.key, channel, { subject: e.target.value })}
                                        style={{
                                          fontSize: 12, padding: '6px 10px', width: '100%', marginBottom: 10,
                                          border: `0.5px solid ${borderColor}`, borderRadius: 8,
                                          background: inputBg, color: text, boxSizing: 'border-box',
                                        }}
                                      />
                                    </>
                                  )}
                                  <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>本文</div>
                                  <textarea
                                    value={s.template ?? ''}
                                    onChange={e => updateLocal(event.key, channel, { template: e.target.value })}
                                    rows={7}
                                    style={{
                                      fontSize: 12, padding: '6px 10px', width: '100%', marginBottom: 6,
                                      border: `0.5px solid ${borderColor}`, borderRadius: 8,
                                      background: inputBg, color: text, boxSizing: 'border-box',
                                      resize: 'vertical', fontFamily: 'monospace',
                                    }}
                                  />
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
                                    <span style={{ fontSize: 11, color: subText, alignSelf: 'center' }}>変数：</span>
                                    {vars.map(v => (
                                      <span
                                        key={v}
                                        onClick={() => insertVar(event.key, channel, 'template', v)}
                                        style={{
                                          fontSize: 11, padding: '2px 7px', borderRadius: 20, cursor: 'pointer',
                                          background: '#FFF8E1', color: '#F57F17', border: '0.5px solid #FFE082',
                                        }}
                                        title="クリックで末尾に挿入"
                                      >
                                        {v}
                                      </span>
                                    ))}
                                  </div>
                                </>
                              )}
                              {channel === 'slack' && (
                                <div style={{ fontSize: 11, color: subText, padding: '6px 0' }}>
                                  ※ Slackのメッセージ内容はシステムで自動生成されます
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                      {isSaved && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginRight: 8, background: '#28a745', color: 'white', borderRadius: 8, padding: '4px 10px', fontSize: 12 }}>
                          <span>✓ 保存しました</span>
                        </div>
                      )}
                      <button
                        onClick={() => handleSaveEvent(event.key)}
                        disabled={isSaving}
                        style={{
                          fontSize: 13, padding: '6px 20px',
                          border: 'none', borderRadius: 8,
                          background: isDirty ? '#0277BD' : (isDarkMode ? '#495057' : '#ccc'),
                          color: isDirty ? '#fff' : (isDarkMode ? '#adb5bd' : '#888'),
                          cursor: isDirty ? 'pointer' : 'default',
                          opacity: isSaving ? 0.6 : 1,
                        }}
                      >
                        {isSaving ? '保存中...' : '保存'}
                      </button>
                    </div>
                  </>)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};

// ── 定期リマインド設定 ─────────────────────────────────────────────
interface ScheduledReminder {
  id: string;
  channel_id: string | null;
  day_of_month: number;
  title: string;
  body: string;
  is_active: boolean;
}

interface BoardChannel {
  id: string;
  name: string;
}

export const ScheduledRemindersPanel: React.FC = () => {
  const { isDarkMode } = useAdminPanel();
  const [reminders, setReminders] = useState<ScheduledReminder[]>([]);
  const [channels, setChannels] = useState<BoardChannel[]>([]);
  const [form, setForm] = useState({ channel_id: '', day_of_month: 1, title: '', body: '' });
  const [saving, setSaving] = useState(false);

  const bg = isDarkMode ? '#2c2c3e' : '#fff';
  const text = isDarkMode ? '#fff' : '#1a1a2e';
  const sub = isDarkMode ? '#adb5bd' : '#6c757d';
  const border = isDarkMode ? '#3d3d55' : '#dee2e6';
  const inputBg = isDarkMode ? '#3d3d55' : '#f8f9fa';

  const fetch = useCallback(async () => {
    const [{ data: r }, { data: c }] = await Promise.all([
      supabase.from('board_scheduled_reminders').select('*').order('day_of_month'),
      supabase.from('board_channels').select('id, name').order('name'),
    ]);
    if (r) setReminders(r);
    if (c) setChannels(c);
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  const handleSave = async () => {
    if (!form.title.trim() || !form.body.trim()) return;
    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('board_scheduled_reminders').insert({
      created_by: user!.id,
      channel_id: form.channel_id || null,
      day_of_month: form.day_of_month,
      title: form.title.trim(),
      body: form.body.trim(),
    });
    setForm({ channel_id: '', day_of_month: 1, title: '', body: '' });
    await fetch();
    setSaving(false);
  };

  const handleToggle = async (id: string, is_active: boolean) => {
    await supabase.from('board_scheduled_reminders').update({ is_active }).eq('id', id);
    setReminders(prev => prev.map(r => r.id === id ? { ...r, is_active } : r));
  };

  const handleDelete = async (id: string) => {
    await supabase.from('board_scheduled_reminders').delete().eq('id', id);
    setReminders(prev => prev.filter(r => r.id !== id));
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 8,
    border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 14,
    boxSizing: 'border-box',
  };

  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ color: text, margin: '0 0 16px', fontSize: 16 }}>📅 定期リマインド設定</h3>

      {/* 新規追加フォーム */}
      <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: 12, padding: 16, marginBottom: 20 }}>
        <p style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 'bold', color: text }}>新しいリマインドを追加</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <p style={{ margin: '0 0 4px', fontSize: 12, color: sub }}>毎月◯日</p>
              <input type="number" min={1} max={31} value={form.day_of_month}
                onChange={e => setForm(f => ({ ...f, day_of_month: Number(e.target.value) }))}
                style={{ ...inputStyle, width: 80 }} />
            </div>
            <div style={{ flex: 2 }}>
              <p style={{ margin: '0 0 4px', fontSize: 12, color: sub }}>送り先グループ（空欄＝全員）</p>
              <select value={form.channel_id} onChange={e => setForm(f => ({ ...f, channel_id: e.target.value }))}
                style={inputStyle}>
                <option value="">全スタッフ</option>
                {channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <p style={{ margin: '0 0 4px', fontSize: 12, color: sub }}>通知タイトル</p>
            <input type="text" value={form.title} placeholder="例: 月目標を提出してください"
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))} style={inputStyle} />
          </div>
          <div>
            <p style={{ margin: '0 0 4px', fontSize: 12, color: sub }}>通知本文</p>
            <textarea value={form.body} rows={2} placeholder="例: 今月の目標をシートに入力してください。"
              onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
          <button onClick={handleSave} disabled={saving || !form.title.trim() || !form.body.trim()}
            style={{ padding: '10px 0', background: saving ? '#6c757d' : '#007bff', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 'bold', opacity: !form.title.trim() || !form.body.trim() ? 0.5 : 1 }}>
            {saving ? '保存中...' : '追加する'}
          </button>
        </div>
      </div>

      {/* 登録済み一覧 */}
      {reminders.length === 0 ? (
        <p style={{ color: sub, fontSize: 13, textAlign: 'center' }}>定期リマインドはまだ登録されていません</p>
      ) : reminders.map(r => (
        <div key={r.id} style={{ background: bg, border: `1px solid ${border}`, borderRadius: 12, padding: 14, marginBottom: 10, opacity: r.is_active ? 1 : 0.5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <p style={{ margin: '0 0 2px', fontSize: 14, fontWeight: 'bold', color: text }}>
                毎月{r.day_of_month}日 — {r.title}
              </p>
              <p style={{ margin: '0 0 4px', fontSize: 12, color: sub }}>{r.body}</p>
              <p style={{ margin: 0, fontSize: 11, color: sub }}>
                送り先: {r.channel_id ? (channels.find(c => c.id === r.channel_id)?.name ?? 'グループ') : '全スタッフ'}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button onClick={() => handleToggle(r.id, !r.is_active)}
                style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${border}`, background: 'none', color: r.is_active ? '#28a745' : sub, cursor: 'pointer', fontSize: 12 }}>
                {r.is_active ? 'ON' : 'OFF'}
              </button>
              <button onClick={() => handleDelete(r.id)}
                style={{ padding: '4px 8px', borderRadius: 6, border: 'none', background: '#dc3545', color: '#fff', cursor: 'pointer', fontSize: 12 }}>
                削除
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default NotificationsTab;
