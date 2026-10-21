// 休職の手続きのチェック表（2026-10-21・段5・計画 docs/計画-休職-段5-段6.md）。手続き（/retire）の「休職」のタブ・管理画面のタブの両方が使う
//
// 🚨 入社・退職の RetireChecklistPanel とは別の部品（あちらは「人＝profiles の1行」が前提。休職は「休職の1回＝staff_leaves の1行」で、
//    「休職に入るとき」「復職するとき」の2つの段がある）。レビューで分けると決めた
// 🚨 残りの数え方は DB の leave_checklist_overview 1本（自動の項目＝スマホの通知の希望は staff_leaves.push_asked_at で済み）。画面で数え直さない
// 🚨 スマホの通知の希望は DB の staff_leave_set_push だけを通す（本人の「設定」と同じ値）。チェックの行は作らない
// 🚨 見る・済みにする・項目の編集＝マネージャー以上と管理者（RLS も is_manager_plus()）。項目の削除・休職の修正・付け替え＝管理者だけ
// 🚨 更新・削除は 0件でもエラーにならないので件数を見る。メモは別の表（leave_notes）＝メモを書いただけで残りから消えないように
// 🚨 メモに体調・病名など休職の理由を書かせない（決まり）

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { todayJstStr, toJstDateStr } from '../lib/breakCalc';
import { mdLabel } from '../lib/retire';
import { TOGGLE_BLUE } from '../lib/buttonStyles';
import { PREHIRE_COLS } from '../lib/staffState';
import { useRoles } from '../hooks/useRoles';
import StaffLeaveModal from './admin/StaffLeaveModal';
import {
  type StaffLeave, type LeaveChecklistRow, type PendingItem,
  fetchLeaveChecklistOverview, fetchLeaveBaseKeys, fetchPendingItems, fetchOpenLeaves,
  leaveStateLabel, leaveFeatureLabels, pendingItemLabel, setLeavePush, leaveReassignCandidates,
  LEAVE_PHASE_LABEL, PUSH_CHOICE_LABEL,
} from '../lib/staffLeave';

type Phase = 'start' | 'return';
interface Item {
  id: string; phase: Phase; label: string; required: boolean; sort_order: number; active: boolean;
  choices: string[] | null; auto_key: string | null; updated_by: string | null; updated_at: string | null;
}
interface Check { id: string; leave_id: string; item_id: string | null; item_label: string | null; choice: string | null; na: boolean; done_by: string | null; done_at: string }
interface Note { id: string; leave_id: string; item_id: string | null; item_label: string | null; memo: string; updated_by: string | null; updated_at: string }
interface Person { id: string; name: string | null; email: string | null; role_title: string | null; employment_type: string | null; is_active: boolean | null; approval_status: string | null; hire_date: string | null; retired_at: string | null; retire_date: string | null }

interface Props {
  isDark: boolean;
  isAdmin: boolean;
  /** 項目の編集ができる（マネージャー以上と管理者） */
  canEditItems: boolean;
  /** お知らせから来たとき、その方を出して光らせる（user_id） */
  focusPersonId?: string | null;
}

