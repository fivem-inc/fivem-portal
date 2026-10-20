/**
 * 休職の登録・修正の窓（管理画面 → ユーザー・2026-10-20・計画 docs/計画-休職と手続き.md）
 *
 * ・登録：休職の初日・復職日（戻って最初に出勤する日・未定も可）・この方が対応する予定の申請の付け替え
 * ・修正：日付の修正・新しく届いた申請の付け替え・始まる前なら［この休職を取り消す］
 * 🚨 受理待ちの一覧が読めないときは登録・保存させない（付け替え漏れを防ぐ・UI/UX レビュー）
 * 🚨 付け替え先は初めは空。1件ずつ選ばないと登録できない（「付け替えない」も選べる）
 * 🚨 理由（体調・病名など）は入力させない
 */
import React, { useEffect, useMemo, useState } from 'react';
import { backBtn, primaryBtn } from '../../lib/buttonStyles';
import { mdLabel } from '../../lib/retire';
import {
  type StaffLeave, type PendingItem, type ReassignPick,
  fetchPendingItems, pendingItemLabel, leaveStatusOf, LEAVE_DEFAULT_FEATURE_LABELS, LEAVE_SELECTABLE, fetchLeaveBaseKeys,
  registerLeave, updateLeave, cancelLeave, reassignPending,
} from '../../lib/staffLeave';

const SKIP = '__skip__';
// 🎨🔒 黄色の注意の枠（ライト・ダークとも同じ色）
const WARN = { background: '#fff3cd', border: '1px solid #ffc107', color: '#856404' } as const;

interface Props {
  isDark: boolean;
  user: { id: string; name: string; sub: string };
  leave: StaffLeave | null;              // 空＝新しく登録
  candidates: { id: string; name: string }[]; // 付け替え先の候補（在籍・休職中でない・本人以外）
  todayJst: string;
  onClose: () => void;
  onDone: (msg: string, isError?: boolean) => void;
}

