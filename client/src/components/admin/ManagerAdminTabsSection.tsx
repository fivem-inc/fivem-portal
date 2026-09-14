import React, { useEffect, useState } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { supabase } from '../../lib/supabaseClient';
import {
  MANAGER_ADMIN_TABS_SETTING_KEY, MANAGER_TAB_INFO, MANAGER_TAB_KEYS, normalizeManagerTabs,
  type ManagerTabKey,
} from '../../lib/adminTabs';
import { refreshManagerAdminTabs } from '../../hooks/useAdminAccess';

// マネージャー以上に開く管理画面のタブ（2026-09-15）。置き場所は「権限管理」タブの末尾。
// 設計・決めたことは docs/計画-管理画面の開放.md。
//
// 🚨 ここで開いたタブは、DB の書き込みの許可も同じ設定で広がる（can_manage_admin_tab）。
//    外せば DB の書き込みも止まる（安否・緊急だけは例外で、もともとマネージャー以上ができる）
// 🚨 「パソコンだけ」は画面の決まり。DB は端末を見分けられない
// 🚨 お知らせは全員に通知・メールを送れるようになるので、開くときだけ二段階で確かめる

const ManagerAdminTabsSection: React.FC = () => {
  const { isDarkMode } = useAdminPanel();
  const [tabs, setTabs] = useState<ManagerTabKey[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmTab, setConfirmTab] = useState<ManagerTabKey | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const bg = isDarkMode ? '#343a40' : 'white';
  const text = isDarkMode ? '#fff' : '#333';
  const subText = isDarkMode ? '#adb5bd' : '#666';
  const borderColor = isDarkMode ? '#6c757d' : '#ddd';
  const chip = (on: boolean): React.CSSProperties => ({
    padding: '6px 14px', borderRadius: 14, fontSize: 12.5, fontWeight: 'bold', cursor: saving ? 'default' : 'pointer',
    border: `1px solid ${on ? '#4a90d9' : borderColor}`,
    background: on ? '#e8f4fd' : 'transparent',
    color: on ? '#1565c0' : subText,
    flexShrink: 0,
  });

  useEffect(() => {
    let alive = true;
    supabase.from('app_settings').select('value').eq('key', MANAGER_ADMIN_TABS_SETTING_KEY).maybeSingle().then(
      ({ data, error }) => {
        if (!alive) return;
        // 🚨 読めなかったときは「全部オフ」と決めつけない（そのまま保存すると、開いていたタブを全部閉じてしまう）
        if (error) { setErr('設定を読み込めませんでした。画面を開き直してください'); return; }
        setTabs(normalizeManagerTabs(data?.value ?? []));
      },
      () => { if (alive) setErr('設定を読み込めませんでした。画面を開き直してください'); },
    );
    return () => { alive = false; };
  }, []);

  const save = async (next: ManagerTabKey[]) => {
    if (saving) return;
    setSaving(true); setErr(''); setMsg('');
    const value = normalizeManagerTabs(next);
    // 🚨 upsert は 0件でもエラーにならない。select で件数を見る
    const { data, error } = await supabase
      .from('app_settings')
      .upsert({ key: MANAGER_ADMIN_TABS_SETTING_KEY, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
      .select('key');
    setSaving(false);
    if (error) { setErr('保存できませんでした：' + error.message); return; }
    if (!data || data.length === 0) { setErr('保存できませんでした（権限がない可能性があります）'); return; }
    setTabs(value);
    setConfirmTab(null);
    void refreshManagerAdminTabs();
    setMsg('✓ 保存しました');
    setTimeout(() => setMsg(''), 3000);
  };

  const toggle = (key: ManagerTabKey) => {
    if (!tabs || saving) return;
    if (tabs.includes(key)) { void save(tabs.filter(k => k !== key)); return; }
    if (MANAGER_TAB_INFO[key].broadcast) { setConfirmTab(key); return; }
    void save([...tabs, key]);
  };

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{
        background: '#E3F2FD', borderLeft: '3px solid #1565C0', borderRadius: '0 6px 6px 0',
        padding: '8px 12px', fontSize: 13, fontWeight: 500, color: '#0D47A1', marginBottom: 8,
      }}>
        マネージャー以上に開く管理画面のタブ
      </div>

      <div style={{ background: bg, border: `0.5px solid ${borderColor}`, borderRadius: 12, padding: '14px 16px' }}>
        <div style={{ fontSize: 12, color: subText, lineHeight: 1.7, marginBottom: 12 }}>
          選んだタブがあると、マネージャー以上の方が<b style={{ color: text }}>パソコンでログインしたときだけ</b>「⚙️ 管理」が出て、そのタブだけを開けます。
          スマホ・タブレットには出ません。はじめはすべてオフです。<br />
          外すと、開いている画面からも30秒ほどで消え、DB の書き込みも止まります。
          ただし「パソコンだけ」は画面の決まりで、DB は端末を見分けられません。
        </div>

        {err && (
          <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, fontSize: 12,
            background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029' }}>{err}</div>
        )}

        {tabs && MANAGER_TAB_KEYS.map(key => {
          const info = MANAGER_TAB_INFO[key];
          const on = tabs.includes(key);
          return (
            <div key={key} style={{ padding: '10px 0', borderTop: `0.5px solid ${borderColor}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, fontWeight: 'bold', color: text, minWidth: 140 }}>{info.label}</span>
                <button type="button" disabled={saving} onClick={() => toggle(key)} style={chip(on)}>
                  {on ? '開いている' : '閉じている'}
                </button>
              </div>
              <div style={{ fontSize: 12, color: text, lineHeight: 1.6, marginTop: 6 }}>できること：{info.canDo}</div>
              <div style={{ fontSize: 11.5, color: subText, lineHeight: 1.6, marginTop: 2 }}>{info.dbNote}</div>

              {confirmTab === key && (
                <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 8, background: '#fff3cd', border: '1px solid #ffc107', color: '#856404', fontSize: 12.5, lineHeight: 1.6 }}>
                  開くと、マネージャー以上の方が<b>全員（約46名）にスマホ通知・メールを送れる</b>ようになります。開きますか？
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button type="button" disabled={saving} onClick={() => void save([...tabs, key])}
                      style={{ padding: '6px 16px', borderRadius: 8, fontSize: 12.5, fontWeight: 'bold', cursor: saving ? 'default' : 'pointer', background: '#1976d2', color: '#fff', border: '2px solid #1565c0' }}>
                      {saving ? '保存中…' : '開く'}
                    </button>
                    <button type="button" disabled={saving} onClick={() => setConfirmTab(null)}
                      style={{ padding: '6px 16px', borderRadius: 8, fontSize: 12.5, cursor: 'pointer', background: 'transparent', color: '#856404', border: '1px solid #ffc107' }}>
                      やめる
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {msg && <div style={{ marginTop: 10, fontSize: 12, color: '#1e8449', fontWeight: 'bold' }}>{msg}</div>}
      </div>
    </div>
  );
};

export default ManagerAdminTabsSection;
