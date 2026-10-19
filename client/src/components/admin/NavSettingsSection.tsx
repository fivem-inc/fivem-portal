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
import { rankOf, rolesByRank } from '../../lib/roleAttrs';
import { invalidatePublishedCache } from '../../hooks/useFeaturePublished';
import { NAV_REORDERABLE, NAV_KEY_NAME, NAV_FIXED_FIRST, NAV_FIXED_LAST, NAV_FRONT_IF_NEW, parseNavRollout, type NavKey, type NavRollout, type NavRolloutRule } from '../../lib/navItems';
import { TOGGLE_BLUE, backBtn, primaryBtn, tintBtn } from '../../lib/buttonStyles';
import SaveBar from './SaveBar';

interface Staff { id: string; name: string | null; role_title: string | null; group_names: string[] | null; sort_order: number | null }
/**
 * 部署（こども・大人・管理部など）。🚨 group_names には連絡板のグループ（「パート・アルバイトスタッフ」等）も入っているので、
 * 残業の「部門のまとめ」と同じ部署の一覧（overtime_settings.banner_group_names）にあるものだけを部署とする
 */
const deptOf = (s: Staff, depts: string[]) => (s.group_names ?? []).find(g => depts.includes(g)) ?? '';
type RuleKind = keyof NavRollout;   // 'reorder' | 'two_row'

/**
 * 管理者の並び（キーの配列）を、並べ替えできるボタン全部の順に直す。
 * 無いキーは今の並びのまま後ろへ。🚨 ただし 🚃 交通費（NAV_FRONT_IF_NEW）は先頭へ＝ナビの applyNavOrder と同じ置き方
 * （ここが後ろだと、一度保存した時点で交通費がいちばん右に固まった・2026-10-17）
 */
