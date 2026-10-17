// 管理画面「権限管理」の「上のナビ」（2026-10-17・計画 docs/計画-ナビの並び替え.md の 2b・2c）
//
// ・並べ替え（app_settings 'nav_rollout'.reorder）とスマホの2段（同 .two_row）を使える人：オフ／選んだ人だけ／全員。
//   まず社長で試すため（2026-10-17 ユーザー指示）。🚨 2つは同じ部品（ruleEditor）で出す（書き写さない）
// ・全員の初めの並び（app_settings 'nav_order'）：▲▼ で並べる。🚨 効くのは「並べ替え」がオンの人だけ（オフの人は今の並びのまま＝すぐ戻せる）
// 🚨 固定の3つ（⚙️ 管理・🏠・💡 FAQ）は並べ替えない。ボタンの一覧と名前は lib/navItems.ts だけ（書き写さない）
// 🚨 upsert は0件でもエラーにならないので件数を見る。保存したら invalidatePublishedCache で読み直す

import React, { useContext, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useAdminPanel } from './AdminPanelContext';
import { AuthContext } from '../../contexts/AuthContext.tsx';
import { useRoles } from '../../hooks/useRoles';
import { invalidatePublishedCache } from '../../hooks/useFeaturePublished';
import { NAV_REORDERABLE, NAV_KEY_NAME, parseNavRollout, type NavKey, type NavRollout, type NavRolloutRule } from '../../lib/navItems';
import { TOGGLE_BLUE, backBtn, primaryBtn } from '../../lib/buttonStyles';

interface Staff { id: string; name: string | null; role_title: string | null }
type RuleKind = keyof NavRollout;   // 'reorder' | 'two_row'

/** 管理者の並び（キーの配列）を、並べ替えできるボタン全部の順に直す（無いキーは今の並びのまま後ろへ） */
function fullOrder(saved: string[]): NavKey[] {
  const known = saved.filter((k): k is NavKey => NAV_REORDERABLE.includes(k as NavKey));
  return [...known, ...NAV_REORDERABLE.filter(k => !known.includes(k))];
}