const StaffLeaveModal: React.FC<Props> = ({ isDark, user, leave, candidates, todayJst, onClose, onDone }) => {
  const isEdit = !!leave;
  const [start, setStart] = useState(leave?.start_date ?? '');
  const [retUndecided, setRetUndecided] = useState(isEdit ? !leave?.return_date : false);
  const [ret, setRet] = useState(leave?.return_date ?? '');
  const [items, setItems] = useState<PendingItem[] | null | undefined>(undefined); // undefined＝読み込み中・null＝失敗
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [bulk, setBulk] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  // 休職中に使える機能：基本どおり／この方だけ変える（足す・引くは基本との差だけを保存する）
  const [baseKeys, setBaseKeys] = useState<string[] | null>(null);
  const [custom, setCustom] = useState(!!leave && (leave.features_add.length > 0 || leave.features_remove.length > 0));
  const [chosen, setChosen] = useState<string[] | null>(null); // この方だけ変えるときの「使える」keys
  useEffect(() => {
    void fetchLeaveBaseKeys().then(b => {
      const base = b ?? [];
      setBaseKeys(b);
      const start = [...new Set([...base, ...(leave?.features_add ?? [])])].filter(k => !(leave?.features_remove ?? []).includes(k));
      setChosen(start);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const featOn = (list: string[], f: (typeof LEAVE_SELECTABLE)[number]) => list.includes(f.keys[0]);
  const effectiveKeys = custom && chosen ? chosen : (baseKeys ?? []);

  const text = isDark ? '#f8f9fa' : '#212529';
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 15, borderRadius: 6,
    border: `1px solid ${isDark ? '#6c757d' : '#ced4da'}`, background: isDark ? '#343a40' : '#fff', color: text,
  };

  const load = () => {
    setItems(undefined);
    void fetchPendingItems(user.id).then(r => setItems(r));
  };
  useEffect(load, [user.id]);

  const keyOf = (it: PendingItem) => `${it.kind}:${it.row_id}:${it.col}`;
  const movable = useMemo(() => (items ?? []).filter(it => it.can_reassign), [items]);
  const fixedOnly = useMemo(() => (items ?? []).filter(it => !it.can_reassign), [items]);
  const unpicked = movable.filter(it => !picks[keyOf(it)]).length;

  const applyBulk = (v: string) => {
    setBulk(v);
    if (!v) return;
    const next: Record<string, string> = { ...picks };
    for (const it of movable) next[keyOf(it)] = v;
    setPicks(next);
  };

  const status = leave ? leaveStatusOf(leave, todayJst) : null;
  const canCancel = isEdit && status === 'scheduled';

  const validate = (): string | null => {
    if (!start) return '休職の初日を選んでください';
    if (!retUndecided && !ret) return '復職日を選ぶか、「未定」を選んでください';
    if (!retUndecided && ret <= start) return '復職日は休職の初日より後にしてください';
    if (items === undefined) return 'この方が対応する予定の申請を確認しています。少しお待ちください';
    if (items === null) return 'この方が対応する予定の申請を確認できませんでした。もう一度お試しください';
    if (unpicked > 0) return `付け替え先が選ばれていない申請が ${unpicked}件 あります`;
    return null;
  };

  const submit = async () => {
    const v = validate();
    if (v) { setErr(v); return; }
    setBusy(true); setErr('');
    const retVal = retUndecided ? null : ret;
    const base = baseKeys ?? [];
    const add = custom && chosen ? chosen.filter(k => !base.includes(k)) : [];
    const remove = custom && chosen ? base.filter(k => !chosen.includes(k)) : [];
    if (isEdit && leave) {
      const e = await updateLeave(leave, start, retVal, add, remove);
      if (e) { setBusy(false); setErr('保存できませんでした：' + e); return; }
    } else {
      const r = await registerLeave(user.id, start, retVal, add, remove);
      if (r.error) { setBusy(false); setErr('登録できませんでした：' + r.error); return; }
    }
    const sel: ReassignPick[] = movable
      .filter(it => picks[keyOf(it)] && picks[keyOf(it)] !== SKIP)
      .map(it => ({ kind: it.kind, row_id: it.row_id, col: it.col, to: picks[keyOf(it)] }));
    const mv = await reassignPending(user.id, sel);
    setBusy(false);
    const head = isEdit ? `${user.name}さんの休職を直しました。` : `${user.name}さんの休職を登録しました（${mdLabel(start)} から）。`;
    if (mv.error) { onDone(`${head}ただし、申請の付け替えができませんでした：${mv.error}（［休職を修正］からもう一度付け替えてください）`, true); return; }
    onDone(head + (mv.moved > 0 ? `申請 ${mv.moved}件 を付け替えました。` : '') + (isEdit ? '' : '手続きの「休職」のタブで、本人への確認を進めてください。'));
  };

  const doCancel = async () => {
    if (!leave) return;
    setBusy(true);
    const e = await cancelLeave(leave.id);
    setBusy(false);
    if (e) { setErr('取り消せませんでした：' + e); setConfirmCancel(false); return; }
    onDone(`${user.name}さんの休職の登録（${mdLabel(leave.start_date)}〜）を取り消しました。`);
  };

  const label = (t: string, required = false) => (
    <div style={{ fontSize: 14, fontWeight: 'bold', color: text, margin: '14px 0 6px', textAlign: 'left' }}>
      {t}{required && <span style={{ color: '#dc3545', fontSize: 12, marginLeft: 6 }}>*必須</span>}
    </div>
  );
  const toggle = (on: boolean): React.CSSProperties => ({
    flex: 1, padding: '8px 0', fontSize: 14, borderRadius: 6, cursor: 'pointer',
    background: on ? '#1976d2' : 'transparent', color: on ? '#fff' : text,
    border: `1px solid ${on ? '#1976d2' : (isDark ? '#6c757d' : '#ced4da')}`, fontWeight: on ? 'bold' : 'normal',
  });

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', padding: '24px 12px', boxSizing: 'border-box' }}
      onClick={() => { if (!busy) onClose(); }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: isDark ? '#2b3035' : '#fff', color: text, borderRadius: 12, padding: '16px 16px 18px', width: '100%', maxWidth: 480, boxSizing: 'border-box', textAlign: 'left' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, fontSize: 17, fontWeight: 'bold' }}>{isEdit ? '休職の修正' : '休職の登録（退職ではありません）'}</div>
          <button onClick={onClose} disabled={busy} aria-label="閉じる"
            style={{ background: 'none', border: 'none', fontSize: 20, color: sub, cursor: 'pointer', padding: '0 4px' }}>✕</button>
        </div>
        <div style={{ fontSize: 13, color: sub, marginTop: 2 }}>{user.name}さん{user.sub ? `（${user.sub}）` : ''}</div>

        {label('休職の初日', true)}
        <input type="date" value={start} onChange={e => { setStart(e.target.value); setErr(''); }} style={inputStyle} />
        {start && start <= todayJst && (!isEdit || status === 'scheduled') && (
          <div style={{ fontSize: 12.5, color: '#dc3545', marginTop: 4 }}>今日より前（今日を含む）の日付です。保存した時点で休職中に切り替わります。</div>
        )}

        {label('復職日（戻って最初に出勤する日）')}
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <button type="button" style={toggle(!retUndecided)} onClick={() => { setRetUndecided(false); setErr(''); }}>日付を決める</button>
          <button type="button" style={toggle(retUndecided)} onClick={() => { setRetUndecided(true); setErr(''); }}>未定</button>
        </div>
        {retUndecided
          ? <div style={{ fontSize: 12.5, color: sub }}>復職するときに、管理者が［今日から復職にする］で戻します。</div>
          : <input type="date" value={ret} onChange={e => { setRet(e.target.value); setErr(''); }} style={inputStyle} />}

        {label('休職中に使える機能')}
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <button type="button" style={toggle(!custom)} onClick={() => setCustom(false)}>基本どおり</button>
          <button type="button" style={toggle(custom)} onClick={() => setCustom(true)}>この方だけ変える</button>
        </div>
        {custom && chosen ? (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {LEAVE_SELECTABLE.map(f => {
              const on = featOn(chosen, f);
              return (
                <button key={f.label} type="button"
                  onClick={() => setChosen(on ? chosen.filter(k => !f.keys.includes(k)) : [...chosen, ...f.keys.filter(k => !chosen.includes(k))])}
                  style={{ padding: '6px 10px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
                    border: on ? '2px solid #1976d2' : `1px solid ${isDark ? '#6c757d' : '#ced4da'}`,
                    background: on ? '#1976d2' : 'transparent', color: on ? '#fff' : text }}>
                  {on ? '✓ ' : ''}{f.label}
                </button>
              );
            })}
          </div>
        ) : (
          <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
            使える：{baseKeys === null ? LEAVE_DEFAULT_FEATURE_LABELS.join('・') : (LEAVE_SELECTABLE.filter(f => featOn(effectiveKeys, f)).map(f => f.label).join('・') || 'ホーム・設定だけ')}
          </div>
        )}
        <div style={{ fontSize: 12, color: sub, marginTop: 4 }}>※ 休職前の役職で使えていない機能は、ここで選んでも使えません。</div>

        <div style={{ ...WARN, borderRadius: 8, padding: '10px 12px', marginTop: 14, fontSize: 13.5 }}>
          {items === undefined && <div>この方が対応する予定の申請を確認しています…</div>}
          {items === null && (
            <div>この方が対応する予定の申請を確認できませんでした。
              <button type="button" onClick={load} style={{ marginLeft: 6, background: '#fff', border: '1px solid #ffc107', color: '#856404', borderRadius: 6, padding: '2px 10px', cursor: 'pointer', fontSize: 13 }}>もう一度読む</button>
            </div>
          )}
          {items && items.length === 0 && <div>この方が対応する予定の申請はありません。</div>}
          {items && items.length > 0 && (
            <>
              <div style={{ fontWeight: 'bold', marginBottom: 6 }}>この方が対応する予定の申請 {items.length}件</div>
              {movable.length > 0 && (
                <>
                  <div style={{ fontSize: 12.5, marginBottom: 6 }}>付け替え先を1件ずつ選んでください。</div>
                  {movable.length > 1 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13 }}>まとめて：</span>
                      <select value={bulk} onChange={e => applyBulk(e.target.value)} style={{ flex: 1, minWidth: 160, padding: '5px 6px', borderRadius: 4, border: '1px solid #ced4da', fontSize: 13.5 }}>
                        <option value="">選択してください</option>
                        <option value={SKIP}>付け替えない</option>
                        {candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                  )}
                  {movable.map(it => (
                    <div key={keyOf(it)} style={{ borderTop: '1px solid #ffe08a', padding: '6px 0' }}>
                      <div style={{ fontSize: 13, marginBottom: 4 }}>{pendingItemLabel(it)}</div>
                      <select value={picks[keyOf(it)] ?? ''} onChange={e => { setPicks({ ...picks, [keyOf(it)]: e.target.value }); setErr(''); }}
                        style={{ width: '100%', padding: '5px 6px', borderRadius: 4, border: `1px solid ${picks[keyOf(it)] ? '#ced4da' : '#ffc107'}`, fontSize: 13.5 }}>
                        <option value="">選択してください</option>
                        <option value={SKIP}>付け替えない</option>
                        {candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                  ))}
                  <div style={{ fontSize: 12, marginTop: 6 }}>※「付け替えない」は復職まで受理されません（毎朝、経理にお知らせが届きます）</div>
                </>
              )}
              {fixedOnly.length > 0 && (
                <div style={{ borderTop: '1px solid #ffe08a', paddingTop: 6, marginTop: 6 }}>
                  {fixedOnly.map(it => <div key={keyOf(it)} style={{ fontSize: 13 }}>{pendingItemLabel(it)}</div>)}
                  <div style={{ fontSize: 12, marginTop: 4 }}>※ 備品購入申請は、申請の画面の［承認者を変更］で直してください。</div>
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ fontSize: 12, color: sub, lineHeight: 1.7, marginTop: 12 }}>
          ※ 休職の初日の0時に自動で休職中になり、復職日の0時に自動で元に戻ります。<br />
          ※ 理由（体調・病名など）は入力しません。
        </div>

        {err && <div style={{ color: '#dc3545', fontSize: 13.5, marginTop: 10 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button type="button" style={{ ...backBtn(isDark), flex: 1 }} onClick={onClose} disabled={busy}>やめる</button>
          <button type="button" style={{ ...primaryBtn({ disabled: busy }), flex: 2 }} onClick={submit} disabled={busy}>
            {busy ? '保存しています…' : isEdit ? '保存する' : '休職を登録する'}
          </button>
        </div>

        {canCancel && (
          <div style={{ marginTop: 16, textAlign: 'right' }}>
            {!confirmCancel ? (
              <button type="button" onClick={() => setConfirmCancel(true)} disabled={busy}
                style={{ background: 'none', border: 'none', color: '#dc3545', fontSize: 13, cursor: 'pointer', textDecoration: 'underline' }}>この休職の登録を取り消す</button>
            ) : (
              <div style={{ ...WARN, borderRadius: 8, padding: '10px 12px', fontSize: 13.5, textAlign: 'left' }}>
                {user.name}さんの休職の登録（{mdLabel(leave?.start_date)}〜）を取り消します。付け替えた申請は元に戻りません。
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button type="button" style={{ ...backBtn(false), flex: 1, padding: '8px 0', fontSize: 14 }} onClick={() => setConfirmCancel(false)} disabled={busy}>やめる</button>
                  <button type="button" style={{ ...primaryBtn({ danger: true, disabled: busy }), flex: 1, padding: '8px 0', fontSize: 14 }} onClick={doCancel} disabled={busy}>取り消す</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default StaffLeaveModal;