function fullOrder(saved: string[]): NavKey[] {
  const known = saved.filter((k): k is NavKey => NAV_REORDERABLE.includes(k as NavKey));
  const missing = NAV_REORDERABLE.filter(k => !known.includes(k));
  return [...missing.filter(k => NAV_FRONT_IF_NEW.includes(k)), ...known, ...missing.filter(k => !NAV_FRONT_IF_NEW.includes(k))];
}
type MsgArea = 'reorder' | 'two_row' | 'split_home' | 'two_row_choice' | 'order';

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
  const [depts, setDepts] = useState<string[]>([]);
  const [personalCount, setPersonalCount] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [fail, setFail] = useState(false);
  // 使える人の下書き（1つの欄ずつ・null＝見るだけ）。［保存］を押すまでナビは変わらない
  const [ruleDraft, setRuleDraft] = useState<{ kind: RuleKind; rule: NavRolloutRule } | null>(null);
  // 知らせは押した場所のすぐ下に出す（2026-10-17 ユーザー指摘「下に出るけどわかりにくい」）
  const [msgArea, setMsgArea] = useState<MsgArea | null>(null);
  // 初めの並びは［並べ替える］→ ▲▼ →［保存］（保存するまでナビは変わらない・本人の「設定」と同じ形・2026-10-17 ユーザー指示）
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<NavKey[]>([]);
  const [flashKey, setFlashKey] = useState<NavKey | null>(null);
  useEffect(() => { if (!flashKey) return; const t = setTimeout(() => setFlashKey(null), 1200); return () => clearTimeout(t); }, [flashKey]);

  useEffect(() => {
    void (async () => {
      const [st, pf, pc, os] = await Promise.all([
        supabase.from('app_settings').select('key, value').in('key', ['nav_order', 'nav_rollout']),
        supabase.from('profiles').select('id, name, role_title, group_names, sort_order').eq('is_active', true),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).not('nav_order', 'is', null),
        supabase.from('overtime_settings').select('banner_group_names').eq('id', 1).maybeSingle(),
      ]);
      if (st.error) { setFail(true); setMsgArea('order'); setMsg('読み込めませんでした：' + st.error.message); setOrder([...NAV_REORDERABLE]); setRollout(parseNavRollout(null)); return; }
      const m = new Map(((st.data ?? []) as { key: string; value: unknown }[]).map(r => [r.key, r.value]));
      const keys = (m.get('nav_order') as { keys?: unknown } | undefined)?.keys;
      setOrder(fullOrder(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : []));
      setRollout(parseNavRollout(m.get('nav_rollout')));
      if (!pf.error) setStaff((pf.data ?? []) as Staff[]);
      setPersonalCount(pc.error ? null : (pc.count ?? 0));
      const bg = (os.data as { banner_group_names?: unknown } | null)?.banner_group_names;
      if (!os.error && Array.isArray(bg)) setDepts(bg.filter((x): x is string => typeof x === 'string'));
    })();
  }, []);

  /** 「＋ 人を足す」の並び：役職ごと（上の役職から）→ その中は部署 → 名簿の並び順 → 名前（2026-10-17 ユーザー指示） */
  const staffGroups = (list: Staff[]): { role: string; people: Staff[] }[] => {
    const rank = (t: string | null) => rankOf(roles, t) ?? 99;
    // 部署は部門のまとめと同じ順（こども → 大人 → 管理部）。部署なしは最後
    const deptRank = (x: Staff) => { const d = deptOf(x, depts); return d ? depts.indexOf(d) : 99; };
    const sorted = [...list].sort((a, b) =>
      rank(a.role_title) - rank(b.role_title)
      || deptRank(a) - deptRank(b)
      || (a.sort_order ?? 9999) - (b.sort_order ?? 9999)
      || (a.name ?? '').localeCompare(b.name ?? '', 'ja'));
    const names = [...rolesByRank(roles).map(r => r.name), ...new Set(sorted.map(s => s.role_title ?? '役職なし'))];
    return [...new Set(names)].map(role => ({ role, people: sorted.filter(s => (s.role_title ?? '役職なし') === role) })).filter(g => g.people.length > 0);
  };

  const saveSetting = async (key: 'nav_order' | 'nav_rollout', value: unknown, okMsg: string, area: MsgArea): Promise<boolean> => {
    setSaving(true); setMsg(''); setFail(false); setMsgArea(area);
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

  const startEdit = () => { setDraft([...order]); setEditing(true); setMsg(''); setMsgArea(null); };
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= draft.length) return;
    const next = [...draft];
    [next[idx], next[j]] = [next[j], next[idx]];
    setDraft(next); setFlashKey(next[j]);
  };
  const changed = editing && draft.join() !== order.join();
  const saveOrder = async () => {
    if (await saveSetting('nav_order', { keys: draft }, '初めの並びを保存しました。ほかの方の画面には、最長10分で反映されます', 'order')) { setOrder(draft); setEditing(false); }
  };
  // 🚨 片方を変えるときも、もう片方の値は消さずにそのまま保存する
  const saveRule = async (kind: RuleKind, nextRule: NavRolloutRule, okMsg: string) => {
    const next: NavRollout = { ...rollout, [kind]: nextRule };
    if (await saveSetting('nav_rollout', next, okMsg, kind)) { setRollout(next); setRuleDraft(null); }
  };

  const myRoleId = roles.find(r => r.name === staff.find(s => s.id === user?.id)?.role_title)?.id;
  const nameOf = (id: string) => staff.find(s => s.id === id)?.name ?? '（在籍していない方）';
  const arrow = (disabled: boolean): React.CSSProperties => ({
    width: 36, height: 32, borderRadius: 6, border: `1px solid ${border}`, background: 'transparent',
    color: disabled ? border : text, cursor: disabled ? 'default' : 'pointer', fontSize: 11,
  });

  // 知らせ（その場所で押したときだけ・成功は薄緑・失敗は赤）
  const msgBox = (area: MsgArea) => msg && msgArea === area ? (
    <div role="status" style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, fontSize: 13,
      ...(fail ? { background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029' } : { background: '#d4edda', border: '1px solid #c3e6cb', color: '#155724' }) }}>{fail ? '' : '✓ '}{msg}</div>
  ) : null;
  const reorderLabel = rollout.reorder.mode === 'off' ? 'いまはオフなので、誰のナビも変わりません'
    : rollout.reorder.mode === 'all' ? 'いまは全員に使われます' : 'いまは「選んだ人だけ」の方に使われます';

  // 使える人の切り替え（並べ替え・2段・分けるの3つがこれを使う）
  const MODE_NAME: Record<NavRolloutRule['mode'], string> = { off: 'オフ', selected: '選んだ人だけ', all: '全員' };
  const ruleEditor = (kind: RuleKind, title: string, offText: string) => {
    const saved = rollout[kind];
    const editing = ruleDraft?.kind === kind;
    const rule = editing ? ruleDraft!.rule : saved;
    const setRule = (next: NavRolloutRule) => setRuleDraft({ kind, rule: next });
    const meIncluded = rule.mode === 'all' || (rule.mode === 'selected' && ((!!user && rule.user_ids.includes(user.id)) || (!!myRoleId && rule.role_ids.includes(myRoleId))));
    const toggleRole = (id: string) => setRule({ ...rule, role_ids: rule.role_ids.includes(id) ? rule.role_ids.filter(r => r !== id) : [...rule.role_ids, id] });
    const addUser = (id: string) => { if (id && !rule.user_ids.includes(id)) setRule({ ...rule, user_ids: [...rule.user_ids, id] }); };
    const removeUser = (id: string) => setRule({ ...rule, user_ids: rule.user_ids.filter(u => u !== id) });
    // 変える内容（保存の帯に出す）
    const changes: string[] = [];
    if (editing) {
      if (rule.mode !== saved.mode) changes.push(`使える人：${MODE_NAME[saved.mode]} → ${MODE_NAME[rule.mode]}`);
      for (const r of roles) {
        const was = saved.role_ids.includes(r.id), now = rule.role_ids.includes(r.id);
        if (was !== now) changes.push(`役職「${r.name}」を${now ? '足す' : '外す'}`);
      }
      for (const id of new Set([...saved.user_ids, ...rule.user_ids])) {
        const was = saved.user_ids.includes(id), now = rule.user_ids.includes(id);
        if (was !== now) changes.push(`${nameOf(id)}を${now ? '足す' : '外す'}`);
      }
    }
    const modeBtn = (m: NavRolloutRule['mode'], label: string) => (
      <button key={m} type="button" disabled={saving || !editing} onClick={() => setRule({ ...rule, mode: m })}
        style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', cursor: editing ? 'pointer' : 'default', fontSize: 13,
          background: rule.mode === m ? TOGGLE_BLUE : chipBg, color: rule.mode === m ? '#fff' : text, fontWeight: rule.mode === m ? 'bold' : 'normal' }}>{label}</button>
    );
    return (
      <div style={{ marginBottom: 14, ...(editing ? { border: '1px solid #f59e0b', borderRadius: 10, padding: '10px 12px' } : {}) }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
          <div style={{ fontSize: 13, fontWeight: 'bold' }}>{title}</div>
          {editing
            ? <span style={{ fontSize: 12, color: '#d97706', fontWeight: 'bold', flexShrink: 0 }}>✏️ 編集中</span>
            : <button type="button" disabled={!!ruleDraft || saving} onClick={() => { setRuleDraft({ kind, rule: { ...saved, role_ids: [...saved.role_ids], user_ids: [...saved.user_ids] } }); setMsg(''); }}
                style={{ padding: '5px 12px', borderRadius: 8, border: 'none', background: '#f59e0b', color: '#fff', fontWeight: 'bold', fontSize: 12, cursor: ruleDraft ? 'default' : 'pointer', opacity: ruleDraft ? 0.5 : 1, flexShrink: 0 }}>✏️ 変更する</button>}
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          {modeBtn('off', 'オフ')}{modeBtn('selected', '選んだ人だけ')}{modeBtn('all', '全員')}
        </div>
        {rule.mode === 'selected' && (
          <div style={{ border: `1px solid ${border}`, borderRadius: 8, padding: '10px 12px', marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>役職で選ぶ{editing ? '（押すと切り替わります）' : ''}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {roles.map(r => {
                const onR = rule.role_ids.includes(r.id);
                return (
                  <button key={r.id} type="button" disabled={saving || !editing} onClick={() => toggleRole(r.id)}
                    style={{ padding: '4px 12px', borderRadius: 14, border: 'none', cursor: editing ? 'pointer' : 'default', fontSize: 12.5,
                      background: onR ? TOGGLE_BLUE : chipBg, color: onR ? '#fff' : text }}>{r.name}</button>
                );
              })}
            </div>
            <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>人で選ぶ</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              {rule.user_ids.length === 0 && <span style={{ fontSize: 12, color: subText }}>（まだいません）</span>}
              {rule.user_ids.map(id => (
                <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: editing ? '3px 6px 3px 10px' : '3px 10px', borderRadius: 14, background: chipBg, fontSize: 12.5 }}>
                  {nameOf(id)}
                  {editing && <button type="button" aria-label={`${nameOf(id)}を外す`} disabled={saving} onClick={() => removeUser(id)}
                    style={{ border: 'none', background: 'transparent', color: subText, cursor: 'pointer', fontSize: 13 }}>✕</button>}
                </span>
              ))}
            </div>
            {editing && (
              <select value="" onChange={e => addUser(e.target.value)} disabled={saving}
                style={{ padding: '6px 8px', borderRadius: 6, border: `1px solid ${border}`, background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 13 }}>
                <option value="">＋ 人を足す</option>
                {staffGroups(staff.filter(s => !rule.user_ids.includes(s.id))).map(g => (
                  <optgroup key={g.role} label={g.role}>
                    {g.people.map(s => <option key={s.id} value={s.id}>{s.name}{deptOf(s, depts) ? `（${deptOf(s, depts)}）` : ''}</option>)}
                  </optgroup>
                ))}
              </select>
            )}
          </div>
        )}
        {rule.mode !== 'off' && !meIncluded && (
          <div style={{ fontSize: 12, color: subText }}>あなたは対象に入っていません（ご自身の画面は変わりません）。</div>
        )}
        {editing
          ? <SaveBar isDark={isDarkMode} changes={changes} saving={saving} msg={msg && msgArea === kind && fail ? { text: msg, fail: true } : null}
              warn={rule.mode === 'off' && saved.mode !== 'off' ? offText : undefined}
              onCancel={() => { setRuleDraft(null); setMsg(''); }} onSave={() => void saveRule(kind, rule, '保存しました。ほかの方の画面には、最長10分で反映されます')} />
          : msgBox(kind)}
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
      {ruleEditor('two_row_choice', '2段を自分で選べる人（「設定」で 2段／1段 を選ぶ・選んでいない人は上の「2段を使う人」に従う）',
        'オフにすると、選ぶ欄が消え、上の「2段を使う人」の設定に戻ります（選んだ形は消えず、オンに戻すと元に戻ります）。')}
      {ruleEditor('split_home', 'ホームと交通費を分ける（🏠 ホーム と 🚃 交通費 の2つのボタン）人',
        'オフにすると、対象の方は今までどおり「🏠 交通費」の1ページに戻ります（申請の記録は変わりません）。')}

      {/* 全員の初めの並び（［並べ替える］→ ▲▼ →［保存］） */}
      <div style={{ borderTop: `1px solid ${border}`, paddingTop: 12, marginTop: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 4 }}>全員の初めの並び</div>
        <div style={{ fontSize: 12, color: subText, lineHeight: 1.7, marginBottom: 8 }}>
          上にあるものほど、ナビの左に出ます。灰色の行はいつも同じ場所です。
          この並びは、上の「並べ替え」を使える人にだけ効きます（{reorderLabel}）。
          {personalCount ? `自分で並べている${personalCount}人には効きません。` : ''}
        </div>
        <div style={{ border: `1px solid ${border}`, borderRadius: 8, overflow: 'hidden' }}>
          {[...NAV_FIXED_FIRST, ...(editing ? draft : order), ...NAV_FIXED_LAST].map((k, i) => {
            const fixed = NAV_FIXED_FIRST.includes(k) || NAV_FIXED_LAST.includes(k);
            const list = editing ? draft : order;
            const idx = list.indexOf(k);
            return (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', minHeight: 36, fontSize: 13,
                borderTop: i === 0 ? 'none' : `1px solid ${border}`,
                background: flashKey === k ? (isDarkMode ? '#1e3a5f' : '#e7f1ff') : fixed ? (isDarkMode ? '#2b3035' : '#f8f9fa') : 'transparent',
                color: fixed ? subText : text, transition: 'background 0.3s' }}>
                <span style={{ width: 22, textAlign: 'right', color: subText, fontSize: 12 }}>{fixed ? '' : idx + 1}</span>
                <span style={{ flex: 1 }}>{NAV_KEY_NAME[k]}{fixed ? '（固定）' : ''}</span>
                {editing && !fixed && <>
                  <button type="button" aria-label={`${NAV_KEY_NAME[k]}を上へ`} disabled={idx === 0 || saving} style={arrow(idx === 0)} onClick={() => move(idx, -1)}>▲</button>
                  <button type="button" aria-label={`${NAV_KEY_NAME[k]}を下へ`} disabled={idx === draft.length - 1 || saving} style={arrow(idx === draft.length - 1)} onClick={() => move(idx, 1)}>▼</button>
                </>}
              </div>
            );
          })}
        </div>
        {!editing ? (
          <div style={{ marginTop: 10 }}>
            <button type="button" style={tintBtn(isDarkMode)} onClick={startEdit}>並べ替える</button>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: subText, margin: '8px 0 6px' }}>
              {changed ? '［保存］を押すまで、ナビは変わりません。' : '▲▼ で動かしてください。'}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" style={{ ...backBtn(isDarkMode), flex: 1 }} disabled={saving} onClick={() => setEditing(false)}>やめる</button>
              <button type="button" style={{ ...primaryBtn({ disabled: saving || !changed }), flex: 2 }} disabled={saving || !changed} onClick={saveOrder}>
                {saving ? '保存しています…' : '保存'}
              </button>
            </div>
          </>
        )}
        {msgBox('order')}
      </div>
    </div>
  );
};

export default NavSettingsSection;
