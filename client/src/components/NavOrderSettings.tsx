// 「設定」の「上のナビの並び」（2026-10-17・計画 docs/計画-ナビの並び替え.md の 2b）
//
// 🚨 出すのは、管理画面の切り替え（nav_rollout.reorder）が効いている人だけ。役職プレビュー中は保存しない
//    （set_my_nav_order は auth.uid() で管理者本人の並びを書き換えてしまうため）
// 🚨 押したらすぐ保存して、上のナビにもすぐ出す（上のナビがそのまま見本になる）。保存したら薄緑のカード
// 🚨 固定の3つ（⚙️ 管理・🏠・💡 FAQ）も灰色の行で出す（全体の中での位置が分かるように）。隠す機能は作らない（ユーザー確定 A）
// 🚨 今は権限が無くて見えていないボタンの順番も、保存した並びの中に残す（lib/navItems の mergeSavedNavOrder）

import React, { useContext, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { AuthContext } from '../contexts/AuthContext.tsx';
import { useAuth, setMyNavOrderLocal } from '../hooks/useAuth';
import { useFeaturePublished, isFeaturePublished } from '../hooks/useFeaturePublished';
import { useMyNavOrder } from '../hooks/useMyNavOrder';
import {
  buildNavItems, applyNavOrder, mergeSavedNavOrder, navRolloutOn,
  NAV_FIXED_FIRST, NAV_FIXED_LAST, type NavItem,
} from '../lib/navItems';
import { backBtn, primaryBtn } from '../lib/buttonStyles';

interface Props { isDark: boolean; card: string; text: string; sub: string }

const NavOrderSettings: React.FC<Props> = ({ isDark, card, text, sub }) => {
  const auth = useAuth();
  const { previewRole, retiree, previewRetiree } = useContext(AuthContext);
  const fp = useFeaturePublished();
  const userId = auth.user?.id ?? null;
  const myOrder = useMyNavOrder(userId);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(t);
  }, [saved]);
  useEffect(() => {
    if (!flashKey) return;
    const t = setTimeout(() => setFlashKey(null), 1500);
    return () => clearTimeout(t);
  }, [flashKey]);

  const myRoleId = fp.roles.find(r => r.name === auth.roleTitle)?.id ?? null;
  const rule = fp.navRollout.reorder;
  const on = !retiree && !previewRetiree && navRolloutOn(rule, userId, myRoleId, !!previewRole);

  // 自分のナビに出るボタン（数字は使わないので0）
  const items: NavItem[] = useMemo(() => buildNavItems({
    canAdminOpen: auth.isAdmin, isAdmin: auth.isAdmin,
    canExpense: auth.canExpense, canTripReport: auth.canTripReport, canLeave: auth.canLeave, canCalendar: auth.canCalendar,
    canShiftReport: auth.canShiftReport, canOvertime: auth.canOvertime, canPurchaseRequest: auth.canPurchaseRequest,
    canRoomBooking: auth.canRoomBooking, canBoard: auth.canBoard, canProcedures: auth.isAdmin || auth.isManagerPlus, canFaqNav: auth.canFaqNav,
    isPub: (k: string) => isFeaturePublished(k, fp, auth.isAdmin, auth.roleTitle),
    badges: { admin: 0, leave: 0, shift: 0, overtime: 0, purchase: 0, board: 0 },
  }), [auth.isAdmin, auth.isManagerPlus, auth.canExpense, auth.canTripReport, auth.canLeave, auth.canCalendar, auth.canShiftReport,
    auth.canOvertime, auth.canPurchaseRequest, auth.canRoomBooking, auth.canBoard, auth.canFaqNav, auth.roleTitle, fp]);

  if (!on || !userId) return null;

  const ordered = applyNavOrder(items, myOrder || fp.navOrder);
  const isFixed = (k: string) => NAV_FIXED_FIRST.includes(k as NavItem['key']) || NAV_FIXED_LAST.includes(k as NavItem['key']);
  const movable = ordered.filter(i => !isFixed(i.key));

  const save = async (keys: string[] | null, movedKey: string | null) => {
    setSaving(true); setErr(''); setSaved(false);
    const { error } = await supabase.rpc('set_my_nav_order', { p_keys: keys ?? [] });
    setSaving(false);
    if (error) { setErr('保存できませんでした：' + error.message); return; }
    setMyNavOrderLocal(userId, keys && keys.length > 0 ? keys : null);
    setSaved(true); setFlashKey(movedKey); setConfirmReset(false);
  };
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= movable.length || saving) return;
    const next = movable.map(i => i.key as string);
    [next[idx], next[j]] = [next[j], next[idx]];
    void save(mergeSavedNavOrder(next, myOrder), movable[idx].key);
  };

  const rowBase: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderTop: `1px solid ${isDark ? '#495057' : '#eee'}`, fontSize: 14, color: text };
  const arrow = (disabled: boolean): React.CSSProperties => ({
    width: 44, height: 44, borderRadius: 8, border: `1px solid ${isDark ? '#6c757d' : '#ced4da'}`, background: 'transparent',
    color: disabled ? (isDark ? '#6c757d' : '#ced4da') : text, fontSize: 18, cursor: disabled ? 'default' : 'pointer',
  });
  const fixedRow = (i: NavItem) => (
    <div key={i.key} style={{ ...rowBase, color: sub }}>
      <span style={{ flex: 1 }}>{i.icon} {i.label}</span>
      <span style={{ fontSize: 12 }}>固定</span>
    </div>
  );

  return (
    <div style={{ background: card, borderRadius: 16, boxShadow: '0 2px 12px rgba(0,0,0,0.08)', marginTop: 12, padding: '16px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 8 }}>
        <span style={{ fontSize: 18, width: 32, textAlign: 'center', fontWeight: 700, color: text }}>並</span>
        <div style={{ flex: 1 }}>
          <p style={{ margin: '0 0 2px', fontSize: 15, fontWeight: 600, color: text }}>上のナビの並び</p>
          <p style={{ margin: 0, fontSize: 12, color: sub }}>上にあるものほど、ナビの左に出ます</p>
        </div>
      </div>
      {rule.mode === 'selected' && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: sub }}>この表示は試行中です。お気づきの点は管理者までお知らせください。</p>
      )}
      {previewRole && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: sub }}>役職プレビュー中は、並びを保存できません（見た目は管理者が決めた並びです）。</p>
      )}

      {ordered.filter(i => NAV_FIXED_FIRST.includes(i.key)).map(fixedRow)}
      {movable.map((i, idx) => (
        <div key={i.key} style={{ ...rowBase, background: flashKey === i.key ? (isDark ? '#1e3a5f' : '#e3f2fd') : 'transparent', transition: 'background 0.6s' }}>
          <span style={{ flex: 1 }}>
            {i.icon} {i.label}
            {myOrder && !myOrder.includes(i.key) && (
              <span style={{ marginLeft: 6, fontSize: 11, padding: '1px 6px', borderRadius: 8, background: isDark ? '#3d5166' : '#e3f2fd', color: isDark ? '#90caf9' : '#1565c0' }}>新しく追加</span>
            )}
          </span>
          <button type="button" aria-label={`${i.label}を上へ`} disabled={idx === 0 || saving || !!previewRole}
            style={arrow(idx === 0 || !!previewRole)} onClick={() => move(idx, -1)}>↑</button>
          <button type="button" aria-label={`${i.label}を下へ`} disabled={idx === movable.length - 1 || saving || !!previewRole}
            style={arrow(idx === movable.length - 1 || !!previewRole)} onClick={() => move(idx, 1)}>↓</button>
        </div>
      ))}
      {ordered.filter(i => NAV_FIXED_LAST.includes(i.key)).map(fixedRow)}

      {saved && (
        <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 13, background: '#d4edda', border: '1px solid #c3e6cb', color: '#155724' }}>並びを保存しました</div>
      )}
      {err && <div style={{ marginTop: 10, fontSize: 13, color: '#dc3545' }}>{err}</div>}

      {myOrder && !previewRole && (
        <div style={{ marginTop: 12 }}>
          {confirmReset ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, color: text }}>
              <span>最初の並び（管理者が決めた並び）に戻します。よろしいですか？</span>
              <button type="button" style={{ ...backBtn(isDark), padding: '6px 14px' }} onClick={() => setConfirmReset(false)}>やめる</button>
              <button type="button" style={{ ...primaryBtn({ disabled: saving }), padding: '6px 14px' }} disabled={saving} onClick={() => save(null, null)}>戻す</button>
            </div>
          ) : (
            <button type="button" style={{ ...backBtn(isDark), padding: '6px 14px', fontSize: 13 }} onClick={() => setConfirmReset(true)}>最初の並びに戻す</button>
          )}
        </div>
      )}
    </div>
  );
};

export default NavOrderSettings;
