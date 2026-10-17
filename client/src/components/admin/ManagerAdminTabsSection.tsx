import React, { useEffect, useState } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { supabase } from '../../lib/supabaseClient';
import {
  MANAGER_ADMIN_TABS_SETTING_KEY, MANAGER_TAB_INFO, MANAGER_TAB_KEYS, normalizeManagerTabs,
  type ManagerTabKey,
} from '../../lib/adminTabs';
import { refreshManagerAdminTabs } from '../../hooks/useAdminAccess';
import SaveBar, { SaveNotice } from './SaveBar';

// マネージャー以上に開く管理画面のタブ（2026-09-15）。置き場所は「権限管理」タブの末尾。
// 設計・決めたことは docs/計画-管理画面の開放.md。
//
// 🚨 ここで開いたタブは、DB の書き込みの許可も同じ設定で広がる（can_manage_admin_tab）。
//    外せば DB の書き込みも止まる（安否・緊急だけは例外で、もともとマネージャー以上ができる）
// 🚨 「パソコンだけ」は画面の決まり。DB は端末を見分けられない
// 🚨 お知らせは全員に通知・メールを送れるようになるので、開くときは保存の前に黄色い注意を出す
// 🚨 2026-10-17：押した瞬間に保存するのをやめ、［変更する］→ 選ぶ →［保存］に（閉じるのも押した瞬間に効いていた）

const ManagerAdminTabsSection: React.FC = () => {
  const { isDarkMode } = useAdminPanel();
  const [tabs, setTabs] = useState<ManagerTabKey[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<ManagerTabKey[] | null>(null);   // null＝見るだけ
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
    setDraft(null);
    void refreshManagerAdminTabs();
    setMsg('保存しました。開いている画面には30秒ほどで反映されます');
  };

  const toggle = (key: ManagerTabKey) => {
    if (!draft || saving) return;
    setDraft(draft.includes(key) ? draft.filter(k => k !== key) : [...draft, key]);
  };
  const changes = tabs && draft ? MANAGER_TAB_KEYS.filter(k => tabs.includes(k) !== draft.includes(k))
    .map(k => `${MANAGER_TAB_INFO[k].label}：${tabs.includes(k) ? '開いている → 閉じる' : '閉じている → 開く'}`) : [];
  const opensBroadcast = !!tabs && !!draft && MANAGER_TAB_KEYS.some(k => MANAGER_TAB_INFO[k].broadcast && draft.includes(k) && !tabs.includes(k));

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{
        background: '#E3F2FD', borderLeft: '3px solid #1565C0', borderRadius: '0 6px 6px 0',
        padding: '8px 12px', fontSize: 13, fontWeight: 500, color: '#0D47A1', marginBottom: 8,
      }}>
        マネージャー以上に開く管理画面のタブ
      </div>
      {tabs && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
          {draft === null
            ? <button type="button" onClick={() => { setDraft([...tabs]); setMsg(''); setErr(''); }}
                style={{ padding: '5px 12px', borderRadius: 8, border: 'none', background: '#f59e0b', color: '#fff', fontWeight: 'bold', fontSize: 12, cursor: 'pointer' }}>✏️ 変更する</button>
            : <span style={{ fontSize: 12, color: '#d97706', fontWeight: 'bold' }}>✏️ 編集中</span>}
        </div>
      )}

      <div style={{ background: bg, border: `0.5px solid ${borderColor}`, borderRadius: 12, padding: '14px 16px' }}>
        <div style={{ fontSize: 12, color: subText, lineHeight: 1.7, marginBottom: 12 }}>
          選んだタブがあると、マネージャー以上の方が<b style={{ color: text }}>パソコンでログインしたときだけ</b>「⚙️ 管理」が出て、そのタブだけを開けます。
          スマホ・タブレットには出ません。はじめはすべてオフです。<br />
          外すと、開いている画面からも30秒ほどで消え、DB の書き込みも止まります。
          ただし「パソコンだけ」は画面の決まりで、DB は端末を見分けられません。
        </div>

        {err && draft === null && (
          <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, fontSize: 12,
            background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029' }}>{err}</div>
        )}

        {tabs && MANAGER_TAB_KEYS.map(key => {
          const info = MANAGER_TAB_INFO[key];
          const on = (draft ?? tabs).includes(key);
          return (
            <div key={key} style={{ padding: '10px 0', borderTop: `0.5px solid ${borderColor}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, fontWeight: 'bold', color: text, minWidth: 140 }}>{info.label}</span>
                <button type="button" disabled={saving || draft === null} onClick={() => toggle(key)} style={{ ...chip(on), cursor: draft === null ? 'default' : 'pointer' }}>
                  {on ? '開いている' : '閉じている'}
                </button>
              </div>
              <div style={{ fontSize: 12, color: text, lineHeight: 1.6, marginTop: 6 }}>できること：{info.canDo}</div>
              <div style={{ fontSize: 11.5, color: subText, lineHeight: 1.6, marginTop: 2 }}>{info.dbNote}</div>

            </div>
          );
        })}

        {draft !== null
          ? <SaveBar isDark={isDarkMode} changes={changes} saving={saving} msg={err ? { text: err, fail: true } : null}
              warn={opensBroadcast ? <>開くと、マネージャー以上の方が<b>全員（約46名）にスマホ通知・メールを送れる</b>ようになります。</> : undefined}
              onCancel={() => { setDraft(null); setErr(''); }} onSave={() => void save(draft)} />
          : <SaveNotice msg={msg ? { text: msg, fail: false } : null} />}
      </div>
    </div>
  );
};

export default ManagerAdminTabsSection;
