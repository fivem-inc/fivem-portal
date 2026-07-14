import React, { useState, useEffect } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { supabase } from '../../lib/supabaseClient';
import {
  PUSH_BANNER_CONFIG_KEY,
  DEFAULT_PUSH_BANNER_MESSAGE,
  DEFAULT_PUSH_BANNER_TITLE,
  DEFAULT_PUSH_BANNER_ENABLE_LABEL,
  DEFAULT_PUSH_BANNER_LATER_LABEL,
  DEFAULT_PUSH_BANNER_CONFIG,
  fetchPushBannerConfig,
  type PushBannerConfig,
} from '../../lib/pushBannerConfig';

// 通知設定タブの先頭に置く「プッシュ通知ONの案内バナー」の設定セクション。
// バナー本体（App.tsxのPushEnableBanner）はこの設定を読んでから表示判断する
const PushBannerSettingsSection: React.FC = () => {
  const { isDarkMode } = useAdminPanel();
  const [config, setConfig] = useState<PushBannerConfig>(DEFAULT_PUSH_BANNER_CONFIG);
  const [savedConfig, setSavedConfig] = useState<PushBannerConfig>(DEFAULT_PUSH_BANNER_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const bg = isDarkMode ? '#343a40' : 'white';
  const text = isDarkMode ? '#fff' : '#333';
  const subText = isDarkMode ? '#adb5bd' : '#666';
  const borderColor = isDarkMode ? '#6c757d' : '#ddd';
  const inputBg = isDarkMode ? '#495057' : 'white';

  useEffect(() => {
    fetchPushBannerConfig().then(c => {
      setConfig(c);
      setSavedConfig(c);
      setLoading(false);
    });
  }, []);

  const isDirty = config.enabled !== savedConfig.enabled
    || config.title !== savedConfig.title
    || config.message !== savedConfig.message
    || config.enableLabel !== savedConfig.enableLabel
    || config.laterLabel !== savedConfig.laterLabel
    || config.redisplayDays !== savedConfig.redisplayDays;

  const handleSave = async () => {
    setSaving(true);
    const value: PushBannerConfig = {
      enabled: config.enabled,
      title: config.title.trim(),
      message: config.message.trim(),
      enableLabel: config.enableLabel.trim(),
      laterLabel: config.laterLabel.trim(),
      redisplayDays: Number.isFinite(config.redisplayDays) && config.redisplayDays >= 1
        ? Math.floor(config.redisplayDays)
        : DEFAULT_PUSH_BANNER_CONFIG.redisplayDays,
    };
    const { error } = await supabase.from('app_settings')
      .upsert({ key: PUSH_BANNER_CONFIG_KEY, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    setSaving(false);
    if (error) return;
    setConfig(value);
    setSavedConfig(value);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        background: '#FFF3E0',
        borderLeft: '3px solid #E65100',
        borderRadius: '0 6px 6px 0',
        padding: '8px 12px',
        fontSize: 13, fontWeight: 500,
        color: '#BF360C',
        marginBottom: 8,
      }}>
        📱 プッシュ通知ONの案内バナー
      </div>

      <div style={{ background: bg, border: `0.5px solid ${borderColor}`, borderRadius: 12, padding: '14px 16px' }}>
        <div style={{ fontSize: 12, color: subText, lineHeight: 1.7, marginBottom: 12 }}>
          プッシュ通知をまだONにしていない人のホーム画面に表示される案内バナーの設定です。<br />
          Android等はその場で押せる「許可する」ボタン、iPhoneはホーム画面追加の手順（固定文・編集不可）が表示されます。
        </div>

        {loading ? (
          <div style={{ fontSize: 13, color: subText, padding: '8px 0' }}>読み込み中...</div>
        ) : (
          <>
            {/* 表示ON/OFF */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 14 }}>
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={e => setConfig(prev => ({ ...prev, enabled: e.target.checked }))}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
              <span style={{ fontSize: 13, fontWeight: 600, color: text }}>バナーを表示する</span>
              {!config.enabled && (
                <span style={{ fontSize: 11, color: '#dc3545' }}>OFF（全員に非表示になります）</span>
              )}
            </label>

            {/* タイトル */}
            <div style={{ marginBottom: 14, opacity: config.enabled ? 1 : 0.5 }}>
              <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>
                タイトル（空欄の場合は「{DEFAULT_PUSH_BANNER_TITLE}」が表示されます）
              </div>
              <input
                type="text"
                value={config.title}
                onChange={e => setConfig(prev => ({ ...prev, title: e.target.value }))}
                placeholder={DEFAULT_PUSH_BANNER_TITLE}
                disabled={!config.enabled}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '8px 10px',
                  border: `0.5px solid ${borderColor}`, borderRadius: 8,
                  background: inputBg, color: text, fontSize: 13,
                }}
              />
            </div>

            {/* 案内文 */}
            <div style={{ marginBottom: 14, opacity: config.enabled ? 1 : 0.5 }}>
              <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>
                案内文（Android等向けの説明文。空欄の場合は初期文が表示されます）
              </div>
              <textarea
                value={config.message}
                onChange={e => setConfig(prev => ({ ...prev, message: e.target.value }))}
                placeholder={DEFAULT_PUSH_BANNER_MESSAGE}
                rows={2}
                disabled={!config.enabled}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '8px 10px',
                  border: `0.5px solid ${borderColor}`, borderRadius: 8,
                  background: inputBg, color: text, fontSize: 13, lineHeight: 1.6,
                  resize: 'vertical', fontFamily: 'inherit',
                }}
              />
            </div>

            {/* ボタンの文言 */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 14, opacity: config.enabled ? 1 : 0.5, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>
                  「ON」ボタンの文言（空欄なら「{DEFAULT_PUSH_BANNER_ENABLE_LABEL}」）
                </div>
                <input
                  type="text"
                  value={config.enableLabel}
                  onChange={e => setConfig(prev => ({ ...prev, enableLabel: e.target.value }))}
                  placeholder={DEFAULT_PUSH_BANNER_ENABLE_LABEL}
                  disabled={!config.enabled}
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: '8px 10px',
                    border: `0.5px solid ${borderColor}`, borderRadius: 8,
                    background: inputBg, color: text, fontSize: 13,
                  }}
                />
              </div>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>
                  「後で」ボタンの文言（空欄なら「{DEFAULT_PUSH_BANNER_LATER_LABEL}」）
                </div>
                <input
                  type="text"
                  value={config.laterLabel}
                  onChange={e => setConfig(prev => ({ ...prev, laterLabel: e.target.value }))}
                  placeholder={DEFAULT_PUSH_BANNER_LATER_LABEL}
                  disabled={!config.enabled}
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: '8px 10px',
                    border: `0.5px solid ${borderColor}`, borderRadius: 8,
                    background: inputBg, color: text, fontSize: 13,
                  }}
                />
              </div>
            </div>

            {/* イメージ（スタッフ画面での実際の見え方）プレビュー */}
            <div style={{ marginBottom: 14 }}>
              <button type="button" onClick={() => setShowPreview(v => !v)}
                style={{ fontSize: 12, padding: '5px 14px', border: `0.5px solid ${borderColor}`, borderRadius: 8, background: 'none', color: text, cursor: 'pointer' }}>
                {showPreview ? 'イメージを閉じる' : '📱 イメージを見る'}
              </button>
              {showPreview && (
                <div style={{ marginTop: 10, background: isDarkMode ? '#2d3136' : '#f4f6f4', borderRadius: 10, padding: 14 }}>
                  <div style={{ fontSize: 11, color: subText, marginBottom: 8 }}>スタッフのホーム画面に、こう表示されます（Android等の例）</div>
                  <div style={{ background: '#eef7ee', border: '1px solid #b7e0b7', borderRadius: 10, padding: '12px 14px', maxWidth: 360 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                      <span style={{ fontSize: 20, flexShrink: 0 }}>🔔</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 'bold', color: '#1b5e20', marginBottom: 2 }}>{config.title.trim() || DEFAULT_PUSH_BANNER_TITLE}</div>
                        <div style={{ fontSize: 12.5, color: '#33691e', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{config.message.trim() || DEFAULT_PUSH_BANNER_MESSAGE}</div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                          <span style={{ padding: '7px 18px', borderRadius: 20, background: '#4CAF50', color: '#fff', fontSize: 13, fontWeight: 600 }}>{config.enableLabel.trim() || DEFAULT_PUSH_BANNER_ENABLE_LABEL}</span>
                          <span style={{ padding: '7px 16px', borderRadius: 20, border: '1px solid #b7e0b7', color: '#558b2f', fontSize: 13 }}>{config.laterLabel.trim() || DEFAULT_PUSH_BANNER_LATER_LABEL}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: subText, marginTop: 8 }}>※iPhone（ホーム画面に未追加）では、代わりにホーム画面追加の手順が表示されます。</div>
                </div>
              )}
            </div>

            {/* 「後で」の再表示間隔 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, opacity: config.enabled ? 1 : 0.5 }}>
              <span style={{ fontSize: 12, color: subText }}>「後で」を押した人に再表示するまでの間隔：</span>
              <input
                type="number"
                min={1}
                max={365}
                value={config.redisplayDays}
                onChange={e => setConfig(prev => ({ ...prev, redisplayDays: Number(e.target.value) }))}
                disabled={!config.enabled}
                style={{
                  width: 64, padding: '6px 8px', textAlign: 'center',
                  border: `0.5px solid ${borderColor}`, borderRadius: 8,
                  background: inputBg, color: text, fontSize: 13,
                }}
              />
              <span style={{ fontSize: 12, color: subText }}>日後</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={handleSave}
                disabled={saving || !isDirty}
                style={{
                  padding: '7px 22px', borderRadius: 8, border: 'none',
                  background: isDirty ? '#007bff' : (isDarkMode ? '#495057' : '#ccc'),
                  color: '#fff', fontSize: 13, fontWeight: 'bold',
                  cursor: saving || !isDirty ? 'default' : 'pointer',
                }}>
                {saving ? '保存中...' : '保存'}
              </button>
              {saved && <span style={{ fontSize: 12, color: '#28a745', fontWeight: 600 }}>✓ 保存しました</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default PushBannerSettingsSection;