const LeaveChecklistPanel: React.FC<Props> = ({ isDark, isAdmin, canEditItems, focusPersonId = null }) => {
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const cardBg = isDark ? '#343a40' : '#fff';
  const inputBg = isDark ? '#495057' : '#fff';
  const phaseBg = isDark ? '#2b3035' : '#f1f3f5';
  const today = todayJstStr();
  const roles = useRoles();

  const [rows, setRows] = useState<LeaveChecklistRow[]>([]);
  const [leaves, setLeaves] = useState<Map<string, StaffLeave>>(new Map());
  const [items, setItems] = useState<Item[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [baseKeys, setBaseKeys] = useState<string[] | null>(null);
  const [pending, setPending] = useState<Record<string, PendingItem[] | null>>({});
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const [undoFor, setUndoFor] = useState<string | null>(null);
  const [naFor, setNaFor] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [openReturn, setOpenReturn] = useState<Record<string, boolean>>({});
  const [showDone, setShowDone] = useState(!!focusPersonId);
  const [flashId, setFlashId] = useState<string | null>(focusPersonId);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [modalFor, setModalFor] = useState<string | null>(null);   // leave_id
  const [doneMsg, setDoneMsg] = useState('');
  // 項目の編集
  const [editItems, setEditItems] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newPhase, setNewPhase] = useState<Phase>('start');
  const [itemErr, setItemErr] = useState('');
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [editingLabelText, setEditingLabelText] = useState('');
  const [deleteItemId, setDeleteItemId] = useState<string | null>(null);
  const [pendingChange, setPendingChange] = useState<{ itemId: string; patch: Partial<Item>; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadErr('');
    const [ov, it, bk] = await Promise.all([
      fetchLeaveChecklistOverview(),
      supabase.from('leave_checklist_items').select('id, phase, label, required, sort_order, active, choices, auto_key, updated_by, updated_at').order('phase').order('sort_order'),
      fetchLeaveBaseKeys(),
    ]);
    if (ov === null || it.error) {
      setLoadErr('読み込めませんでした' + (it.error ? '：' + it.error.message : ''));
      setLoading(false);
      return;
    }
    setRows(ov);
    setItems((it.data ?? []) as Item[]);
    setBaseKeys(bk);
    const ids = [...new Set(ov.map(r => r.leave_id))];
    const [lv, ck, nt, pp] = await Promise.all([
      ids.length ? supabase.from('staff_leaves').select('*').in('id', ids) : Promise.resolve({ data: [], error: null }),
      ids.length ? supabase.from('leave_checklist_checks').select('id, leave_id, item_id, item_label, choice, na, done_by, done_at').in('leave_id', ids) : Promise.resolve({ data: [], error: null }),
      ids.length ? supabase.from('leave_notes').select('id, leave_id, item_id, item_label, memo, updated_by, updated_at').in('leave_id', ids) : Promise.resolve({ data: [], error: null }),
      supabase.from('profiles').select(`id, name, email, role_title, employment_type, ${PREHIRE_COLS}`),
    ]);
    if (lv.error || ck.error || nt.error || pp.error) {
      setLoadErr('読み込めませんでした：' + (lv.error?.message ?? ck.error?.message ?? nt.error?.message ?? pp.error?.message ?? ''));
      setLoading(false);
      return;
    }
    const lm = new Map<string, StaffLeave>();
    ((lv.data ?? []) as StaffLeave[]).forEach(l => lm.set(l.id, l));
    setLeaves(lm);
    setChecks((ck.data ?? []) as Check[]);
    setNotes((nt.data ?? []) as Note[]);
    setPeople((pp.data ?? []) as Person[]);
    // 受理待ちは終わっていない休職の方だけ（読めなければ null＝「確かめられませんでした」）
    const openUsers = [...new Set(ov.filter(r => !r.ended_at).map(r => r.user_id))];
    const pend: Record<string, PendingItem[] | null> = {};
    await Promise.all(openUsers.map(async uid => { pend[uid] = await fetchPendingItems(uid); }));
    setPending(pend);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!focusPersonId || loading) return;
    const first = rows.find(r => r.user_id === focusPersonId);
    if (first) cardRefs.current[first.leave_id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setFlashId(null), 6000);
    return () => clearTimeout(t);
  }, [focusPersonId, loading, rows]);

  const names = useMemo(() => {
    const m: Record<string, string> = {};
    people.forEach(p => { m[p.id] = p.name ?? ''; });
    return m;
  }, [people]);

  // 1つの休職を1枚のカードに（段ごとの行をまとめる）
  const cards = useMemo(() => {
    const m = new Map<string, { leave_id: string; user_id: string; name: string; rows: Partial<Record<Phase, LeaveChecklistRow>> }>();
    for (const r of rows) {
      const c = m.get(r.leave_id) ?? { leave_id: r.leave_id, user_id: r.user_id, name: r.name ?? '', rows: {} };
      c.rows[r.phase] = r;
      m.set(r.leave_id, c);
    }
    return [...m.values()];
  }, [rows]);
  const restOf = (c: typeof cards[number]) =>
    (['start', 'return'] as Phase[]).reduce((n, ph) => n + ((c.rows[ph]?.due ? c.rows[ph]?.remaining : 0) ?? 0), 0);
  // 出す方：終わっていない休職（済んでいても出す・決まり）・残りがある休職。「すべて済んだ方も表示」で終わった休職も
  const shown = cards.filter(c => showDone || !c.rows.start?.ended_at || restOf(c) > 0)
    .sort((a, b) => (restOf(b) > 0 ? 1 : 0) - (restOf(a) > 0 ? 1 : 0) || (a.rows.start?.start_date ?? '').localeCompare(b.rows.start?.start_date ?? ''));
  const hiddenDone = cards.length - cards.filter(c => !c.rows.start?.ended_at || restOf(c) > 0).length;

  const checkOf = (leaveId: string, itemId: string) => checks.find(c => c.leave_id === leaveId && c.item_id === itemId);
  const whoName = (id: string | null) => (id ? (names[id] || '（不明）') : '（不明）');
  const dayLabel = (iso: string) => mdLabel(toJstDateStr(new Date(iso)));

  const toggle = async (leaveId: string, item: Item, na = false) => {
    const key = `${leaveId}:${item.id}`;
    const cur = checkOf(leaveId, item.id);
    setBusyKey(key); setRowErr(e => ({ ...e, [leaveId]: '' })); setUndoFor(null); setNaFor(null);
    if (cur) {
      const { data, error } = await supabase.from('leave_checklist_checks').delete().eq('id', cur.id).select('id');
      if (error || !data || data.length === 0) setRowErr(e => ({ ...e, [leaveId]: '戻せませんでした' + (error ? '：' + error.message : '（権限がないか、すでに戻されています）') }));
    } else {
      const { data, error } = await supabase.from('leave_checklist_checks').insert({ leave_id: leaveId, item_id: item.id, na, item_label: item.label }).select('id');
      if (error || !data || data.length === 0) setRowErr(e => ({ ...e, [leaveId]: (na ? '対象外にできませんでした' : '済みにできませんでした') + (error ? '：' + error.message : '') }));
    }
    setBusyKey(null);
    await load();
  };

  const choosePush = async (leaveId: string, on: boolean) => {
    const key = `${leaveId}:push`;
    setBusyKey(key); setRowErr(e => ({ ...e, [leaveId]: '' }));
    const err = await setLeavePush(leaveId, on);
    if (err) setRowErr(e => ({ ...e, [leaveId]: 'スマホの通知の希望を保存できませんでした：' + err }));
    setBusyKey(null);
    await load();
  };

  // ── メモ ──
  const noteOf = (leaveId: string, itemId: string | null) =>
    notes.find(n => n.leave_id === leaveId && (itemId === null ? (n.item_id === null && n.item_label === null) : n.item_id === itemId));
  const saveNote = async (leaveId: string, itemId: string | null, itemLabel: string | null, memo: string) => {
    setNoteSaving(true); setRowErr(e => ({ ...e, [leaveId]: '' }));
    const cur = noteOf(leaveId, itemId);
    const body = memo.trim();
    const { data: { session } } = await supabase.auth.getSession();
    const me = session?.user.id ?? null;
    let fail = '';
    if (!body) {
      if (cur) {
        const { data, error } = await supabase.from('leave_notes').delete().eq('id', cur.id).select('id');
        if (error || !data || data.length === 0) fail = 'メモを消せませんでした' + (error ? '：' + error.message : '');
      }
    } else if (cur) {
      const { data, error } = await supabase.from('leave_notes').update({ memo: body, item_label: itemLabel, updated_by: me, updated_at: new Date().toISOString() }).eq('id', cur.id).select('id');
      if (error || !data || data.length === 0) fail = 'メモを保存できませんでした' + (error ? '：' + error.message : '');
    } else {
      const { data, error } = await supabase.from('leave_notes').insert({ leave_id: leaveId, item_id: itemId, item_label: itemLabel, memo: body, updated_by: me }).select('id');
      if (error || !data || data.length === 0) fail = 'メモを保存できませんでした' + (error ? '：' + error.message : '');
    }
    if (fail) setRowErr(e => ({ ...e, [leaveId]: fail }));
    setNoteFor(null); setNoteText(''); setNoteSaving(false);
    await load();
  };

  const btn = (primary: boolean): React.CSSProperties => ({
    padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
    border: primary ? 'none' : `1px solid ${border}`, background: primary ? TOGGLE_BLUE : 'transparent', color: primary ? '#fff' : text,
  });

  const renderNote = (leaveId: string, itemId: string | null, itemLabel: string | null, placeholder: string) => {
    const key = `${leaveId}:${itemId ?? 'all'}`;
    const cur = noteOf(leaveId, itemId);
    if (noteFor === key) {
      return (
        <div style={{ padding: '2px 0 8px' }}>
          <textarea value={noteText} onChange={e => setNoteText(e.target.value)} rows={2} autoFocus placeholder={placeholder}
            style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 12.5, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
          <div style={{ fontSize: 11, color: subText, margin: '2px 0 6px' }}>🚨 体調・病名など休職の理由や、パスワードは書かないでください</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" style={btn(true)} disabled={noteSaving || !noteText.trim()} onClick={() => saveNote(leaveId, itemId, itemLabel, noteText)}>保存</button>
            <button type="button" style={btn(false)} onClick={() => { setNoteFor(null); setNoteText(''); }}>やめる</button>
            {cur && <button type="button" style={{ ...btn(false), borderColor: '#dc3545', color: '#dc3545' }} disabled={noteSaving} onClick={() => saveNote(leaveId, itemId, itemLabel, '')}>メモを消す</button>}
          </div>
        </div>
      );
    }
    if (cur) {
      return (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '0 0 8px', flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 160, fontSize: 12.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: inputBg, border: `1px solid ${border}`, borderRadius: 6, padding: '6px 8px' }}>{cur.memo}</span>
          <span style={{ fontSize: 11.5, color: subText }}>{whoName(cur.updated_by)}・{dayLabel(cur.updated_at)}</span>
          <button type="button" style={btn(false)} onClick={() => { setNoteFor(key); setNoteText(cur.memo); }}>メモを直す</button>
        </div>
      );
    }
    return (
      <div style={{ padding: '0 0 6px' }}>
        <button type="button" style={{ ...btn(false), fontSize: 11.5, padding: '3px 8px', color: subText }} onClick={() => { setNoteFor(key); setNoteText(''); }}>＋ メモ</button>
      </div>
    );
  };

  // ── 項目の編集 ──
  const openLeaveIds = cards.filter(c => !c.rows.start?.ended_at).map(c => c.leave_id);
  // 必須として効くかが変わるときの影響（変わらなければ null）
  const impactMessage = (it: Item | null, phase: Phase, after: { required: boolean; active: boolean }): string | null => {
    if (it?.auto_key && !after.active) return '隠すと、ここから希望を変えられなくなります（本人の「設定」からは変えられます）。';
    const before = it ? it.active && it.required : false;
    const aft = after.active && after.required;
    if (before === aft) return null;
    const lacking = openLeaveIds.filter(id => !it || !checkOf(id, it.id));
    if (lacking.length === 0) return null;
    if (aft) return `必須にすると、手続き中の休職${lacking.length}件の残りが1件ずつ増えます。`;
    const completers = lacking.filter(id => rows.find(r => r.leave_id === id && r.phase === phase)?.remaining === 1);
    return completers.length > 0
      ? `${completers.map(id => `${cards.find(c => c.leave_id === id)?.name ?? ''}さん`).join('・')}の休職の手続き（${LEAVE_PHASE_LABEL[phase]}）がすべて完了になり、お知らせが届きます。`
      : `手続き中の休職${lacking.length}件の残りが1件ずつ減ります。`;
  };
  const updateItem = async (id: string, patch: Partial<Item>) => {
    const { data, error } = await supabase.from('leave_checklist_items').update(patch).eq('id', id).select('id');
    if (error || !data || data.length === 0) { setItemErr('保存できませんでした' + (error ? '：' + error.message : '')); return; }
    setItemErr(''); setPendingChange(null);
    await load();
  };
  const requestChange = (it: Item, patch: Partial<Item>) => {
    const msg = impactMessage(it, it.phase, { required: patch.required ?? it.required, active: patch.active ?? it.active });
    if (msg) { setItemErr(''); setPendingChange({ itemId: it.id, patch, message: msg }); return; }
    void updateItem(it.id, patch);
  };
  const addItem = async (confirmed = false) => {
    const label = newLabel.trim();
    if (!label) { setItemErr('項目の名前を入れてください'); return; }
    const msg = impactMessage(null, newPhase, { required: true, active: true });
    if (msg && !confirmed) { setPendingChange({ itemId: 'new', patch: { label, phase: newPhase }, message: msg }); return; }
    const maxOrder = items.filter(i => i.phase === newPhase).reduce((m, i) => Math.max(m, i.sort_order), 0);
    const { error } = await supabase.from('leave_checklist_items').insert({ phase: newPhase, label, required: true, sort_order: maxOrder + 10 });
    if (error) { setItemErr('追加できませんでした：' + error.message); return; }
    setNewLabel(''); setItemErr(''); setPendingChange(null);
    await load();
  };
  const deleteItem = async (id: string) => {
    const { data, error } = await supabase.from('leave_checklist_items').delete().eq('id', id).select('id');
    if (error || !data || data.length === 0) { setItemErr('削除できませんでした' + (error ? '：' + error.message : '（権限がないか、すでに消えています）')); return; }
    setDeleteItemId(null); setItemErr('');
    await load();
  };
  const moveItem = async (list: Item[], idx: number, dir: -1 | 1) => {
    const a = list[idx]; const b = list[idx + dir];
    if (!a || !b) return;
    await updateItem(a.id, { sort_order: b.sort_order });
    await updateItem(b.id, { sort_order: a.sort_order });
  };

  if (loading && cards.length === 0 && items.length === 0) return <p style={{ color: subText, fontSize: 13 }}>読み込み中…</p>;

  const modalLeave = modalFor ? leaves.get(modalFor) ?? null : null;
  const modalPerson = modalLeave ? people.find(p => p.id === modalLeave.user_id) : undefined;

  return (
    <div style={{ color: text, textAlign: 'left' }}>
      <div style={{ background: isDark ? '#243447' : '#e8f4fd', border: `1px solid ${isDark ? '#3d5166' : '#90caf9'}`, borderRadius: 8, padding: '10px 14px', fontSize: 13, lineHeight: 1.8, marginBottom: 14 }}>
        休職に入る方・復職する方の手続きを、漏れなく済ませるための表です。マネージャー以上と管理者が「済み」にできます（誰がいつ済みにしたかが残ります）。<br />
        休職は管理画面の「ユーザー」で管理者が登録します。休職の初日・復職日の7日前・3日前・前日・当日の朝に、残っている手続きがあればマネージャー以上と管理者へお知らせが届きます。<br />
        「復職するとき」の手続きは、復職日の7日前から残りとして数えます。
      </div>

      {doneMsg && <div style={{ padding: '9px 12px', borderRadius: 8, fontSize: 13, background: '#f0fdf4', border: '1px solid #86efac', color: '#166534', marginBottom: 10 }}>✓ {doneMsg}</div>}
      {loadErr && <div style={{ padding: '9px 12px', borderRadius: 8, fontSize: 12.5, background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029', marginBottom: 10 }}>{loadErr}</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12.5, color: subText, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} />
          復職して手続きがすべて済んだ方も表示（{hiddenDone}人）
        </label>
        {canEditItems && (
          <button type="button" style={{ ...btn(false), marginLeft: 'auto' }} onClick={() => setEditItems(v => !v)}>{editItems ? '項目の編集を閉じる' : '項目を編集する'}</button>
        )}
      </div>

      {canEditItems && editItems && (
        <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 8, padding: 12, marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 6 }}>チェック項目（マネージャー以上と管理者が編集できます）</div>
          {(['start', 'return'] as Phase[]).map(ph => {
            const list = items.filter(i => i.phase === ph);
            return (
              <div key={ph} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12.5, fontWeight: 'bold', background: phaseBg, padding: '3px 8px', borderRadius: 6 }}>{LEAVE_PHASE_LABEL[ph]}</div>
                {list.map((it, idx) => (
                  <div key={it.id} style={{ borderBottom: `1px solid ${border}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 0', opacity: it.active ? 1 : 0.5, flexWrap: 'wrap' }}>
                      {editingLabelId === it.id ? (
                        <>
                          <input value={editingLabelText} onChange={e => setEditingLabelText(e.target.value)} autoFocus
                            style={{ flex: 1, minWidth: 160, padding: '6px 8px', borderRadius: 6, border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 13 }} />
                          <button type="button" style={btn(true)} disabled={!editingLabelText.trim()}
                            onClick={async () => { const label = editingLabelText.trim(); if (label && label !== it.label) await updateItem(it.id, { label }); setEditingLabelId(null); }}>保存</button>
                          <button type="button" style={btn(false)} onClick={() => setEditingLabelId(null)}>やめる</button>
                        </>
                      ) : (
                        <>
                          <span style={{ flex: 1, minWidth: 160, fontSize: 13 }}>
                            {it.label}{it.auto_key && <span style={{ color: subText, fontSize: 11.5, marginLeft: 6 }}>（設定とつながっています）</span>}
                          </span>
                          <button type="button" style={btn(false)} onClick={() => { setItemErr(''); setEditingLabelId(it.id); setEditingLabelText(it.label); }}>修正</button>
                          <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 3 }}>
                            <input type="checkbox" checked={it.required} onChange={e => requestChange(it, { required: e.target.checked })} />必須
                          </label>
                          <button type="button" style={btn(false)} disabled={idx === 0} onClick={() => moveItem(list, idx, -1)}>↑</button>
                          <button type="button" style={btn(false)} disabled={idx === list.length - 1} onClick={() => moveItem(list, idx, 1)}>↓</button>
                          <button type="button" style={btn(false)} onClick={() => requestChange(it, { active: !it.active })}>{it.active ? '隠す' : '戻す'}</button>
                          {isAdmin && !it.auto_key && (
                            <button type="button" style={{ ...btn(false), borderColor: '#dc3545', color: '#dc3545', marginLeft: 'auto' }} onClick={() => { setItemErr(''); setDeleteItemId(it.id); }}>削除</button>
                          )}
                        </>
                      )}
                    </div>
                    {pendingChange && pendingChange.itemId === it.id && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '0 0 8px', fontSize: 12.5 }}>
                        <span>{pendingChange.message}よろしいですか？</span>
                        <button type="button" style={btn(false)} onClick={() => setPendingChange(null)}>やめる</button>
                        <button type="button" style={btn(true)} onClick={() => updateItem(it.id, pendingChange.patch)}>変更する</button>
                      </div>
                    )}
                    {deleteItemId === it.id && (() => {
                      const used = checks.filter(c => c.item_id === it.id).length;
                      return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '0 0 8px', fontSize: 12.5 }}>
                          <span>「{it.label}」を削除しますか？{used > 0 ? `すでに済み・対象外にした記録が ${used} 件ありますが、「削除された項目」として残ります。` : 'まだ一度も使われていません。'}</span>
                          <button type="button" style={btn(false)} onClick={() => setDeleteItemId(null)}>やめる</button>
                          <button type="button" style={{ ...btn(false), borderColor: '#dc3545', color: '#dc3545' }} onClick={() => deleteItem(it.id)}>削除する</button>
                        </div>
                      );
                    })()}
                  </div>
                ))}
              </div>
            );
          })}
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <select value={newPhase} onChange={e => setNewPhase(e.target.value as Phase)}
              style={{ padding: '6px 8px', borderRadius: 6, border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 13 }}>
              <option value="start">休職に入るとき</option>
              <option value="return">復職するとき</option>
            </select>
            <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="新しい項目"
              style={{ flex: 1, minWidth: 160, padding: '6px 8px', borderRadius: 6, border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 13 }} />
            <button type="button" style={btn(true)} onClick={() => void addItem()}>追加</button>
          </div>
          {pendingChange && pendingChange.itemId === 'new' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6, fontSize: 12.5 }}>
              <span>「{pendingChange.patch.label}」を必須で追加します。{pendingChange.message}よろしいですか？</span>
              <button type="button" style={btn(false)} onClick={() => setPendingChange(null)}>やめる</button>
              <button type="button" style={btn(true)} onClick={() => void addItem(true)}>追加する</button>
            </div>
          )}
          {itemErr && <div style={{ color: '#dc3545', fontSize: 12, marginTop: 6 }}>{itemErr}</div>}
          <div style={{ fontSize: 11.5, color: subText, marginTop: 6 }}>※［隠す］は一覧に出さないだけです。もう使わない項目は［削除］してください</div>
        </div>
      )}

      {shown.length === 0 && !loadErr && (
        <p style={{ fontSize: 13, color: subText, textAlign: 'center', margin: '20px 0' }}>{cards.length === 0 ? '休職の予定・休職中の方はいません' : '残っている手続きはありません'}</p>
      )}

      {shown.map(c => {
        const l = leaves.get(c.leave_id);
        const st = c.rows.start;
        const rest = restOf(c);
        const ended = !!st?.ended_at;
        const stateText = l ? (leaveStateLabel(l, today) ?? (ended && st?.return_base ? `復職済み（${mdLabel(st.return_base)}）` : '')) : '';
        const keys = baseKeys === null || !l ? null
          : [...new Set([...baseKeys, ...l.features_add])].filter(k => !l.features_remove.includes(k));
        const pend = pending[c.user_id];
        return (
          <div key={c.leave_id} ref={el => { cardRefs.current[c.leave_id] = el; }}
            style={{ background: flashId === c.user_id ? (isDark ? '#1e3a5f' : '#e3f2fd') : cardBg, border: flashId === c.user_id ? `2px solid ${TOGGLE_BLUE}` : `1px solid ${rest > 0 ? '#f59e0b' : border}`, borderRadius: 10, padding: '12px 14px', marginBottom: 12, transition: 'background 0.6s' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
              <span style={{ fontSize: 15, fontWeight: 'bold' }}>{c.name}さん</span>
              <span style={{ fontSize: 12, color: subText }}>{stateText}{st ? `・休職の初日 ${mdLabel(st.start_date)}` : ''}</span>
            </div>
            {isAdmin && !ended && l && (
              <div style={{ textAlign: 'right', marginBottom: 4 }}>
                <button type="button" style={btn(false)} onClick={() => { setDoneMsg(''); setModalFor(c.leave_id); }}>休職を修正</button>
              </div>
            )}
            {keys && <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>使える機能：{leaveFeatureLabels(keys).join('・') || 'ホーム・設定'}</div>}

            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 11.5, color: subText, marginBottom: 3 }}>この方ぜんたいのメモ</div>
              {renderNote(c.leave_id, null, null, '例：書類は郵送で受け取る')}
            </div>

            {(['start', 'return'] as Phase[]).map(ph => {
              const r = c.rows[ph];
              if (!r) return null;
              const list = items.filter(i => i.phase === ph && i.active);
              const isReturn = ph === 'return';
              const open = !isReturn || r.due || openReturn[c.leave_id];
              const right = isReturn && !r.due
                ? (r.return_base ? `${mdLabel(addDays(r.return_base, -7))} から進めます` : '復職日が決まってから進めます')
                : r.remaining > 0 ? `必須が残り ${r.remaining} 件` : '✓ 必須はすべて済み';
              const rightColor = isReturn && !r.due ? subText : r.remaining > 0 ? (isDark ? '#ffc107' : '#b35900') : (isDark ? '#5cb85c' : '#1e7e34');
              return (
                <div key={ph} style={{ marginTop: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, background: phaseBg, padding: '4px 8px', borderRadius: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 'bold' }}>{LEAVE_PHASE_LABEL[ph]}</span>
                    <span style={{ fontSize: 12.5, fontWeight: 'bold', color: rightColor }}>{right}</span>
                  </div>
                  {!open ? (
                    <button type="button" onClick={() => setOpenReturn(o => ({ ...o, [c.leave_id]: true }))}
                      style={{ background: 'none', border: 'none', padding: '6px 2px', cursor: 'pointer', color: isDark ? '#90caf9' : '#0d6efd', fontSize: 12.5 }}>▸ 項目{list.length}件を見る</button>
                  ) : list.map(it => {
                    const key = `${c.leave_id}:${it.id}`;
                    if (it.auto_key === 'push' && l) {
                      const asked = !!l.push_asked_at;
                      const byLabel = !asked ? '' : l.push_asked_by === l.user_id ? `本人が設定で変更・${dayLabel(l.push_asked_at!)}` : `${whoName(l.push_asked_by)}さんが確認・${dayLabel(l.push_asked_at!)}`;
                      const cur = l.push_on ? PUSH_CHOICE_LABEL.on : PUSH_CHOICE_LABEL.off;
                      const busy = busyKey === `${c.leave_id}:push`;
                      const choice = (on: boolean) => {
                        const selected = asked && l.push_on === on;
                        return (
                          <button key={String(on)} type="button" disabled={busy || ended} aria-pressed={selected}
                            onClick={() => void choosePush(c.leave_id, on)}
                            style={{ flex: 1, minHeight: 44, borderRadius: 8, fontSize: 13, cursor: busy || ended ? 'default' : 'pointer',
                              border: `1px solid ${selected ? TOGGLE_BLUE : (isDark ? '#6c757d' : '#adb5bd')}`, background: selected ? TOGGLE_BLUE : (isDark ? '#2b3035' : '#fff'), color: selected ? '#fff' : text }}>
                            {on ? PUSH_CHOICE_LABEL.on : PUSH_CHOICE_LABEL.off}
                          </button>
                        );
                      };
                      return (
                        <div key={it.id} style={{ borderTop: `1px solid ${border}`, padding: '8px 2px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <CheckBox done={asked} border={border} />
                            <span style={{ fontSize: 13.5 }}>{it.label}{!it.required && <span style={{ color: subText, fontSize: 11, marginLeft: 6 }}>（任意）</span>}</span>
                          </div>
                          <div style={{ fontSize: 12, color: subText, margin: '4px 0 6px 34px' }}>
                            {asked ? `${cur}（${byLabel}）` : `今：${cur}（初めのまま・まだ確認していません）`}
                          </div>
                          <div style={{ display: 'flex', gap: 8, marginLeft: 34, flexWrap: 'wrap' }}>{choice(true)}{choice(false)}</div>
                        </div>
                      );
                    }
                    const ck = checkOf(c.leave_id, it.id);
                    return (
                      <div key={it.id} style={{ borderTop: `1px solid ${border}` }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <button type="button" disabled={busyKey === key} aria-pressed={!!ck}
                            onClick={() => (ck ? setUndoFor(key) : void toggle(c.leave_id, it))}
                            style={{ flex: 1, minHeight: 44, display: 'flex', alignItems: 'center', gap: 10, padding: '6px 2px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', color: text, flexWrap: 'wrap' }}>
                            <CheckBox done={!!ck && !ck.na} na={!!ck?.na} border={border} subText={subText} />
                            <span style={{ flex: 1, minWidth: 150, fontSize: 13.5, color: ck ? subText : text, textDecoration: ck && !ck.na ? 'line-through' : 'none' }}>
                              {ck?.item_label ?? it.label}
                              {ck?.na && <span style={{ color: subText, fontSize: 11.5, marginLeft: 6 }}>（対象外）</span>}
                              {!it.required && <span style={{ color: subText, fontSize: 11, marginLeft: 6 }}>（任意）</span>}
                            </span>
                            {ck && <span style={{ fontSize: 11.5, color: subText }}>{whoName(ck.done_by)}・{dayLabel(ck.done_at)}</span>}
                          </button>
                          {!ck && naFor !== key && (
                            <button type="button" disabled={busyKey === key} onClick={() => { setUndoFor(null); setNaFor(key); }}
                              style={{ ...btn(false), flexShrink: 0, fontSize: 11.5, padding: '4px 8px', color: subText }}>対象外</button>
                          )}
                        </div>
                        {naFor === key && !ck && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '0 10px 10px', fontSize: 12.5 }}>
                            <span>{c.name}さんには無い項目として「対象外」にしますか？（必須の残りから外れます）</span>
                            <button type="button" style={btn(false)} onClick={() => setNaFor(null)}>やめる</button>
                            <button type="button" style={btn(false)} onClick={() => void toggle(c.leave_id, it, true)}>対象外にする</button>
                          </div>
                        )}
                        {undoFor === key && ck && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '6px 10px 10px', fontSize: 12.5 }}>
                            <span>{whoName(ck.done_by)}さんの{ck.na ? '「対象外」の' : ''}記録（{dayLabel(ck.done_at)}）を消して、未済に戻しますか？</span>
                            <button type="button" style={btn(false)} onClick={() => setUndoFor(null)}>やめる</button>
                            <button type="button" style={{ ...btn(false), borderColor: '#dc3545', color: '#dc3545' }} onClick={() => void toggle(c.leave_id, it)}>戻す</button>
                          </div>
                        )}
                        {renderNote(c.leave_id, it.id, it.label, '例：書類は郵送で受け取る')}
                      </div>
                    );
                  })}
                  {/* この方が対応する予定の申請（休職に入るときの段の下・終わっていない休職だけ） */}
                  {ph === 'start' && !ended && (
                    <div style={{ background: isDark ? '#3d3520' : '#fff8e1', border: `1px solid ${isDark ? '#8a6d1f' : '#ffe08a'}`, borderRadius: 8, padding: '8px 10px', margin: '10px 0 2px', color: isDark ? '#ffd54f' : '#8a5a00' }}>
                      {pend === undefined ? <div style={{ fontSize: 12.5 }}>読み込み中…</div>
                        : pend === null ? <div style={{ fontSize: 12.5 }}>この方が対応する予定の申請は、確かめられませんでした。</div>
                        : pend.length === 0 ? <div style={{ fontSize: 12.5 }}>この方が対応する予定の申請はありません。</div>
                        : (<>
                          <div style={{ fontSize: 13, fontWeight: 'bold' }}>この方が対応する予定の申請（{pend.length}件）</div>
                          <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>{pend.map((it, i) => <div key={i}>・{pendingItemLabel(it)}</div>)}</div>
                          {isAdmin && l ? (
                            <div style={{ textAlign: 'right', marginTop: 4 }}>
                              <button type="button" style={btn(true)} onClick={() => { setDoneMsg(''); setModalFor(c.leave_id); }}>付け替える</button>
                            </div>
                          ) : <div style={{ fontSize: 11.5, marginTop: 4 }}>※付け替えは管理者が行います</div>}
                        </>)}
                    </div>
                  )}
                </div>
              );
            })}

            {(() => {
              const gone = checks.filter(k => k.leave_id === c.leave_id && k.item_id === null);
              if (gone.length === 0) return null;
              return (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${border}` }}>
                  <div style={{ fontSize: 11.5, color: subText, marginBottom: 4 }}>削除された項目の記録</div>
                  {gone.map(k => (
                    <div key={k.id} style={{ fontSize: 12.5, color: subText, padding: '2px 0' }}>
                      {k.na ? '—' : '✓'} {k.item_label || '（名前が分かりません）'}{k.na && '（対象外）'}・{whoName(k.done_by)}・{dayLabel(k.done_at)}
                    </div>
                  ))}
                </div>
              );
            })()}
            {rowErr[c.leave_id] && <div style={{ color: '#dc3545', fontSize: 12, marginTop: 6 }}>{rowErr[c.leave_id]}</div>}
          </div>
        );
      })}

      {modalFor && modalLeave && modalPerson && (
        <LeaveModalHost isDark={isDark} leave={modalLeave} person={modalPerson} people={people} roles={roles} today={today}
          onClose={() => setModalFor(null)}
          onDone={(msg, isError) => { setModalFor(null); if (isError) setRowErr(e => ({ ...e, [modalLeave.id]: msg })); else setDoneMsg(msg); void load(); }} />
      )}
    </div>
  );
};

