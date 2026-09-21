// 退職の手続きのチェック表（2026-09-19・1段目）。設計は docs/計画-退職者の申請期間.md §6・§7-5
//
// 🚨 この部品1つを「管理画面のタブ」と「/retire（マネージャー以上・スマホ可）」の両方が使う（2か所に書かない）
// 🚨 見る・済みにする＝マネージャー以上＋管理者（RLS も is_manager_plus()）。項目の編集は管理者だけ
// 🚨 行がある＝済み。退職日を取り消すと DB（retire_cancel）が消す／アカウントを削除すると一緒に消える
// 🚨 更新・削除は 0件でもエラーにならないので、件数を見る
// 🚨 メモは**別の表**（retire_notes・2026-09-22）。チェックの記録に混ぜると
//    「メモを書いただけで必須の残りから消える」事故になる（数え方が「行があれば片付いた」のため）

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { todayJstStr, toJstDateStr } from '../lib/breakCalc';
import { retireState, retireStateLabel, mdLabel, retireRemaining, REASSIGN_TABLE_LABEL } from '../lib/retire';

interface Item {
  /** 択一で答える項目の選択肢（null＝ふつうのチェック）。🚨 自由記述にはしない（パスワードを書かれないため） */
  choices?: string[] | null;
  id: string; label: string; required: boolean; sort_order: number; active: boolean;
}
interface Person {
  id: string; name: string | null; is_active: boolean | null; approval_status: string | null;
  retire_date: string; retiree_access_until: string | null;
}
interface Check {
  /** 択一の項目で選んだ答え */
  choice?: string | null;
  /** その人にはこの項目が無い（対象外）。false＝済み。🚨 どちらも残り件数からは外れる */
  na?: boolean | null;
  /** チェックした時点の項目名の写し。🚨 項目の文字をあとから直しても、記録はこの文字のまま */
  item_label?: string | null;
  /** 🚨 null＝その項目は削除された（記録は item_label の文字で残る） */
  id: string; user_id: string; item_id: string | null; done_by: string | null; done_at: string;
}
interface Reassign { retired_user_id: string; table_name: string }
/**
 * 手続きのメモ。🚨 チェックの記録とは別の表（retire_notes）。
 *  ・item_id あり              … その項目のメモ
 *  ・item_id なし・item_label あり … 削除された項目のメモ（中身を残すため）
 *  ・item_id なし・item_label なし … その方ぜんたいの申し送り
 */
interface Note {
  id: string; user_id: string; item_id: string | null; item_label: string | null;
  memo: string; updated_by: string | null; updated_at: string;
}

interface Props {
  isDark: boolean;
  /** 管理者なら項目の編集ができる */
  isAdmin: boolean;
}