const NavSettingsSection: React.FC = () => {
  const { isDarkMode } = useAdminPanel();
  const { user } = useContext(AuthContext);
  const roles = useRoles();
  const text = isDarkMode ? '#e9ecef' : '#212529';
  const subText = isDarkMode ? '#adb5bd' : '#6c757d';
  const border = isDarkMode ? '#495057' : '#dee2e6';
  const chipBg = isDarkMode ? '#495057' : '#e9ecef';

  const [order, setOrder] = useState<NavKey[] | null>(null);
  const [rollout, setRollout] = useState<NavRollout | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [personalCount, setPersonalCount] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [fail, setFail] = useState(false);
  const [confirmOff, setConfirmOff] = useState<RuleKind | null>(null);

  useEffect(() => {
    void (async () => {
      const [st, pf, pc] = await Promise.all([
        supabase.from('app_settings').select('key, value').in('key', ['nav_order', 'nav_rollout']),
        supabase.from('profiles').select('id, name, role_title').eq('is_active', true).order('name'),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).not('nav_order', 'is', null),
      ]);
      if (st.error) { setFail(true); setMsg('読み込めませんでした：' + st.error.message); setOrder([...NAV_REORDERABLE]); setRollout(parseNavRollout(null)); return; }
      const m = new Map(((st.data ?? []) as { key: string; value: unknown }[]).map(r => [r.key, r.value]));
      const keys = (m.get('nav_order') as { keys?: unknown } | undefined)?.keys;
      setOrder(fullOrder(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : []));
      setRollout(parseNavRollout(m.get('nav_rollout')));
      if (!pf.error) setStaff((pf.data ?? []) as Staff[]);
      setPersonalCount(pc.error ? null : (pc.count ?? 0));
    })();
  }, []);

  const saveSetting = async (key: 'nav_order' | 'nav_rollout', value: unknown, okMsg: string): Promise<boolean> => {
    setSaving(true); setMsg(''); setFail(false);
    const { data, error } = await supabase.from('app_settings')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' }).select('key');
    setSaving(false);
    if (error) { setFail(true); setMsg('保存できませんでした：' + error.message); return false; }
    if (!data || data.length === 0) { setFail(true); setMsg('保存できませんでした（0件）。管理者のアカウントでお試しください'); return false; }
    invalidatePublishedCache();
    setMsg(okMsg);
    return true;
  };

  if (!order || !rollout) return null;

  const move = async (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= order.length || saving) return;
    const next = [...order];
    [next[idx], next[j]] = [next[j], next[idx]];
    if (await saveSetting('nav_order', { keys: next }, '初めの並びを保存しました')) setOrder(next);
  };
  // 🚨 片方を変えるときも、もう片方の値は消さずにそのまま保存する
  const saveRule = async (kind: RuleKind, nextRule: NavRolloutRule, okMsg: string) => {
    const next: NavRollout = { ...rollout, [kind]: nextRule };
    if (await saveSetting('nav_rollout', next, okMsg)) { setRollout(next); setConfirmOff(null); }
  };

  const myRoleId = roles.find(r => r.name === staff.find(s => s.id === user?.id)?.role_title)?.id;
  const nameOf = (id: string) => staff.find(s => s.id === id)?.name ?? '（在籍していない方）';
  const arrow = (disabled: boolean): React.CSSProperties => ({
    width: 36, height: 32, borderRadius: 6, border: `1px solid ${border}`, background: 'transparent',
    color: disabled ? border : text, cursor: disabled ? 'default' : 'pointer', fontSize: 11,
  });

  // 使える人の切り替え（並べ替え・2段の両方がこれを使う）
  const ruleEditor = (kind: RuleKind, title: string, offText: string) => {
    const rule = rollout[kind];
    const meIncluded = rule.mode === 'all' || (rule.mode === 'selected' && ((!!user && rule.user_ids.includes(user.id)) || (!!myRoleId && rule.role_ids.includes(myRoleId))));
    const setMode = (mode: NavRolloutRule['mode']) => {
      if (mode === rule.mode) return;
      if (mode === 'off') { setConfirmOff(kind); return; }   // オフに戻すときだけ確かめる
      void saveRule(kind, { ...rule, mode }, mode === 'all' ? '全員にしました' : '選んだ人だけにしました');
    };
    const toggleRole = (id: string) => {
      const role_ids = rule.role_ids.includes(id) ? rule.role_ids.filter(r => r !== id) : [...rule.role_ids, id];
      void saveRule(kind, { ...rule, role_ids }, '対象の役職を保存しました');
    };
    const addUser = (id: string) => {
      if (!id || rule.user_ids.includes(id)) return;
      void saveRule(kind, { ...rule, user_ids: [...rule.user_ids, id] }, '対象の方を足しました');
    };
    const removeUser = (id: string) => void saveRule(kind, { ...rule, user_ids: rule.user_ids.filter(u => u !== id) }, '対象の方を外しました');
    const modeBtn = (m: NavRolloutRule['mode'], label: string) => (
      <button key={m} type="button" disabled={saving} onClick={() => setMode(m)}
        style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13,
          background: rule.mode === m ? TOGGLE_BLUE : chipBg, color: rule.mode === m ? '#fff' : text, fontWeight: rule.mode === m ? 'bold' : 'normal' }}>{label}</button>
    );
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 6 }}>{title}</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          {modeBtn('off', 'オフ')}{modeBtn('selected', '選んだ人だけ')}{modeBtn('all', '全員')}
        </div>
        {confirmOff === kind && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5, marginBottom: 8 }}>
            <span>{offText}</span>
            <button type="button" style={{ ...backBtn(isDarkMode), padding: '5px 12px' }} onClick={() => setConfirmOff(null)}>やめる</button>
            <button type="button" style={{ ...primaryBtn({ disabled: saving }), padding: '5px 12px' }} disabled={saving}
              onClick={() => saveRule(kind, { ...rule, mode: 'off' }, 'オフにしました')}>オフにする</button>
          </div>
        )}
        {rule.mode === 'selected' && (
          <div style={{ border: `1px solid ${border}`, borderRadius: 8, padding: '10px 12px', marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>役職で選ぶ（押すと切り替わります）</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {roles.map(r => {
                const onR = rule.role_ids.includes(r.id);
                return (
                  <button key={r.id} type="button" disabled={saving} onClick={() => toggleRole(r.id)}
                    style={{ padding: '4px 12px', borderRadius: 14, border: 'none', cursor: 'pointer', fontSize: 12.5,
                      background: onR ? TOGGLE_BLUE : chipBg, color: onR ? '#fff' : text }}>{r.name}</button>
                );
              })}
            </div>
            <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>人で選ぶ</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              {rule.user_ids.length === 0 && <span style={{ fontSize: 12, color: subText }}>（まだいません）</span>}
              {rule.user_ids.map(id => (
                <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 6px 3px 10px', borderRadius: 14, background: chipBg, fontSize: 12.5 }}>
                  {nameOf(id)}
                  <button type="button" aria-label={`${nameOf(id)}を外す`} disabled={saving} onClick={() => removeUser(id)}
                    style={{ border: 'none', background: 'transparent', color: subText, cursor: 'pointer', fontSize: 13 }}>✕</button>
                </span>
              ))}
            </div>
            <select value="" onChange={e => addUser(e.target.value)} disabled={saving}
              style={{ padding: '6px 8px', borderRadius: 6, border: `1px solid ${border}`, background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 13 }}>
              <option value="">＋ 人を足す</option>
              {staff.filter(s => !rule.user_ids.includes(s.id)).map(s => <option key={s.id} value={s.id}>{s.name}（{s.role_title ?? '—'}）</option>)}
            </select>
          </div>
        )}
        {rule.mode !== 'off' && !meIncluded && (
          <div style={{ fontSize: 12, color: subText }}>あなたは対象に入っていません（ご自身の画面は変わりません）。</div>
        )}
      </div>
    );
  };

  return (
    <div style={{ background: isDarkMode ? '#343a40' : '#fff', border: `1px solid ${border}`, borderRadius: 12, padding: '16px 18px', marginTop: 16, color: text }}>
      <div style={{ fontSize: 15, fontWeight: 'bold', marginBottom: 6 }}>上のナビ</div>
      <div style={{ fontSize: 12.5, color: subText, lineHeight: 1.8, marginBottom: 12 }}>
        新しいナビの機能を、使う人を選んで試せます。オフの方は今までどおりです（オフに戻せば、すぐ元に戻ります）。
      </div>

      {ruleEditor('reorder', '並べ替え（初めの並び・本人が「設定」で並べ替え）を使える人',
        `オフにすると、対象の方のナビは元の並びに戻ります。${personalCount ? `自分で並べた並び（${personalCount}人分）は消えず、オンに戻すと元に戻ります。` : ''}`)}
      {ruleEditor('two_row', 'スマホの2段（ページの上では2段・下へ動かすと1段）を使う人',
        'オフにすると、対象の方のスマホのナビは今までの1段に戻ります。')}
      {ruleEditor('split_home', 'ホームと交通費を分ける（🏠 ホーム と 🚃 交通費 の2つのボタン）人',
        'オフにすると、対象の方は今までどおり「🏠 交通費」の1ページに戻ります（申請の記録は変わりません）。')}

      {/* 全員の初めの並び */}
      <div style={{ fontSize: 13, fontWeight: 'bold', margin: '4px 0 6px' }}>全員の初めの並び</div>
      <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>
        ⚙️ 管理・🏠・💡 FAQ はいつも同じ場所です。その間の並びを決めます。上にあるものほど、ナビの左に出ます。押すとすぐ保存します。
        {personalCount ? `（自分で並べている${personalCount}人には反映されません）` : ''}
      </div>
      <div style={{ border: `1px solid ${border}`, borderRadius: 8 }}>
        {order.map((k, idx) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderTop: idx === 0 ? 'none' : `1px solid ${border}`, fontSize: 13 }}>
            <span style={{ flex: 1 }}>{NAV_KEY_NAME[k]}</span>
            <button type="button" aria-label={`${NAV_KEY_NAME[k]}を上へ`} disabled={idx === 0 || saving} style={arrow(idx === 0)} onClick={() => move(idx, -1)}>▲</button>
            <button type="button" aria-label={`${NAV_KEY_NAME[k]}を下へ`} disabled={idx === order.length - 1 || saving} style={arrow(idx === order.length - 1)} onClick={() => move(idx, 1)}>▼</button>
          </div>
        ))}
      </div>

      {msg && (
        <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 13,
          ...(fail ? { background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029' } : { background: '#d4edda', border: '1px solid #c3e6cb', color: '#155724' }) }}>{msg}</div>
      )}
    </div>
  );
};

export default NavSettingsSection;
