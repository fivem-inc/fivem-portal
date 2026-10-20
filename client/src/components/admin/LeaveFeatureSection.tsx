/**
 * 休職中に使える機能（管理画面 → 役職・機能権限管理・2026-10-20・計画 docs/計画-休職と手続き.md）
 * ・保存先は app_settings 'leave_feature_keys'（上の役職ごとの表とは別）。DB の my_access_state が読む
 * ・実際に使えるのは「ここでオン」かつ「休職前の役職で使えていた機能」（退職者と同じ決め方）
 * ・ひとりだけ変えるのは、ユーザー一覧の［休職を修正］（features_add／features_remove）
 * ・役職としての画面（受理・確認・手続き）は休職中はいつも使えない（ここでは選ばせない）
 * 🚨 押した瞬間には保存しない（［変更する］→ 切り替え →［保存］・2026-10-17 の決まり）
 */
import React, { useEffect, useState } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { supabase } from '../../lib/supabaseClient';
import SaveBar, { SaveNotice } from './SaveBar';
import { LEAVE_SELECTABLE } from '../../lib/staffLeave';

const LeaveFeatureSection: React.FC = () => {
  const { isDarkMode } = useAdminPanel();
  const text = isDarkMode ? '#e9ecef' : '#212529';
  const subText = isDarkMode ? '#adb5bd' : '#6c757d';
  const border = isDarkMode ? '#495057' : '#dee2e6';
  const [keys, setKeys] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [fail, setFail] = useState(false);

  useEffect(() => {
    supabase.from('app_settings').select('value').eq('key', 'leave_feature_keys').maybeSingle()
      .then(({ data, error }: { data: { value: unknown } | null; error: { message: string } | null }) => {
        if (error) { setFail(true); setMsg('読み込めませんでした：' + error.message); setKeys([]); return; }
        const k = (data?.value as { keys?: string[] } | null)?.keys;
        setKeys(Array.isArray(k) ? k : []);
      }, () => { setFail(true); setMsg('読み込めませんでした'); setKeys([]); });
  }, []);

  const isOn = (list: string[], f: (typeof LEAVE_SELECTABLE)[number]) => list.includes(f.keys[0]);
  const toggle = (f: (typeof LEAVE_SELECTABLE)[number]) => {
    if (!draft) return;
    setDraft(isOn(draft, f) ? draft.filter(k => !f.keys.includes(k)) : [...draft, ...f.keys.filter(k => !draft.includes(k))]);
  };

  const save = async (next: string[]) => {
    setSaving(true); setMsg(''); setFail(false);
    // 🚨 upsert は0件でもエラーにならないので件数を見る
    const { data, error } = await supabase.from('app_settings')
      .upsert({ key: 'leave_feature_keys', value: { keys: next }, updated_at: new Date().toISOString() }, { onConflict: 'key' })
      .select('key');
    setSaving(false);
    if (error) { setFail(true); setMsg('保存できませんでした：' + error.message); return; }
    if (!data || data.length === 0) { setFail(true); setMsg('保存できませんでした（0件）。管理者のアカウントでお試しください'); return; }
    setKeys(next); setDraft(null);
    setMsg('保存しました。休職中の方の画面には、次にアプリを開いたときから反映されます。');
  };

  if (keys === null) return null;
  const changes = draft ? LEAVE_SELECTABLE.filter(f => isOn(keys, f) !== isOn(draft, f))
    .map(f => `${f.label}：${isOn(keys, f) ? '使える → 使えない' : '使えない → 使える'}`) : [];

  return (
    <div style={{ background: isDarkMode ? '#343a40' : '#fff', border: `1px solid ${border}`, borderRadius: 12, padding: '16px 18px', marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <div style={{ fontSize: 15, fontWeight: 'bold', color: text }}>休職中に使える機能</div>
        {draft === null
          ? <button type="button" onClick={() => { setDraft([...keys]); setMsg(''); setFail(false); }}
              style={{ padding: '5px 12px', borderRadius: 8, border: 'none', background: '#f59e0b', color: '#fff', fontWeight: 'bold', fontSize: 12, cursor: 'pointer' }}>✏️ 変更する</button>
          : <span style={{ fontSize: 12, color: '#d97706', fontWeight: 'bold' }}>✏️ 編集中</span>}
      </div>
      <div style={{ fontSize: 12.5, color: subText, lineHeight: 1.8, marginBottom: 12 }}>
        休職中の方が使える機能です。実際に使えるのは「ここでオン」かつ「休職前の役職で使えていた機能」です。<br />
        ひとりだけ変えるときは、ユーザー一覧の［休職を修正］から変えます。<br />
        役職としての画面（受理・確認・手続きなど）は、休職中はいつも使えません。
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {LEAVE_SELECTABLE.map(f => {
          const on = isOn(draft ?? keys, f);
          return (
            <button key={f.label} type="button" disabled={saving || draft === null} onClick={() => toggle(f)}
              style={{ padding: '8px 14px', borderRadius: 8, fontSize: 13, cursor: draft === null ? 'default' : 'pointer',
                border: on ? '2px solid #1976d2' : `1px solid ${border}`,
                background: on ? '#1976d2' : (isDarkMode ? '#495057' : '#e3f2fd'),
                color: on ? '#fff' : (isDarkMode ? '#e9ecef' : '#1565c0') }}>
              {on ? '✓ ' : ''}{f.label}
            </button>
          );
        })}
      </div>
      {draft !== null
        ? <SaveBar isDark={isDarkMode} changes={changes} saving={saving} msg={msg ? { text: msg, fail } : null}
            onCancel={() => { setDraft(null); setMsg(''); }} onSave={() => save(draft)} />
        : <SaveNotice msg={msg ? { text: msg, fail } : null} />}
    </div>
  );
};

export default LeaveFeatureSection;