const RetireChecklistPanel: React.FC<Props> = ({ isDark, isAdmin }) => {
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const cardBg = isDark ? '#343a40' : '#fff';
  const inputBg = isDark ? '#495057' : '#fff';

  const [items, setItems] = useState<Item[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [reassigns, setReassigns] = useState<Reassign[]>([]);
  // 退職者が承認者のまま残っている購入申請の件数（人ごと）。🚨 DB の retire_purchase_pending で数える
  //    （画面から直接読むと RLS で自分が関わる行しか見えず、静かに0件になる・2026-09-19 レビュー）。null＝数えられなかった
  const [purchaseLeft, setPurchaseLeft] = useState<Record<string, number | null>>({});
  // 済みを戻す前のその場の確認（押し間違いで「誰が・いつ」が消えないように）
  const [undoFor, setUndoFor] = useState<string | null>(null);
  // 択一の項目で、いま選択肢を開いている行
  const [choosingFor, setChoosingFor] = useState<string | null>(null);
  // 「対象外」にする前のその場の確認（誤って押すと、必須の項目が静かに残りから消えるため）
  const [naFor, setNaFor] = useState<string | null>(null);
  // ── メモ（2026-09-22）───────────────────────────────
  // 🚨 チェックの記録とは**別の表**（retire_notes）。同じ表に入れると
  //    「メモを書いただけで必須の残りから消える」事故になる（数え方が「行があれば片付いた」のため）
  // 🚨 未済でも書ける（「離職票は9月分が必要」など、やる前に書いておきたいことがあるため）
  const [notes,       setNotes]       = useState<Note[]>([]);
  // いまメモを書いている行。key は `${userId}:${itemId ?? 'all'}`
  const [noteFor,     setNoteFor]     = useState<string | null>(null);
  const [noteText,    setNoteText]    = useState('');
  const [noteSaving,  setNoteSaving]  = useState(false);
  const namesLoaded = useRef(false);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const [showDone, setShowDone] = useState(false);
  // 項目の編集（管理者）
  const [editItems, setEditItems] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [itemErr, setItemErr] = useState('');
  // 項目の文字を直す（2026-09-21）。🚨 「修正 → 保存」の2段にする。
  //    打っている途中や欄から離れたときに保存すると、「直したつもりが保存されていない」
  //    「見ていただけのつもりで変わった」の両方が起きる（スタッフ設定で同じ整理をしている）
  const [editingLabelId,   setEditingLabelId]   = useState<string | null>(null);
  const [editingLabelText, setEditingLabelText] = useState('');
  // 項目の削除の確認。🚨 消しても済み・対象外の記録は残る（item_id が null になるだけ）
  const [deleteItemId,     setDeleteItemId]     = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadErr('');
    const [it, pp] = await Promise.all([
      supabase.from('retire_checklist_items').select('id, label, required, sort_order, active, choices').order('sort_order'),
      supabase.from('profiles').select('id, name, is_active, approval_status, retire_date, retiree_access_until')
        .not('retire_date', 'is', null).order('retire_date', { ascending: false }),
    ]);
    if (it.error || pp.error) {
      setLoadErr('読み込めませんでした：' + (it.error?.message ?? pp.error?.message ?? ''));
      setLoading(false);
      return;
    }
    const ps = (pp.data ?? []) as Person[];
    setItems((it.data ?? []) as Item[]);
    setPeople(ps);
    const ids = ps.map(p => p.id);
    if (ids.length === 0) { setChecks([]); setReassigns([]); setNotes([]); setPurchaseLeft({}); setLoading(false); return; }
    const [ck, ra, nt, nm, ...pcs] = await Promise.all([
      supabase.from('retire_checklist_checks').select('id, user_id, item_id, done_by, done_at, choice, na, item_label').in('user_id', ids),
      supabase.from('retire_reassignments').select('retired_user_id, table_name').in('retired_user_id', ids),
      supabase.from('retire_notes').select('id, user_id, item_id, item_label, memo, updated_by, updated_at').in('user_id', ids),
      // 「済みにした人」の名前は最初に1回だけ読む（押すたびに全員分を読み直さない）
      namesLoaded.current ? Promise.resolve(null) : supabase.from('profiles').select('id, name'),
      ...ids.map(id => supabase.rpc('retire_purchase_pending', { p_user: id })),
    ]);
    if (ck.error || ra.error || nt.error) {
      setLoadErr('読み込めませんでした：' + (ck.error?.message ?? ra.error?.message ?? nt.error?.message ?? ''));
      setLoading(false);
      return;
    }
    setChecks((ck.data ?? []) as Check[]);
    setReassigns((ra.data ?? []) as Reassign[]);
    setNotes((nt.data ?? []) as Note[]);
    // 数えられなかったときは null（「0件」と言わない）
    const pl: Record<string, number | null> = {};
    ids.forEach((id, i) => { const r = pcs[i] as { data: unknown; error: unknown }; pl[id] = r.error || typeof r.data !== 'number' ? null : r.data; });
    setPurchaseLeft(pl);
    if (nm && !nm.error) {
      const m: Record<string, string> = {};
      ((nm.data ?? []) as { id: string; name: string | null }[]).forEach(r => { m[r.id] = r.name ?? ''; });
      setNames(m);
      namesLoaded.current = true;
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const today = todayJstStr();
  const activeItems = useMemo(() => items.filter(i => i.active), [items]);
  const checkOf = useCallback((userId: string, itemId: string) =>
    checks.find(c => c.user_id === userId && c.item_id === itemId), [checks]);
  const remainingOf = useCallback((userId: string) => retireRemaining(items, checks, userId), [items, checks]);

  const shownPeople = useMemo(() => {
    const list = people.filter(p => showDone || remainingOf(p.id) > 0);
    // 必須が残っている人を先に、その中は退職日の近い順
    return [...list].sort((a, b) => (remainingOf(b.id) > 0 ? 1 : 0) - (remainingOf(a.id) > 0 ? 1 : 0) || a.retire_date.localeCompare(b.retire_date));
  }, [people, showDone, remainingOf]);
  const doneCount = people.filter(p => remainingOf(p.id) === 0).length;

  // 済み・対象外にする／戻す。🚨 na=true が「対象外」。どちらも行を作るので、残り件数の数え方は同じ
  const toggle = async (userId: string, item: Item, choice?: string, na = false) => {
    const key = `${userId}:${item.id}`;
    const cur = checkOf(userId, item.id);
    setBusyKey(key); setRowErr(e => ({ ...e, [userId]: '' })); setUndoFor(null); setNaFor(null);
    if (cur) {
      const { data, error } = await supabase.from('retire_checklist_checks').delete().eq('id', cur.id).select('id');
      if (error || !data || data.length === 0) {
        setRowErr(e => ({ ...e, [userId]: '戻せませんでした' + (error ? '：' + error.message : '（権限がないか、すでに戻されています）') }));
      }
    } else {
      // 🚨 item_label＝いま画面に出ている文字を写す。これがあるので、あとで項目を直しても消しても
      //    この記録の読まれ方は変わらない（チェック表は「手続きをやった証拠」なので書き換わってはいけない）
      const { data, error } = await supabase.from('retire_checklist_checks')
        .insert({ user_id: userId, item_id: item.id, choice: choice ?? null, na, item_label: item.label }).select('id');
      if (error || !data || data.length === 0) {
        setRowErr(e => ({ ...e, [userId]: (na ? '対象外にできませんでした' : '済みにできませんでした') + (error ? '：' + error.message : '') }));
      }
    }
    setBusyKey(null);
    await load();
  };

  // ── 項目の編集（管理者）──
  const addItem = async () => {
    const label = newLabel.trim();
    if (!label) { setItemErr('項目の名前を入れてください'); return; }
    const maxOrder = items.reduce((m, i) => Math.max(m, i.sort_order), 0);
    const { error } = await supabase.from('retire_checklist_items').insert({ label, required: true, sort_order: maxOrder + 10 });
    if (error) { setItemErr('追加できませんでした：' + error.message); return; }
    setNewLabel(''); setItemErr('');
    await load();
  };
  const updateItem = async (id: string, patch: Partial<Item>) => {
    const { data, error } = await supabase.from('retire_checklist_items').update(patch).eq('id', id).select('id');
    if (error || !data || data.length === 0) { setItemErr('保存できませんでした' + (error ? '：' + error.message : '')); return; }
    setItemErr('');
    await load();
  };
  // ── メモ ──
  // 🚨 itemId が null＝その方ぜんたいのメモ。項目ごとのメモと同じ表・同じ処理で扱う
  const noteOf = (userId: string, itemId: string | null) =>
    notes.find(n => n.user_id === userId
      && (itemId === null ? (n.item_id === null && n.item_label === null) : n.item_id === itemId));

  // 空にして保存したら消す。🚨 更新・削除は0件でもエラーにならないので必ず件数を見る
  const saveNote = async (userId: string, itemId: string | null, itemLabel: string | null, memo: string) => {
    setNoteSaving(true); setRowErr(e => ({ ...e, [userId]: '' }));
    const cur = noteOf(userId, itemId);
    const body = memo.trim();
    // 🚨 更新のときは updated_by を自分で入れる（列の既定値が効くのは insert のときだけ。
    //    入れないと RLS の「誰が直したかを必ず残す」条件に引っかかって0件になる）
    const { data: { session } } = await supabase.auth.getSession();
    const me = session?.user.id ?? null;
    if (!body) {
      if (cur) {
        const { data, error } = await supabase.from('retire_notes').delete().eq('id', cur.id).select('id');
        if (error || !data || data.length === 0) {
          setRowErr(e => ({ ...e, [userId]: 'メモを消せませんでした' + (error ? '：' + error.message : '（権限がないか、すでに消えています）') }));
        }
      }
    } else if (cur) {
      const { data, error } = await supabase.from('retire_notes')
        .update({ memo: body, item_label: itemLabel, updated_by: me, updated_at: new Date().toISOString() })
        .eq('id', cur.id).select('id');
      if (error || !data || data.length === 0) {
        setRowErr(e => ({ ...e, [userId]: 'メモを保存できませんでした' + (error ? '：' + error.message : '') }));
      }
    } else {
      const { data, error } = await supabase.from('retire_notes')
        .insert({ user_id: userId, item_id: itemId, item_label: itemLabel, memo: body, updated_by: me }).select('id');
      if (error || !data || data.length === 0) {
        setRowErr(e => ({ ...e, [userId]: 'メモを保存できませんでした' + (error ? '：' + error.message : '') }));
      }
    }
    setNoteFor(null); setNoteText(''); setNoteSaving(false);
    await load();
  };

  // 項目を消す。🚨 済み・対象外の記録は消えない（DB の外部キーが on delete set null。
  //    記録は写した文字で「削除された項目」として残る）
  const deleteItem = async (id: string) => {
    const { data, error } = await supabase.from('retire_checklist_items').delete().eq('id', id).select('id');
    if (error || !data || data.length === 0) {
      setItemErr('削除できませんでした' + (error ? '：' + error.message : '（権限がないか、すでに消えています）'));
      return;
    }
    setDeleteItemId(null); setItemErr('');
    await load();
  };
  const moveItem = async (idx: number, dir: -1 | 1) => {
    const a = items[idx]; const b = items[idx + dir];
    if (!a || !b) return;
    await updateItem(a.id, { sort_order: b.sort_order });
    await updateItem(b.id, { sort_order: a.sort_order });
  };

  const btn = (primary: boolean): React.CSSProperties => ({
    padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
    border: primary ? 'none' : `1px solid ${border}`,
    background: primary ? '#1976d2' : 'transparent',
    color: primary ? '#fff' : text,
  });

  // メモの枠。🚨 「項目ごと」と「その方ぜんたい」の**両方がこれを使う**（同じ見た目を2か所に書かない）
  const renderNote = (userId: string, itemId: string | null, itemLabel: string | null, placeholder: string) => {
    const key = `${userId}:${itemId ?? 'all'}`;
    const cur = noteOf(userId, itemId);
    if (noteFor === key) {
      return (
        <div style={{ padding: '2px 0 8px' }}>
          <textarea value={noteText} onChange={e => setNoteText(e.target.value)} rows={2} autoFocus placeholder={placeholder}
            style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 12.5, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
          {/* 🚨 Slack のパスワードの項目を択一にしたのと同じ理由。自由に書ける欄には書かれてしまう */}
          <div style={{ fontSize: 11, color: subText, margin: '2px 0 6px' }}>🚨 パスワードなど秘密の情報は書かないでください</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" style={btn(true)} disabled={noteSaving || !noteText.trim()}
              onClick={() => saveNote(userId, itemId, itemLabel, noteText)}>保存</button>
            <button type="button" style={btn(false)} onClick={() => { setNoteFor(null); setNoteText(''); }}>やめる</button>
            {cur && (
              <button type="button" style={{ ...btn(false), borderColor: '#dc3545', color: '#dc3545' }} disabled={noteSaving}
                onClick={() => saveNote(userId, itemId, itemLabel, '')}>メモを消す</button>
            )}
          </div>
        </div>
      );
    }
    if (cur) {
      return (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '0 0 8px', flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 160, fontSize: 12.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: inputBg, border: `1px solid ${border}`, borderRadius: 6, padding: '6px 8px' }}>{cur.memo}</span>
          <span style={{ fontSize: 11.5, color: subText }}>
            {names[cur.updated_by ?? ''] || '（不明）'}・{mdLabel(toJstDateStr(new Date(cur.updated_at)))}
          </span>
          <button type="button" style={btn(false)} onClick={() => { setNoteFor(key); setNoteText(cur.memo); }}>メモを直す</button>
        </div>
      );
    }
    return (
      <div style={{ padding: '0 0 6px' }}>
        <button type="button" style={{ ...btn(false), fontSize: 11.5, padding: '3px 8px', color: subText }}
          onClick={() => { setNoteFor(key); setNoteText(''); }}>＋ メモ</button>
      </div>
    );
  };

  if (loading && people.length === 0 && items.length === 0) {
    return <p style={{ color: subText, fontSize: 13 }}>読み込み中…</p>;
  }

  return (
    <div style={{ color: text }}>
      <div style={{ background: isDark ? '#243447' : '#e8f4fd', border: `1px solid ${isDark ? '#3d5166' : '#90caf9'}`, borderRadius: 8, padding: '10px 14px', fontSize: 13, lineHeight: 1.8, marginBottom: 14 }}>
        退職日が決まった方の手続きを、漏れなく済ませるための表です。マネージャー以上と管理者が「済み」にできます（誰がいつ済みにしたかが残ります）。<br />
        退職日は管理画面の「ユーザー」で管理者が入れます。退職日の朝9時に必須の項目が残っていると、マネージャー以上と管理者にお知らせが届きます。<br />
        その方にもともと無い項目（鍵・制服・名刺など）は、行の右の［対象外］で片付けられます。
      </div>

      {loadErr && <div style={{ padding: '9px 12px', borderRadius: 8, fontSize: 12.5, background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029', marginBottom: 10 }}>{loadErr}</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12.5, color: subText, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} />
          すべて済んだ方も表示（{doneCount}人）
        </label>
        {isAdmin && (
          <button style={{ ...btn(false), marginLeft: 'auto' }} onClick={() => setEditItems(v => !v)}>
            {editItems ? '項目の編集を閉じる' : '項目を編集する'}
          </button>
        )}
      </div>

      {isAdmin && editItems && (
        <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 8, padding: 12, marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 8 }}>チェック項目（管理者のみ編集できます）</div>
          {items.map((it, idx) => (
            <div key={it.id} style={{ borderBottom: `1px solid ${border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 0', opacity: it.active ? 1 : 0.5, flexWrap: 'wrap' }}>
              {editingLabelId === it.id ? (
                <>
                  <input value={editingLabelText} onChange={e => setEditingLabelText(e.target.value)} autoFocus
                    style={{ flex: 1, minWidth: 160, padding: '6px 8px', borderRadius: 6, border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 13 }} />
                  <button style={btn(true)} disabled={!editingLabelText.trim()}
                    onClick={async () => {
                      const label = editingLabelText.trim();
                      if (!label) { setItemErr('項目の名前を入れてください'); return; }
                      if (label !== it.label) await updateItem(it.id, { label });
                      setEditingLabelId(null);
                    }}>保存</button>
                  <button style={btn(false)} onClick={() => { setEditingLabelId(null); setItemErr(''); }}>やめる</button>
                </>
              ) : (
                <>
                  <span style={{ flex: 1, minWidth: 160, fontSize: 13 }}>{it.label}</span>
                  <button style={btn(false)} onClick={() => { setItemErr(''); setEditingLabelId(it.id); setEditingLabelText(it.label); }}>修正</button>
                  <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 3 }}>
                    <input type="checkbox" checked={it.required} onChange={e => updateItem(it.id, { required: e.target.checked })} />必須
                  </label>
                  <button style={btn(false)} disabled={idx === 0} onClick={() => moveItem(idx, -1)}>↑</button>
                  <button style={btn(false)} disabled={idx === items.length - 1} onClick={() => moveItem(idx, 1)}>↓</button>
                  <button style={btn(false)} onClick={() => updateItem(it.id, { active: !it.active })}>{it.active ? '隠す' : '戻す'}</button>
                  <button style={{ ...btn(false), borderColor: '#dc3545', color: '#dc3545' }}
                    onClick={() => { setItemErr(''); setEditingLabelId(null); setDeleteItemId(it.id); }}>削除</button>
                </>
              )}
            </div>
            {/* 削除の確認。🚨 記録が何件あるかを先に出す（消えないことも書く） */}
            {deleteItemId === it.id && (() => {
              const used = checks.filter(c => c.item_id === it.id).length;
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '0 0 8px', fontSize: 12.5 }}>
                  <span>
                    「{it.label}」を削除しますか？
                    {used > 0
                      ? `すでに済み・対象外にした記録が ${used} 件ありますが、「削除された項目」として残ります。`
                      : 'まだ一度も使われていません。'}
                  </span>
                  <button type="button" style={btn(false)} onClick={() => setDeleteItemId(null)}>やめる</button>
                  <button type="button" style={{ ...btn(false), borderColor: '#dc3545', color: '#dc3545' }}
                    onClick={() => deleteItem(it.id)}>削除する</button>
                </div>
              );
            })()}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="新しい項目"
              style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 13 }} />
            <button style={btn(true)} onClick={addItem}>追加</button>
          </div>
          {itemErr && <div style={{ color: '#dc3545', fontSize: 12, marginTop: 6 }}>{itemErr}</div>}
          <div style={{ fontSize: 11.5, color: subText, marginTop: 6 }}>※［隠す］は一覧に出さないだけです。もう使わない項目は［削除］してください</div>
        </div>
      )}

      {shownPeople.length === 0 && !loadErr && (
        <p style={{ fontSize: 13, color: subText, textAlign: 'center', margin: '20px 0' }}>
          {people.length === 0 ? '退職日が入っている方はいません' : '残っている手続きはありません'}
        </p>
      )}

      {shownPeople.map(p => {
        const remaining = remainingOf(p.id);
        const naCount = checks.filter(c => c.user_id === p.id && c.na).length;
        const moved = reassigns.filter(r => r.retired_user_id === p.id);
        const movedByTable = Object.entries(moved.reduce<Record<string, number>>((acc, r) => { acc[r.table_name] = (acc[r.table_name] ?? 0) + 1; return acc; }, {}));
        const pLeft = purchaseLeft[p.id];
        const failed = retireState(p, today) === 'switch_failed';
        return (
          <div key={p.id} style={{ background: cardBg, border: `1px solid ${remaining > 0 ? '#f59e0b' : border}`, borderRadius: 10, padding: '12px 14px', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <span style={{ fontSize: 15, fontWeight: 'bold' }}>{p.name}さん</span>
              <span style={{ fontSize: 12, color: subText }}>退職日 {mdLabel(p.retire_date)}・{retireStateLabel(p, today)}</span>
              <span style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 'bold', color: remaining > 0 ? (isDark ? '#ffc107' : '#b35900') : (isDark ? '#5cb85c' : '#1e7e34') }}>
                {remaining > 0
                  ? `必須が残り ${remaining} 件`
                  : naCount > 0 ? `✓ 必須はすべて済み（対象外 ${naCount} 件）` : '✓ 必須はすべて済み'}
              </span>
            </div>
            {failed && (
              <div style={{ padding: '8px 12px', borderRadius: 8, fontSize: 12.5, background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029', marginBottom: 8 }}>
                ⚠️ 退職日を過ぎていますが、自動の退職の切り替えができていません。管理者が「ユーザー」で退職日を入れ直してください。
              </div>
            )}

            {/* その方ぜんたいのメモ（項目に紐づかない申し送り）。🚨 項目ごとのメモと同じ部品を使う */}
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 11.5, color: subText, marginBottom: 3 }}>この方ぜんたいのメモ</div>
              {renderNote(p.id, null, null, '例：9/30 に本人と最終面談')}
            </div>

            {activeItems.map(it => {
              const c = checkOf(p.id, it.id);
              const key = `${p.id}:${it.id}`;
              return (
                <div key={it.id} style={{ borderTop: `1px solid ${border}` }}>
                  {/* 行全体を押せるボタン（スマホの指でも押しやすい高さ44px・2026-09-19 UXレビュー）。
                      済みを戻すときだけ、その場で確認する（押し間違いで「誰が・いつ」が消えないように）。
                      🚨 ［対象外］はこのボタンの**外**に置く（ボタンの入れ子は押せなくなる） */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button type="button" disabled={busyKey === key} aria-pressed={!!c}
                      onClick={() => (c ? setUndoFor(key) : (it.choices?.length ? setChoosingFor(choosingFor === key ? null : key) : toggle(p.id, it)))}
                      style={{ flex: 1, minHeight: 44, display: 'flex', alignItems: 'center', gap: 10, padding: '6px 2px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', color: text, flexWrap: 'wrap' }}>
                      <span aria-hidden style={{ width: 24, height: 24, flexShrink: 0, borderRadius: 6, fontSize: 14, lineHeight: '20px', textAlign: 'center',
                        border: `2px solid ${c && !c.na ? '#1e7e34' : border}`, background: c && !c.na ? '#1e7e34' : 'transparent', color: c?.na ? subText : '#fff' }}>{c ? (c.na ? '—' : '✓') : ''}</span>
                      <span style={{ flex: 1, minWidth: 150, fontSize: 13.5, color: c ? subText : text, textDecoration: c && !c.na ? 'line-through' : 'none' }}>
                        {/* 🚨 済み・対象外の行は「記録したときの文字」を出す。あとで項目を直しても、この記録は変わらない */}
                        {c?.item_label ?? it.label}{c?.choice && <span style={{ color: subText }}>：{c.choice}</span>}
                        {c?.na && <span style={{ color: subText, fontSize: 11.5, marginLeft: 6 }}>（対象外）</span>}
                        {!it.required && <span style={{ color: subText, fontSize: 11, marginLeft: 6 }}>（任意）</span>}
                      </span>
                      {c && (
                        <span style={{ fontSize: 11.5, color: subText }}>
                          {names[c.done_by ?? ''] || '（不明）'}・{mdLabel(toJstDateStr(new Date(c.done_at)))}
                        </span>
                      )}
                    </button>
                    {/* その方には無い項目を片付けるための［対象外］。🚨 未済のときだけ出す。
                        押すとその場で確認する（誤って押すと、必須の項目が静かに残りから消えるため） */}
                    {!c && naFor !== key && (
                      <button type="button" disabled={busyKey === key}
                        onClick={() => { setUndoFor(null); setChoosingFor(null); setNaFor(key); }}
                        style={{ ...btn(false), flexShrink: 0, fontSize: 11.5, padding: '4px 8px', color: subText }}>
                        対象外
                      </button>
                    )}
                  </div>
                  {naFor === key && !c && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '0 10px 10px', fontSize: 12.5 }}>
                      <span>{p.name}さんには無い項目として「対象外」にしますか？（必須の残りから外れます）</span>
                      <button type="button" style={btn(false)} onClick={() => setNaFor(null)}>やめる</button>
                      <button type="button" style={btn(false)} disabled={busyKey === key}
                        onClick={() => toggle(p.id, it, undefined, true)}>対象外にする</button>
                    </div>
                  )}
                  {/* 択一の項目（例：Slack のパスワード）。押すと行の下に選択肢が開く。
                      🚨 自由に書ける欄は作らない（新しいパスワードを書かれる恐れがあるため・2026-09-20 ユーザー確定） */}
                  {choosingFor === key && !c && (it.choices?.length ?? 0) > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '0 10px 10px', fontSize: 12.5 }}>
                      {(it.choices ?? []).map(ch => (
                        <button key={ch} type="button" style={btn(false)} disabled={busyKey === key}
                          onClick={() => { setChoosingFor(null); void toggle(p.id, it, ch); }}>{ch}</button>
                      ))}
                      <button type="button" style={{ ...btn(false), color: subText }} onClick={() => setChoosingFor(null)}>やめる</button>
                    </div>
                  )}
                  {undoFor === key && c && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '6px 10px 10px', fontSize: 12.5 }}>
                      <span>{names[c.done_by ?? ''] || '（不明）'}さんの{c.na ? '「対象外」の' : ''}記録（{mdLabel(toJstDateStr(new Date(c.done_at)))}）を消して、未済に戻しますか？</span>
                      <button type="button" style={btn(false)} onClick={() => setUndoFor(null)}>やめる</button>
                      <button type="button" style={{ ...btn(false), borderColor: '#dc3545', color: '#dc3545' }} onClick={() => toggle(p.id, it)}>戻す</button>
                    </div>
                  )}
                  {/* 項目ごとのメモ。🚨 未済でも書ける（「離職票は9月分が必要」など、やる前に書くことがあるため）。
                      🚨 チェックの記録とは別の表なので、メモを書いても「必須の残り」は減らない */}
                  {renderNote(p.id, it.id, it.label, '例：南草津校の鍵1本を 9/30 に返却')}
                </div>
              );
            })}

            {/* 削除された項目の記録。🚨 項目を消しても、やった証拠は当時の文字で残す。
                項目の一覧には無いので、必須の残り件数には数えない */}
            {(() => {
              const gone = checks.filter(c => c.user_id === p.id && c.item_id === null);
              // 🚨 削除された項目に書いてあったメモも、中身を失わないようにここへ出す
              //    （item_label が入っている＝もとは項目のメモ。ぜんたいのメモとはここで見分ける）
              const goneNotes = notes.filter(n => n.user_id === p.id && n.item_id === null && n.item_label !== null);
              if (gone.length === 0 && goneNotes.length === 0) return null;
              return (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${border}` }}>
                  <div style={{ fontSize: 11.5, color: subText, marginBottom: 4 }}>削除された項目の記録</div>
                  {gone.map(c => (
                    <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '3px 2px', fontSize: 12.5, color: subText, flexWrap: 'wrap' }}>
                      <span aria-hidden style={{ width: 20, height: 20, flexShrink: 0, borderRadius: 5, fontSize: 12, lineHeight: '16px', textAlign: 'center', border: `2px solid ${border}` }}>{c.na ? '—' : '✓'}</span>
                      <span style={{ flex: 1, minWidth: 140 }}>
                        {c.item_label || '（名前が分かりません）'}{c.choice && `：${c.choice}`}{c.na && '（対象外）'}
                      </span>
                      <span style={{ fontSize: 11.5 }}>
                        {names[c.done_by ?? ''] || '（不明）'}・{mdLabel(toJstDateStr(new Date(c.done_at)))}
                      </span>
                    </div>
                  ))}
                  {goneNotes.map(n => (
                    <div key={n.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '3px 2px', fontSize: 12.5, color: subText, flexWrap: 'wrap' }}>
                      <span aria-hidden style={{ width: 20, flexShrink: 0, textAlign: 'center' }}>📩</span>
                      <span style={{ flex: 1, minWidth: 140, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {n.item_label}：{n.memo}
                      </span>
                      <span style={{ fontSize: 11.5 }}>
                        {names[n.updated_by ?? ''] || '（不明）'}・{mdLabel(toJstDateStr(new Date(n.updated_at)))}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })()}

            {(movedByTable.length > 0 || (pLeft ?? 0) > 0 || pLeft === null) && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${border}`, fontSize: 12.5, lineHeight: 1.8 }}>
                {movedByTable.length > 0 && (
                  <div>確認者を「管理者」に付け替えた申請：{movedByTable.map(([t, n]) => `${REASSIGN_TABLE_LABEL[t] ?? t} ${n}件`).join('・')}</div>
                )}
                {(pLeft ?? 0) > 0 && (
                  <div style={{ color: isDark ? '#ffc107' : '#b35900' }}>
                    ⚠️ {p.name}さんが承認者のまま、まだ終わっていない購入申請が {pLeft} 件あります。管理画面の「購入申請」で承認者を変更してください。
                  </div>
                )}
                {pLeft === null && (
                  <div style={{ color: subText }}>※ 購入申請の承認者は、この画面では確かめられませんでした（管理画面の「購入申請」でご確認ください）</div>
                )}
              </div>
            )}
            {rowErr[p.id] && <div style={{ color: '#dc3545', fontSize: 12, marginTop: 6 }}>{rowErr[p.id]}</div>}
          </div>
        );
      })}
    </div>
  );
};

export default RetireChecklistPanel;
