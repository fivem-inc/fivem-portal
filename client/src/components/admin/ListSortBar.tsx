import React from 'react';
import { LIST_SORT_LABELS, listSortDirLabel, type ListSort, type ListSortKey } from '../../lib/listSort';

/**
 * 並び順の選択（残業の一覧・勤務変更の一覧で共用・2026-10-22）。
 * 「並び順：［出した日］［↓ 新しい順］ 次に：［対象日］［↓ 新しい順］」
 * 🚨 クリアのボタンは置かない（絞り込みと一緒に戻すため、各一覧のクリアが DEFAULT_LIST_SORTS に戻す）
 */
const ListSortBar: React.FC<{
  sorts: ListSort[];
  onChange: (s: ListSort[]) => void;
  isDarkMode: boolean;
}> = ({ sorts, onChange, isDarkMode }) => {
  const text = isDarkMode ? '#fff' : '#333';
  const sub = isDarkMode ? '#adb5bd' : '#666';
  const ctl: React.CSSProperties = { padding: '5px 10px', borderRadius: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 12 };
  const set = (i: number, patch: Partial<ListSort>) => onChange(sorts.map((s, k) => {
    if (k !== i) return s;
    const next = { ...s, ...patch };
    // 並べる物を変えたら、その物の使いやすい向き（日付・差分＝新しい／多い順、名前＝番号の小さい順）
    if (patch.key && patch.key !== s.key) next.dir = patch.key === 'name' ? 'asc' : 'desc';
    return next;
  }));
  const keys = Object.keys(LIST_SORT_LABELS) as Exclude<ListSortKey, 'none'>[];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {sorts.map((s, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 12, color: sub }}>{i === 0 ? '並び順：' : '次に：'}</span>
          <select value={s.key} onChange={e => set(i, { key: e.target.value as ListSortKey })} style={ctl}>
            {i > 0 && <option value="none">なし</option>}
            {keys.filter(k => i === 0 || k !== sorts[0].key || k === s.key).map(k => <option key={k} value={k}>{LIST_SORT_LABELS[k]}</option>)}
          </select>
          {s.key !== 'none' && (
            <button type="button" onClick={() => set(i, { dir: s.dir === 'asc' ? 'desc' : 'asc' })} style={{ ...ctl, cursor: 'pointer' }}>
              {s.dir === 'desc' ? '↓' : '↑'} {listSortDirLabel(s.key, s.dir)}
            </button>
          )}
        </span>
      ))}
    </span>
  );
};

export default ListSortBar;