// 休職の修正・付け替えの窓（ユーザー一覧と同じ StaffLeaveModal）。候補の決め方は lib/staffLeave の leaveReassignCandidates 1か所
const LeaveModalHost: React.FC<{
  isDark: boolean; leave: StaffLeave; person: Person; people: Person[]; roles: ReturnType<typeof useRoles>; today: string;
  onClose: () => void; onDone: (msg: string, isError?: boolean) => void;
}> = ({ isDark, leave, person, people, roles, today, onClose, onDone }) => {
  const [open, setOpen] = useState<Map<string, StaffLeave> | null>(null);
  useEffect(() => { void fetchOpenLeaves().then(setOpen); }, []);
  if (!open) return null;
  return (
    <StaffLeaveModal
      isDark={isDark}
      user={{ id: person.id, name: person.name || person.email || '', sub: [person.employment_type, person.role_title].filter(Boolean).join('・') }}
      leave={leave}
      candidates={leaveReassignCandidates(people, open, roles, person.id, today)}
      todayJst={today}
      onClose={onClose}
      onDone={onDone}
    />
  );
};

const CheckBox: React.FC<{ done: boolean; na?: boolean; border: string; subText?: string }> = ({ done, na, border, subText }) => (
  <span aria-hidden style={{ width: 24, height: 24, flexShrink: 0, borderRadius: 6, fontSize: 14, lineHeight: '20px', textAlign: 'center', boxSizing: 'border-box',
    border: `2px solid ${done ? '#1e7e34' : border}`, background: done ? '#1e7e34' : 'transparent', color: na ? subText : '#fff' }}>{done ? '✓' : na ? '—' : ''}</span>
);

function addDays(ymd: string, n: number): string {
  return new Date(new Date(ymd + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
}

export default LeaveChecklistPanel;
