// 区分・行き先リスト管理の1つの一覧（2026-10-07 ユーザー指示）。
// 各行に ▲▼（並び替え）／名前変更／終了（日付つき）・戻す／削除。
//
// 🚨 終了＝新しく入力する画面の選択肢に出さないだけ。これまでの報告・申請は名前を文字で持っているので、そのまま残る
// 🚨 並び替えは master_options_reorder で1回にまとめて保存する（1件ずつ書くと、途中で失敗したとき並びが崩れる）
import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { toJstDateStr } from '../../lib/breakCalc';

export interface MasterOptionItem {
  id: string | number;
  value: string;
  sort_order: number;
  ended_at?: string | null;
}

interface Props {
  items: MasterOptionItem[];
  isDarkMode: boolean;
  /** 名前変更を出すか。onRename を渡すとそちらで変える（区分は場所リストも一緒に変えるため RPC） */
  canRename?: boolean;
  onRename?: (id: string, oldName: string, newName: string) => Promise<string | null>;
  /** 終了を出すか */
  canEnd?: boolean;
  /** 削除（確認の画面は呼ぶ側が出す） */
  onDelete?: (item: MasterOptionItem) => void;
  /** 書いたあとに一覧を読み直す */
  onChanged: () => Promise<void>;
  /** 同じ一覧に同じ名前があるか（名前変更のとき） */
  dupMessage?: string;
}

const fmtDate = (d: string) => {
  const [y, m, day] = d.split('-').map(Number);
  return `${y}/${m}/${day}`;
};

