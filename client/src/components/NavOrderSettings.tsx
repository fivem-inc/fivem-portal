// 「設定」の「上のナビの並び」（2026-10-17・計画 docs/計画-ナビの並び替え.md の 2b）
//
// 🚨 出すのは、管理画面の切り替え（nav_rollout.reorder）が効いている人だけ（判定は hooks/useNavReorderOn・ページと同じもの）
// 🚨 ふだんは1行に畳む。開くと今の並び →［並べ替える］→ ▲▼ で動かす →［保存］（2026-10-17 ユーザー確定）。
//    ［保存］を押すまでは変わらない・［やめる］で元どおり。保存したら薄緑のカード
// 🚨 役職プレビュー中は保存しない（set_my_nav_order は auth.uid() で管理者本人の並びを書き換えてしまうため）
// 🚨 固定の3つ（⚙️ 管理・🏠・💡 FAQ）も灰色の行で出す（全体の中での位置が分かるように）。隠す機能は作らない（ユーザー確定 A）
// 🚨 今は権限が無くて見えていないボタンの順番も、保存した並びの中に残す（lib/navItems の mergeSavedNavOrder）
// 🚨 ▲▼ は色のつかない記号（↑↓ は端末によって色つきの絵文字で出た）

import React, { useContext, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { AuthContext } from '../contexts/AuthContext.tsx';
import { useAuth, setMyNavOrderLocal } from '../hooks/useAuth';
import { useFeaturePublished, isFeaturePublished } from '../hooks/useFeaturePublished';
import { useMyNavOrder } from '../hooks/useMyNavOrder';
import { buildNavItems, applyNavOrder, mergeSavedNavOrder, NAV_FIXED_FIRST, NAV_FIXED_LAST, type NavItem } from '../lib/navItems';
import { backBtn, primaryBtn, tintBtn } from '../lib/buttonStyles';
import { SettingsRow, type SettingsColors } from './SettingsRow';
import { useNavRolloutOn } from '../hooks/useNavRolloutOn';

interface Props { isDark: boolean; colors: SettingsColors; open: boolean; onToggle: () => void }

const NavOrderSettings: React.FC<Props> = ({ isDark, colors, open, onToggle }) => {
  const auth = useAuth();
  const { previewRole } = useContext(AuthContext);
  const fp = useFeaturePublished();
  const userId = auth.user?.id ?? null;
  const myOrder = useMyNavOrder(userId);
  const splitHome = useNavRolloutOn('split_home');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => { if (!saved) return; const t = setTimeout(() => setSaved(false), 3000); return () => clearTimeout(t); }, [saved]);
  useEffect(() => { if (!flashKey) return; const t = setTimeout(() => setFlashKey(null), 1200); return () => clearTimeout(t); }, [flashKey]);
  // 閉じたら並べ替えの途中は捨てる
  useEffect(() => { if (!open) { setEditing(false); setConfirmReset(false); } }, [open]);

  // 自分のナビに出るボタン（数字は使わないので0）
  const items: NavItem[] = useMemo(() => buildNavItems({
    canAdminOpen: auth.isAdmin, isAdmin: auth.isAdmin,
    canExpense: auth.canExpense, canTripReport: auth.canTripReport, canLeave: auth.canLeave, canCalendar: auth.canCalendar,
    canShiftReport: auth.canShiftReport, canOvertime: auth.canOvertime, canPurchaseRequest: auth.canPurchaseRequest,
    canRoomBooking: auth.canRoomBooking, canBoard: auth.canBoard, canProcedures: auth.isAdmin || auth.isManagerPlus, canFaqNav: auth.canFaqNav,
    splitHome,
    isPub: (k: string) => isFeaturePublished(k, fp, auth.isAdmin, auth.roleTitle),
    badges: { admin: 0, leave: 0, shift: 0, overtime: 0, purchase: 0, board: 0 },
  }), [auth.isAdmin, auth.isManagerPlus, auth.canExpense, auth.canTripReport, auth.canLeave, auth.canCalendar, auth.canShiftReport,
    auth.canOvertime, auth.canPurchaseRequest, auth.canRoomBooking, auth.canBoard, auth.canFaqNav, auth.roleTitle, fp, splitHome]);

  const ordered = applyNavOrder(items, (!previewRole && myOrder) || fp.navOrder);
  const isFixed = (k: string) => NAV_FIXED_FIRST.includes(k as NavItem['key']) || NAV_FIXED_LAST.includes(k as NavItem['key']);
  const movable = ordered.filter(i => !isFixed(i.key));
  const byKey = new Map(items.map(i => [i.key as string, i]));
  const listKeys = editing ? draft : movable.map(i => i.key as string);
  const summary = movable.slice(0, 2).map(i => i.label).join('・') + (movable.length > 2 ? '…' : '');

  const startEdit = () => { setDraft(movable.map(i => i.key)); setEditing(true); setErr(''); setSaved(false); setConfirmReset(false); };
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= draft.length) return;
    const next = [...draft];
    [next[idx], next[j]] = [next[j], next[idx]];
    setDraft(next); setFlashKey(next[j]);
  };
  const save = async (keys: string[] | null) => {
    if (!userId) return;
    setSaving(true); setErr(''); setSaved(false);
    const { error } = await supabase.rpc('set_my_nav_order', { p_keys: keys ?? [] });
    setSaving(false);
    if (error) { setErr('保存できませんでした：' + error.message); return; }
    setMyNavOrderLocal(userId, keys && keys.length > 0 ? keys : null);
    setSaved(true); setEditing(false); setConfirmReset(false);
  };

  const rowBase: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 2px', borderTop: `1px solid ${colors.border}`, fontSize: 14, color: colors.text };
  const arrow = (disabled: boolean): React.CSSProperties => ({
    width: 44, height: 40, borderRadius: 8, border: `1px solid ${isDark ? '#6c757d' : '#ced4da'}`, background: 'transparent',
    color: disabled ? (isDark ? '#555' : '#ced4da') : colors.text, fontSize: 13, cursor: disabled ? 'default' : 'pointer',
  });
  const fixedRow = (i: NavItem) => (
    <div key={i.key} style={{ ...rowBase, color: colors.sub }}>
      <span style={{ flex: 1 }}>{i.icon} {i.label}</span>
      <span style={{ fontSize: 12 }}>固定</span>
    </div>
  );

  return (
    <SettingsRow icon="☰" title="上のナビの並び" sub="上にあるものほど、ナビの左に出ます" value={summary} colors={colors} open={open} onToggle={onToggle}>
      {fp.navRollout.reorder.mode === 'selected' && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: colors.sub }}>この表示は試行中です。お気づきの点は管理者までお知らせください。</p>
      )}
      {previewRole && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: colors.sub }}>役職プレビュー中は、並びを保存できません（見た目は管理者が決めた並びです）。</p>
      )}

      {ordered.filter(i => NAV_FIXED_FIRST.includes(i.key)).map(fixedRow)}
      {listKeys.map((k, idx) => {
        const i = byKey.get(k);
        if (!i) return null;
        return (
          <div key={k} style={{ ...rowBase, background: flashKey === k ? (isDark ? '#1e3a5f' : '#e3f2fd') : 'transparent', transition: 'background 0.5s' }}>
            <span style={{ flex: 1 }}>
              {i.icon} {i.label}
              {myOrder && !myOrder.includes(k) && (
                <span style={{ marginLeft: 6, fontSize: 11, padding: '1px 6px', borderRadius: 8, background: isDark ? '#3d5166' : '#e3f2fd', color: isDark ? '#90caf9' : '#1565c0' }}>新しく追加</span>
              )}
            </span>
            {editing && (
              <>
                <button type="button" aria-label={`${i.label}を上へ`} disabled={idx === 0} style={arrow(idx === 0)} onClick={() => move(idx, -1)}>▲</button>
                <button type="button" aria-label={`${i.label}を下へ`} disabled={idx === listKeys.length - 1} style={arrow(idx === listKeys.length - 1)} onClick={() => move(idx, 1)}>▼</button>
              </>
            )}
          </div>
        );
      })}
      {ordered.filter(i => NAV_FIXED_LAST.includes(i.key)).map(fixedRow)}

      {err && <div style={{ marginTop: 10, fontSize: 13, color: '#dc3545' }}>{err}</div>}
      {saved && (
        <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 13, background: '#d4edda', border: '1px solid #c3e6cb', color: '#155724' }}>並びを保存しました</div>
      )}

      <div style={{ marginTop: 12 }}>
        {editing ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={{ ...backBtn(isDark), flex: 1, padding: '10px 0' }} onClick={() => setEditing(false)}>やめる</button>
            <button type="button" style={{ ...primaryBtn({ disabled: saving }), flex: 2, padding: '10px 0' }} disabled={saving}
              onClick={() => save(mergeSavedNavOrder(draft, myOrder))}>{saving ? '保存中…' : '保存'}</button>
          </div>
        ) : confirmReset ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, color: colors.text }}>
            <span>最初の並び（管理者が決めた並び）に戻します。よろしいですか？</span>
            <button type="button" style={{ ...backBtn(isDark), padding: '6px 14px' }} onClick={() => setConfirmReset(false)}>やめる</button>
            <button type="button" style={{ ...primaryBtn({ disabled: saving }), padding: '6px 14px' }} disabled={saving} onClick={() => save(null)}>戻す</button>
          </div>
        ) : !previewRole && (
          <div style={{ display: 'flex', gap: 8 }}>
            {myOrder && (
              <button type="button" style={{ ...backBtn(isDark), flex: 1, padding: '10px 0', fontSize: 13 }} onClick={() => setConfirmReset(true)}>最初の並びに戻す</button>
            )}
            <button type="button" style={{ ...tintBtn(isDark), flex: 1, padding: '10px 0', fontSize: 13 }} onClick={startEdit}>並べ替える</button>
          </div>
        )}
      </div>
    </SettingsRow>
  );
};

export default NavOrderSettings;
