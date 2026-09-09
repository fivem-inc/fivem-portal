// 管理画面「役職・機能権限」の3枚目のカード：役職の区分（立場・承認者・リーダー以上・マネージャー以上・決裁者・経営）。
//
// 【なぜ要るか（2026-09-09〜10 役職の属性化）】
// 役職名（'社長' 等）で判定していたため、改名しただけで本番の権限が壊れた。
// 判定を roles の属性に移したので、その属性をここで管理する。
// 会長・副社長・エリアマネージャーを新設したら、ここでチェックを入れるだけで
// 休暇の受理・備品購入の決裁・社長宛の通知・先行公開に、その日から入る（コードは触らない）。
//
// 🚨 区分は権限そのもの。役職一覧（追加・改名・▲▼）と違い、押した瞬間には保存しない。
//    「変更する」→ 触る →「保存する」の2段（機能別 表示権限と同じ）。
// 🚨 管理者（is_fixed）は常に ON・立場は経理（accounting）で固定。触れない。
// 🚨 update は0件でもエラーにならないので、.select('id') で件数を見る（2026-09-09 の決まり）。

import React, { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RoleRow, ActsAs } from '../../lib/roleAttrs';
import { refreshRoles } from '../../hooks/useRoles';

type Attrs = Pick<RoleRow, 'acts_as' | 'is_approver' | 'is_leader_plus' | 'is_manager_plus' | 'is_board_approver' | 'is_org_wide'>;
type AttrKey = keyof Omit<Attrs, 'acts_as'>;

const FLAGS: { key: AttrKey; label: string; note: string }[] = [
  { key: 'is_approver',       label: '承認者',        note: '休暇・勤務変更の申請を受理・差し戻しできます' },
  { key: 'is_leader_plus',    label: 'リーダー以上',   note: '「リーダー以上」に先行公開した機能が見えます。回覧の宛先になります' },
  { key: 'is_manager_plus',   label: 'マネージャー以上', note: '安否確認の発信、残業の自己確定、電話番号の閲覧ができます' },
  { key: 'is_board_approver', label: '決裁者',        note: '備品購入の3万円超の全員承認に入ります。見積書を見られます（経理は含めません）' },
  { key: 'is_org_wide',       label: '経営',          note: 'グループに関係なくすべての通知が届きます。「社長のみ」に公開した機能が見えます' },
];
const ACTS: { value: ActsAs | ''; label: string }[] = [
  { value: '',           label: '（なし）' },
  { value: 'leader',     label: 'リーダー' },
  { value: 'manager',    label: 'マネージャー' },
  { value: 'accounting', label: '経理' },
  { value: 'president',  label: '社長' },
];

