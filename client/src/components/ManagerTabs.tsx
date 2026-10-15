import React from 'react';
import { PAGE_TAB_GREEN } from '../lib/buttonStyles';

/**
 * ページのタブの「2段目」＝上長の仕事（受理待ち／確認待ち・申請の依頼）。2026-10-15 ユーザー確定。
 * 休暇申請のページと残業・時間のページで同じこれを使う（形と色を2か所に書かない）。
 *
 * 決まり（UI/UX のレビューで決めた・ユーザー確定）：
 * ・形は1段目と同じ考え方：選んでいない＝灰色（薄い枠線つき）／選んでいる＝緑（ページのタブの緑）
 *   🚨 うすい緑・うすい青・白地に枠にしない（成功のお知らせ・［＋追加］・［戻る］と見分けがつかなくなる）
 * ・2つは同じ色。急ぎかどうかは数字の色で分ける（urgent＝赤／それ以外＝灰色）
 * ・左に小さく「上長」と書く（上長にだけ出る段だと分かるように）
 * ・押せる高さは 40px 以上（年配の方・スマホ）。文字を特大にしても（幅288）言葉の途中で折り返さない
 * ・下に 10px あける（下の入力画面の枠とくっつかないように）
 */
export interface ManagerTabItem<K extends string> {
  key: K;
  label: string;
  /** 数字（0 なら出さない） */
  count?: number;
  /** 数字を赤にするか（自分が今やること）。false なら灰色（相手を待っているだけ） */
  urgent?: boolean;
}

interface Props<K extends string> {
  items: ManagerTabItem<K>[];
  /** いま開いているもの（1段目を開いているときは null） */
  active: K | null;
  onChange: (key: K) => void;
  isDark: boolean;
  style?: React.CSSProperties;
}

export function ManagerTabs<K extends string>({ items, active, onChange, isDark, style }: Props<K>) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, marginTop: 8, marginBottom: 10, ...style }}>
      <span style={{ flexShrink: 0, alignSelf: 'center', fontSize: 11, color: isDark ? '#adb5bd' : '#6c757d' }}>上長</span>
      {items.map(it => {
        const on = it.key === active;
        return (
          <button key={it.key} type="button" onClick={() => onChange(it.key)} aria-pressed={on}
            style={{
              flex: 1, minWidth: 0, minHeight: 40, padding: '6px 2px', borderRadius: 10, cursor: 'pointer',
              fontSize: 13, fontWeight: 'bold', lineHeight: 1.3,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4, flexWrap: 'wrap',
              border: `1px solid ${on ? PAGE_TAB_GREEN : (isDark ? '#6c757d' : '#dee2e6')}`,
              background: on ? PAGE_TAB_GREEN : (isDark ? '#495057' : '#e9ecef'),
              color: on ? '#fff' : (isDark ? '#f8f9fa' : '#333'),
            }}>
            <span style={{ whiteSpace: 'nowrap' }}>{it.label}</span>
            {!!it.count && it.count > 0 && (
              <span style={{
                // 灰色の数字は、ダークの灰色のボタンの上だと見えにくいので明るい灰色にする
                background: it.urgent ? '#dc3545' : (isDark && !on ? '#adb5bd' : '#6c757d'),
                color: it.urgent || on || !isDark ? '#fff' : '#212529',
                borderRadius: 10, minWidth: 18, height: 18,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 'bold', padding: '0 5px',
              }}>{it.count > 99 ? '99+' : it.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default ManagerTabs;
