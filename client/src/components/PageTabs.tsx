import React from 'react';

/**
 * ページ上部のタブバー（共通部品）
 *
 * これまで4ページに同じタブUIがコピペされていたのを1か所に集約した。
 * 見た目は「1ピクセルも変えない」方針のため、既存3種類の見た目を variant として持つ。
 *
 *   variant='shadow'   … 休暇申請（LeaveRequest）・勤務変更（ShiftReportPage）
 *                        上だけ角丸＋影。2個目以降のタブに区切り線。fontSize 15。
 *   variant='bordered' … 残業・時間管理（OvertimePage）
 *                        上だけ角丸＋枠線（下なし）。区切り線なし。fontSize 13.5。
 *                        バッジはラベルの横（インライン）。
 *   variant='boxed'    … 備品精算（PurchaseRequestPage）
 *                        全周角丸の箱型・下に余白。非選択は透明でカード背景が透ける。
 *                        fontSize 13。バッジはタブの右上（絶対配置）。
 *
 * ※ 出張報告（BusinessTripReport）のタブは「上段=報告(緑)/下段=履歴(青)」の
 *    2段構成というユーザー指定の特別レイアウトのため、この部品の対象外（そのまま）。
 *
 * 🚨 実装上の約束
 * - onChange は「すでに選択中のタブを再クリックしたとき」も必ず発火させる。
 *   各ページがスクロールトップ・編集リセット等を onChange に載せており、
 *   ガード（if (key === active) return）を入れると挙動が変わる。
 * - 色の微差はページごとに実値が違うため、非選択文字色（inactiveColor）と
 *   区切り線色（dividerColor）はページ側から渡す。部品に固定で書き込まない。
 * - バッジ件数は 99 超で「99+」表示（実運用で99超はほぼ起きない）。
 */

export interface PageTabDef<K extends string = string> {
  key: K;
  label: string;
  /** 赤い件数バッジ。0 または未指定なら非表示 */
  badge?: number;
}

interface PageTabsProps<K extends string> {
  tabs: PageTabDef<K>[];
  active: K;
  onChange: (key: K) => void;
  variant: 'shadow' | 'bordered' | 'boxed';
  isDark: boolean;
  /** 非選択タブの文字色（各ページの text 変数を渡す。ページごとに実値が微妙に違うため） */
  inactiveColor: string;
  /** shadow のみ：タブ間の区切り線色。省略時は休暇申請と同じ値 */
  dividerColor?: string;
}

const ACTIVE_BG = '#28a745';

export function PageTabs<K extends string>({ tabs, active, onChange, variant, isDark, inactiveColor, dividerColor }: PageTabsProps<K>) {
  const inactiveBg = isDark ? '#495057' : '#f8f9fa';
  const divider = dividerColor ?? (isDark ? '#6c757d' : '#dee2e6');

  const containerStyle: React.CSSProperties =
    variant === 'shadow'
      ? { display: 'flex', marginBottom: 0, borderRadius: '10px 10px 0 0', overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }
      : variant === 'bordered'
        ? { display: 'flex', borderRadius: '10px 10px 0 0', overflow: 'hidden', border: `1px solid ${isDark ? '#495057' : '#dee2e6'}`, borderBottom: 'none' }
        : { display: 'flex', background: isDark ? '#343a40' : '#ffffff', border: `1px solid ${isDark ? '#495057' : '#e0e0e0'}`, borderRadius: 10, overflow: 'hidden', marginBottom: 14 };

  const buttonStyle = (isActive: boolean, index: number): React.CSSProperties => {
    if (variant === 'shadow') {
      return {
        flex: 1, padding: '12px', border: 'none', cursor: 'pointer', fontSize: 15,
        fontWeight: isActive ? 'bold' : 'normal',
        background: isActive ? ACTIVE_BG : inactiveBg,
        color: isActive ? '#fff' : inactiveColor,
        ...(index > 0 ? { borderLeft: `1px solid ${divider}` } : {}),
      };
    }
    if (variant === 'bordered') {
      // バッジの有無に関わらず常に flex（ある時だけ flex にするとタブの高さが変わる）
      return {
        flex: 1, padding: '12px 4px', border: 'none', cursor: 'pointer', fontSize: 13.5,
        fontWeight: isActive ? 'bold' : 'normal',
        background: isActive ? ACTIVE_BG : inactiveBg,
        color: isActive ? '#fff' : inactiveColor,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, lineHeight: 1.3,
      };
    }
    // boxed（絶対配置バッジの基準になるため position:relative 必須）
    return {
      position: 'relative', flex: 1, padding: '10px 4px', border: 'none', cursor: 'pointer', fontSize: 13,
      fontWeight: isActive ? 'bold' : 'normal',
      background: isActive ? ACTIVE_BG : 'transparent',
      color: isActive ? '#fff' : inactiveColor,
    };
  };

  const badgeText = (n: number) => (n > 99 ? '99+' : String(n));

  return (
    <div style={containerStyle}>
      {tabs.map(({ key, label, badge }, index) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          style={buttonStyle(key === active, index)}
        >
          {label}
          {badge !== undefined && badge > 0 && (
            variant === 'boxed' ? (
              <span style={{
                position: 'absolute', top: 4, right: 4,
                minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8,
                background: '#dc3545', color: '#fff', fontSize: 10, fontWeight: 'bold',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
              }}>
                {badgeText(badge)}
              </span>
            ) : (
              <span style={{
                background: '#dc3545', color: '#fff', borderRadius: 10, minWidth: 18, height: 18,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 'bold', padding: '0 5px',
              }}>
                {badgeText(badge)}
              </span>
            )
          )}
        </button>
      ))}
    </div>
  );
}