const RoleAttributesCard: React.FC<{
  roles: RoleRow[];
  isDarkMode: boolean;
  supabase: SupabaseClient;
  onSaved: () => void;
  setErrorMsg: (m: string) => void;
  setSuccessMsg: (m: string) => void;
}> = ({ roles, isDarkMode, supabase, onSaved, setErrorMsg, setSuccessMsg }) => {
  const cardBg   = isDarkMode ? '#2d3136' : '#ffffff';
  const border   = isDarkMode ? '#495057' : '#dee2e6';
  const text     = isDarkMode ? '#ffffff' : '#333333';
  const subText  = isDarkMode ? '#adb5bd' : '#666666';
  const headerBg = isDarkMode ? '#3d4147' : '#f0f4ff';

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Record<string, Attrs>>({});

  const snapshot = (rs: RoleRow[]): Record<string, Attrs> =>
    Object.fromEntries(rs.map(r => [r.id, {
      acts_as: r.acts_as, is_approver: r.is_approver, is_leader_plus: r.is_leader_plus,
      is_manager_plus: r.is_manager_plus, is_board_approver: r.is_board_approver, is_org_wide: r.is_org_wide,
    }]));
  useEffect(() => { if (!editing) setDraft(snapshot(roles)); }, [roles, editing]);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(snapshot(roles));
  const setFlag = (id: string, key: AttrKey, v: boolean) => setDraft(d => ({ ...d, [id]: { ...d[id], [key]: v } }));
  const setActs = (id: string, v: ActsAs | '') => setDraft(d => ({ ...d, [id]: { ...d[id], acts_as: v === '' ? null : v } }));

  // 矛盾の気づき（止めない）：上位の区分がONなのに下位がOFF
  const warnings = roles.filter(r => !r.is_fixed).flatMap(r => {
    const a = draft[r.id]; if (!a) return [];
    const w: string[] = [];
    if (a.is_manager_plus && !a.is_leader_plus) w.push(`「${r.name}」はマネージャー以上ONですがリーダー以上がOFFです`);
    if (a.is_board_approver && !a.is_manager_plus) w.push(`「${r.name}」は決裁者ONですがマネージャー以上がOFFです`);
    if (a.acts_as === 'president' && !a.is_org_wide) w.push(`「${r.name}」は立場が社長ですが経営がOFFです`);
    return w;
  });

  const save = async () => {
    setSaving(true);
    const changed = roles.filter(r => !r.is_fixed && JSON.stringify(draft[r.id]) !== JSON.stringify(snapshot([r])[r.id]));
    for (const r of changed) {
      const { data, error } = await supabase.from('roles').update(draft[r.id]).eq('id', r.id).select('id');
      if (error) { setErrorMsg(`「${r.name}」の区分を保存できませんでした：${error.message}`); setSaving(false); return; }
      if (!data || data.length === 0) { setErrorMsg(`「${r.name}」の区分を保存できませんでした（権限が不足しているか、役職が削除されています）`); setSaving(false); return; }
    }
    setSaving(false);
    setEditing(false);
    await refreshRoles();   // 全画面が読む一覧を取り直す
    onSaved();
    setSuccessMsg(changed.length === 0 ? '変更はありません' : `役職の区分を保存しました（${changed.length}件）。次回のログインから反映されます`);
  };

  const toggle = (on: boolean, fixed: boolean, onClick: () => void) => (
    <button onClick={onClick} disabled={!editing || fixed}
      title={!editing ? '「変更する」を押して編集モードに入ってください' : (fixed ? '管理者は常にONです' : undefined)}
      style={{
        width: 32, height: 18, borderRadius: 9, border: 'none', position: 'relative', flexShrink: 0,
        background: fixed ? '#93c5fd' : on ? '#22c55e' : (isDarkMode ? '#555' : '#ccc'),
        cursor: editing && !fixed ? 'pointer' : 'default', opacity: editing ? 1 : 0.7, padding: 0,
      }}>
      <span style={{ position: 'absolute', top: 2, left: (fixed || on) ? 16 : 2, width: 14, height: 14, borderRadius: 7, background: '#fff', transition: 'left .15s' }} />
    </button>
  );

  const btnBase: React.CSSProperties = { padding: '5px 12px', borderRadius: 8, border: `1px solid ${border}`, cursor: 'pointer', fontSize: 12, background: isDarkMode ? '#495057' : '#f8f9fa', color: text };

  return (
    <div style={{ maxWidth: 820, margin: '0 auto 20px', padding: '0 12px' }}>
      <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${border}`, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', background: editing ? (isDarkMode ? '#3a2e00' : '#fffbeb') : headerBg, borderBottom: `1px solid ${editing ? '#f59e0b' : border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 'bold', fontSize: 14, color: text }}>📋 役職の区分</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {editing && <span style={{ fontSize: 12, color: '#d97706', fontWeight: 'bold' }}>✏️ 編集中</span>}
            {!editing ? (
              <button onClick={() => setEditing(true)} style={{ ...btnBase, background: '#f59e0b', color: '#fff', border: 'none', fontWeight: 'bold' }}>✏️ 変更する</button>
            ) : (
              <>
                <button onClick={() => { setDraft(snapshot(roles)); setEditing(false); }} disabled={saving} style={btnBase}>やめる</button>
                <button onClick={save} disabled={saving || !isDirty}
                  style={{ ...btnBase, background: isDirty ? '#22c55e' : (isDarkMode ? '#495057' : '#e9ecef'), color: isDirty ? '#fff' : subText, border: 'none', fontWeight: 'bold' }}>
                  {saving ? '保存中...' : '✓ 保存する'}
                </button>
              </>
            )}
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 640 }}>
            <thead>
              <tr style={{ background: isDarkMode ? '#343a40' : '#f8f9fa' }}>
                <th style={{ textAlign: 'left', padding: '8px 12px', color: subText, fontWeight: 'normal' }}>役職</th>
                <th style={{ textAlign: 'left', padding: '8px 8px', color: subText, fontWeight: 'normal' }}>立場</th>
                {FLAGS.map(f => <th key={f.key} style={{ padding: '8px 6px', color: subText, fontWeight: 'normal', whiteSpace: 'nowrap' }}>{f.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {[...roles].sort((a, b) => a.sort_order - b.sort_order).map(r => {
                const a = draft[r.id]; if (!a) return null;
                return (
                  <tr key={r.id} style={{ borderTop: `1px solid ${border}`, background: r.is_fixed ? (isDarkMode ? '#1a3a6b22' : '#eff6ff') : 'transparent' }}>
                    <td style={{ padding: '8px 12px', color: text, fontWeight: 500, whiteSpace: 'nowrap' }}>
                      {r.name}{r.is_fixed && <span style={{ marginLeft: 6, fontSize: 10, background: '#3b82f6', color: '#fff', borderRadius: 8, padding: '1px 6px' }}>固定</span>}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <select value={a.acts_as ?? ''} disabled={!editing || r.is_fixed} onChange={e => setActs(r.id, e.target.value as ActsAs | '')}
                        style={{ fontSize: 12, padding: '3px 6px', borderRadius: 6, border: `1px solid ${border}`, background: isDarkMode ? '#3d4147' : '#fff', color: text, opacity: editing ? 1 : 0.7 }}>
                        {ACTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </td>
                    {FLAGS.map(f => (
                      <td key={f.key} style={{ padding: '6px', textAlign: 'center' }}>
                        {toggle(!!a[f.key], r.is_fixed, () => setFlag(r.id, f.key, !a[f.key]))}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {editing && warnings.length > 0 && (
          <div style={{ margin: '10px 16px 0', padding: '8px 12px', borderRadius: 8, background: '#fff3cd', border: '1px solid #ffc107', color: '#856404', fontSize: 12, lineHeight: 1.6 }}>
            {warnings.map(w => <div key={w}>⚠️ {w}。意図したものか確認してください。</div>)}
          </div>
        )}

        <div style={{ padding: '10px 16px 14px', fontSize: 11.5, color: subText, lineHeight: 1.8 }}>
          <div><strong>立場</strong> … 承認フローのどの段に立つか。「社長」に立てた役職には、社長宛の通知と休暇の最終受理が届きます（会長を社長と同列にするならここ）。（なし）＝どの段にも立たない（隠居の会長など）</div>
          {FLAGS.map(f => <div key={f.key}><strong>{f.label}</strong> … {f.note}</div>)}
          <div>🔵 管理者は常にすべてON・立場は経理です（変更不可）</div>
        </div>
      </div>
    </div>
  );
};

export default RoleAttributesCard;
