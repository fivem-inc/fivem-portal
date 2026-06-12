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
  'leave:new_request':      ['{{承認者名}}', '{{承認者役職}}'],
  'leave:leader_approved':  ['{{承認者名}}', '{{承認者役職}}', '{{次承認者名}}'],
  'leave:manager_approved': ['{{承認者名}}', '{{休暇種別}}'],
  'leave:rejected':         ['{{申請者名}}', '{{休暇種別}}', '{{差し戻し理由}}'],
  'leave:cancelled':        ['{{申請者名}}', '{{休暇種別}}', '{{取り消し理由}}'],
  'expense:new_request':    ['{{申請者名}}', '{{申請日}}', '{{申請内容}}', '{{項目数}}'],
  'trip:report_end':        ['{{申請者名}}', '{{申請日}}'],
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

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

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
    setTimeout(() => setSavedMsg(null), 2000);
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

  if (loading) return <div style={{ padding: 32, color: subText, textAlign: 'center' }}>読み込み中...</div>;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '16px 0' }}>
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
                              ) : (
                                <select
                                  value={s.recipient ?? ''}
                                  onChange={e => updateLocal(event.key, channel, { recipient: e.target.value })}
                                  style={{
                                    fontSize: 12, padding: '4px 8px', width: '100%', marginBottom: 10,
                                    border: `0.5px solid ${borderColor}`, borderRadius: 8,
                                    background: inputBg, color: text, boxSizing: 'border-box',
                                  }}
                                >
                                  {(channel === 'slack'
                                    ? (SLACK_CHANNEL_OPTIONS_BY_EVENT[event.key] ?? [])
                                    : (RECIPIENT_OPTIONS[channel] ?? [])
                                  ).map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                  ))}
                                </select>
                              )}

                              {channel !== 'slack' && (
                                <>
                                  {channel === 'email' && (
                                    <>
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
                        <span style={{ fontSize: 12, color: '#2E7D32', marginRight: 12, alignSelf: 'center' }}>
                          ✓ 保存しました
                        </span>
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

export default NotificationsTab;