export default function MasterOptionList({ items, isDarkMode, canRename, onRename, canEnd, onDelete, onChanged, dupMessage }: Props) {
  // 🚨 失敗はこの一覧のすぐ下に出す（押した場所の近く。ページ上部の通知は、この窓に隠れて見えない）
  const [err, setErr] = useState<string | null>(null);
  const onError = (msg: string) => setErr(msg);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [endingId, setEndingId] = useState<string | null>(null);
  const [endDate, setEndDate] = useState('');
  const [busy, setBusy] = useState(false);

  const smallBtn = (bg: string, fg: string): React.CSSProperties => ({
    padding: '3px 8px', background: bg, color: fg, border: 'none', borderRadius: 4, cursor: busy ? 'default' : 'pointer', fontSize: 12, whiteSpace: 'nowrap',
  });
  const greyBtn = smallBtn(isDarkMode ? '#555' : '#e9ecef', isDarkMode ? '#fff' : '#333');
  const arrowBtn = (disabled: boolean): React.CSSProperties => ({
    ...greyBtn, padding: '2px 6px', opacity: 1, color: disabled ? (isDarkMode ? '#777' : '#bbb') : greyBtn.color, cursor: disabled || busy ? 'default' : 'pointer',
  });
  const inputStyle: React.CSSProperties = {
    flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 6, border: '2px solid #007bff',
    background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#333', fontSize: 14,
  };

  const move = async (idx: number, dir: -1 | 1) => {
    const to = idx + dir;
    if (busy || to < 0 || to >= items.length) return;
    const ids = items.map(i => String(i.id));
    [ids[idx], ids[to]] = [ids[to], ids[idx]];
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc('master_options_reorder', { p_ids: ids });
    setBusy(false);
    if (error) onError(`並び替えできませんでした：${error.message}`);
    await onChanged();
  };

  const saveRename = async (item: MasterOptionItem) => {
    const next = renameValue.trim();
    const id = String(item.id);
    if (!next || next === item.value) { setRenamingId(null); return; }
    if (items.some(i => i.value === next && String(i.id) !== id)) { onError(dupMessage ?? '同じ名前がすでにあります'); return; }
    setBusy(true); setErr(null);
    let failed: string | null = null;
    if (onRename) {
      failed = await onRename(id, item.value, next);
    } else {
      const { data, error } = await supabase.from('master_options').update({ value: next }).eq('id', id).select('id');
      if (error) failed = error.message;
      else if (!data || data.length === 0) failed = '権限が不足しているか、すでに削除されています';
    }
    setBusy(false);
    if (failed) { onError(`名前を変更できませんでした：${failed}`); return; }
    setRenamingId(null);
    await onChanged();
  };

  const setEnded = async (item: MasterOptionItem, date: string | null) => {
    setBusy(true); setErr(null);
    const { data, error } = await supabase.from('master_options').update({ ended_at: date }).eq('id', String(item.id)).select('id');
    setBusy(false);
    if (error) { onError(`${date ? '終了に' : '元に戻'}できませんでした：${error.message}`); return; }
    if (!data || data.length === 0) { onError(`${date ? '終了に' : '元に戻'}できませんでした（権限が不足しているか、すでに削除されています）`); return; }
    setEndingId(null);
    await onChanged();
  };

  return (
    <>
      {items.map((item, idx) => {
        const id = String(item.id);
        const ended = !!item.ended_at;
        const rowBg = ended ? (isDarkMode ? '#3a3f44' : '#eceff1') : (isDarkMode ? '#495057' : '#f8f9fa');
        return (
          <div key={id} style={{ marginBottom: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: rowBg, borderRadius: 6 }}>
              <button type="button" aria-label="上へ" onClick={() => move(idx, -1)} disabled={idx === 0 || busy} style={arrowBtn(idx === 0)}>▲</button>
              <button type="button" aria-label="下へ" onClick={() => move(idx, 1)} disabled={idx === items.length - 1 || busy} style={arrowBtn(idx === items.length - 1)}>▼</button>
              {renamingId === id ? (
                <>
                  <input autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveRename(item); if (e.key === 'Escape') setRenamingId(null); }}
                    style={inputStyle} />
                  <button type="button" onClick={() => saveRename(item)} disabled={busy} style={smallBtn('#007bff', 'white')}>保存</button>
                  <button type="button" onClick={() => setRenamingId(null)} style={greyBtn}>取消</button>
                </>
              ) : (
                <>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: ended ? (isDarkMode ? '#adb5bd' : '#6c757d') : undefined }}>
                    {item.value}
                    {ended && <span style={{ marginLeft: 6, fontSize: 12 }}>（{fmtDate(item.ended_at!)} 終了）</span>}
                  </span>
                  {canRename && !ended && (
                    <button type="button" onClick={() => { setRenamingId(id); setRenameValue(item.value); setEndingId(null); }} style={greyBtn}>名前変更</button>
                  )}
                  {canEnd && !ended && (
                    <button type="button" onClick={() => { setEndingId(id); setEndDate(toJstDateStr(new Date())); setRenamingId(null); }} style={greyBtn}>終了</button>
                  )}
                  {canEnd && ended && (
                    <>
                      <button type="button" onClick={() => { setEndingId(id); setEndDate(item.ended_at!); setRenamingId(null); }} style={greyBtn}>日付を変更</button>
                      <button type="button" onClick={() => setEnded(item, null)} disabled={busy} style={greyBtn}>戻す</button>
                    </>
                  )}
                  {onDelete && (
                    <button type="button" onClick={() => onDelete(item)} style={smallBtn('#dc3545', 'white')}>削除</button>
                  )}
                </>
              )}
            </div>
            {endingId === id && (
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, padding: '6px 8px', margin: '2px 0 0 0', borderRadius: 6, background: isDarkMode ? '#4a4228' : '#fff8e1', fontSize: 13 }}>
                <span>終了日</span>
                <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                  style={{ padding: '3px 6px', borderRadius: 4, border: isDarkMode ? '1px solid #666' : '1px solid #ccc', background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#333', fontSize: 13 }} />
                <button type="button" onClick={() => setEnded(item, endDate)} disabled={!endDate || busy} style={smallBtn('#007bff', 'white')}>{ended ? 'この日に変更' : '終了にする'}</button>
                <button type="button" onClick={() => setEndingId(null)} style={greyBtn}>やめる</button>
                <div style={{ width: '100%', fontSize: 12, color: isDarkMode ? '#ced4da' : '#6c757d' }}>
                  選択肢に出なくなります。これまでの記録はそのまま残ります。［戻す］で元に戻せます
                </div>
              </div>
            )}
          </div>
        );
      })}
      {err && <div style={{ color: isDarkMode ? '#ff8a80' : '#c62828', fontSize: 12, margin: '4px 0' }}>{err}</div>}
    </>
  );
}
