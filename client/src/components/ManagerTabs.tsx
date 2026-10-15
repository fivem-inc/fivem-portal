import React from 'react';
import { PAGE_TAB_GREEN } from '../lib/buttonStyles';

/**
 * ページのタブの「2段目」＝上長の仕事（受理待ち／確認待ち・申請の依頼）。2026-10-15〜16 ユーザー確定。
 * 休暇申請のページと残業・時間のページで同じこれを使う（形と色を2か所に書かない）。
 *
 * 決まり（ユーザー確定・モック 配布資料/上長のボタン_2行の形_6案.png の ②）：
 * ・前のオレンジのボタン（［✅ 受理ページへ］＋説明の1行）と同じ2行の形を、2つ横に並べる
 * ・色はうすいオレンジ。🚨 ダークモードでもライトと同じ色にする（透けるオレンジにしない・2026-10-16 ユーザー指示）
 * ・選んでいる＝緑（ページのタブの緑）。数字の丸はオレンジ（選んでいるときは白地に緑）
 * ・「上長」の文字は出さない（2026-10-16 ユーザー指示：要らない・違和感がある）
 * ・押せる高さは 40px 以上（年配の方・スマホ）。文字を特大にしても（幅288）名前は途中で折り返さない
 * ・上下の間は前のオレンジのボタンと同じ 8px。下の入力の枠の角は前のまま（上だけ四角）
 */
export interface ManagerTabItem<K extends string> {
  key: K;
  label: string;
  /** 2行目の小さな説明（例：休暇申請を受理する） */
  sub?: string;
  /** 数字（0 なら出さない） */
  count?: number;
}

interface Props<K extends string> {
  items: ManagerTabItem<K>[];
  /** いま開いているもの（1段目を開いているときは null） */
  active: K | null;
  onChange: (key: K) => void;
  /** 🚨 色はダークでも同じなので見た目には使っていない（呼ぶ側をそろえるために残す） */
  isDark: boolean;
  style?: React.CSSProperties;
}

const ORANGE = '#fd7e14';
const LIGHT_ORANGE_BG = '#fff4e6';
const LIGHT_ORANGE_BORDER = '#ffc078';
const ORANGE_TEXT = '#b35400';

export function ManagerTabs<K extends string>({ items, active, onChange, style }: Props<K>) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, marginTop: 8, marginBottom: 8, ...style }}>
      {items.map(it => {
        const on = it.key === active;
        return (
          <button key={it.key} type="button" onClick={() => onChange(it.key)} aria-pressed={on}
            style={{
              flex: 1, minWidth: 0, minHeight: 40, padding: '7px 6px', borderRadius: 10, cursor: 'pointer',
              border: `1px solid ${on ? PAGE_TAB_GREEN : LIGHT_ORANGE_BORDER}`,
              background: on ? PAGE_TAB_GREEN : LIGHT_ORANGE_BG,
              color: on ? '#fff' : ORANGE_TEXT,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', lineHeight: 1.3,
            }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, flexWrap: 'wrap', fontSize: 14, fontWeight: 'bold' }}>
              <span style={{ whiteSpace: 'nowrap' }}>{it.label}</span>
              {!!it.count && it.count > 0 && (
                <span style={{
                  background: on ? '#fff' : ORANGE, color: on ? PAGE_TAB_GREEN : '#fff',
                  borderRadius: 10, minWidth: 17, height: 17, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10.5, fontWeight: 'bold', padding: '0 5px',
                }}>{it.count > 99 ? '99+' : it.count}</span>
              )}
            </span>
            {it.sub && <span style={{ fontSize: 10.5, marginTop: 2, opacity: 0.92 }}>{it.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}

export default ManagerTabs;
