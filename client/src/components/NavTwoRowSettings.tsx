// 「設定」の「スマホのナビ」（2026-10-17 ユーザー確定）：本人が 2段／1段 を選ぶ
//
// 🚨 出すのは、管理画面の「2段を自分で選べる人」（nav_rollout.two_row_choice）が効いている人だけ（判定は hooks/useNavRolloutOn・ナビと同じもの）
// 🚨 選んでいない人（null）は、管理画面の「2段を使う人」（two_row）に従う。［管理者の設定に戻す］で null に戻す
// 🚨 押した瞬間には保存しない：選ぶ →［保存］（ナビの並びと同じ形）。役職プレビュー中は保存しない（管理者本人の選択を書き換えるため）
// 🚨 選んだ形はアカウントに残す（profiles.nav_two_row・RPC set_my_nav_two_row）＝スマホを替えても残る

import React, { useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { AuthContext } from '../contexts/AuthContext.tsx';
import { useAuth, setMyNavTwoRowLocal } from '../hooks/useAuth';
import { useMyNavTwoRow } from '../hooks/useMyNavTwoRow';
import { useNavRolloutOn } from '../hooks/useNavRolloutOn';
import { TOGGLE_BLUE, backBtn, primaryBtn } from '../lib/buttonStyles';
import { SettingsRow, type SettingsColors } from './SettingsRow';

interface Props { isDark: boolean; colors: SettingsColors; open: boolean; onToggle: () => void }

const NavTwoRowSettings: React.FC<Props> = ({ isDark, colors, open, onToggle }) => {
  const { user } = useAuth();
  const { previewRole } = useContext(AuthContext);
  const userId = user?.id ?? null;
  const mine = useMyNavTwoRow(userId);
  const adminTwoRow = useNavRolloutOn('two_row');
  const effective = mine ?? adminTwoRow;
  const [draft, setDraft] = useState<boolean>(effective);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');

  // 開いたときは今の形から始める
  useEffect(() => { if (open) { setDraft(effective); setErr(''); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (value: boolean | null) => {
    if (!userId || previewRole) return;
    setSaving(true); setErr(''); setSaved('');
    const { error } = await supabase.rpc('set_my_nav_two_row', { p_value: value });
    setSaving(false);
    if (error) { setErr('保存できませんでした：' + error.message); return; }
    setMyNavTwoRowLocal(userId, value);
    setSaved(value === null ? '管理者の設定に戻しました' : '保存しました');
  };

  const option = (v: boolean, title: string, sub: string) => {
    const on = draft === v;
    return (
      <button type="button" onClick={() => { setDraft(v); setSaved(''); }} disabled={!!previewRole}
        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', marginBottom: 6, borderRadius: 10, cursor: previewRole ? 'default' : 'pointer',
          border: `${on ? 2 : 1}px solid ${on ? TOGGLE_BLUE : colors.border}`, background: on ? (isDark ? '#1e3a5f' : '#e3f2fd') : 'transparent', color: colors.text }}>
        <div style={{ fontSize: 14, fontWeight: on ? 'bold' : 'normal' }}>{on ? '● ' : '○ '}{title}</div>
        <div style={{ fontSize: 12, color: colors.sub, marginTop: 2 }}>{sub}</div>
      </button>
    );
  };

  return (
    <SettingsRow icon="☰" title="スマホのナビ" sub="上のナビを2段にするか" value={effective ? '2段' : '1段'} colors={colors} open={open} onToggle={onToggle}>
      {option(true, '2段', 'ページの上では2段。下へ動かすと1段になります')}
      {option(false, '1段', 'いつも1段。入りきらないボタンは横にずらして見ます')}
      <p style={{ margin: '2px 0 8px', fontSize: 12, color: colors.sub }}>
        {mine === null ? `いまは管理者の設定（${adminTwoRow ? '2段' : '1段'}）のままです。` : 'ご自身で選んだ形です。'}パソコンでは、どちらを選んでも1段です。
      </p>
      {previewRole && <p style={{ margin: '0 0 8px', fontSize: 12, color: colors.sub }}>役職プレビュー中は保存できません。</p>}
      {err && <div style={{ marginBottom: 8, fontSize: 13, color: '#dc3545' }}>{err}</div>}
      {!previewRole && (
        <div style={{ display: 'flex', gap: 8 }}>
          {mine !== null && (
            <button type="button" style={{ ...backBtn(isDark), flex: 1, padding: '10px 0', fontSize: 13 }} disabled={saving} onClick={() => void save(null)}>管理者の設定に戻す</button>
          )}
          <button type="button" style={{ ...primaryBtn({ disabled: saving || draft === effective }), flex: 2, padding: '10px 0' }}
            disabled={saving || draft === effective} onClick={() => void save(draft)}>{saving ? '保存中…' : '保存'}</button>
        </div>
      )}
      {saved && (
        <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 13, background: '#d4edda', border: '1px solid #c3e6cb', color: '#155724' }}>✓ {saved}</div>
      )}
    </SettingsRow>
  );
};

export default NavTwoRowSettings;
