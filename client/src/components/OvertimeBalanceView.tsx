import React from 'react';
import { formatSignedMin } from '../lib/breakCalc';
import { diffColor, plannedBreakdownRows } from '../lib/overtimeBalance';

// 残業・時間の「合計時間数」の見せ方（2026-10-16 ユーザー確定・モック b の 2）。
// 🚨 本人のカード・部門集計の個人の詳細・管理画面・表入力・まとめて申請・期の見出しが同じものを使う（書き写さない）。
// ・待っているもの（実績報告待ち・確認待ち）があるとき：主役は「この期の見込み」。確定と未確定（内訳）を分けて添える
//   （前は確定の −8:00 が大きく出て、＋8:00 で埋まる予定でも「8時間足りない」と読めていた）
// ・待っているものが無いとき：「確定」だけ
// ・未確定の合計は出さない（内訳が1つだと同じ数字が2回並ぶ）。行の頭に「＋」は付けない（「＋ −8:00」になるため）

export interface BalanceLike {
  total: number;
  plannedTotal: number;
  awaitingActual: number;
  awaitingReview: number;
}

export const hasPendingBalance = (b: BalanceLike) => b.awaitingActual !== 0 || b.awaitingReview !== 0;

/** カードの中身（大きな数字＋確定＋未確定の箱）。本人のカード・部門集計の個人の詳細 */
export const OvertimeBalanceMain: React.FC<{ b: BalanceLike; isDark: boolean; align?: 'center' | 'left'; bigSize?: number }> = ({ b, isDark, align = 'center', bigSize = 26 }) => {
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const borderColor = isDark ? '#495057' : '#dee2e6';
  if (!hasPendingBalance(b)) {
    return (
      <>
        <p style={{ margin: '6px 0 0', fontSize: 12.5, color: subText, textAlign: align }}>確定</p>
        <p style={{ margin: '0 0 2px', fontSize: bigSize, fontWeight: 'bold', color: diffColor(b.total, isDark), textAlign: align }}>{formatSignedMin(b.total)}</p>
      </>
    );
  }
  return (
    <>
      <p style={{ margin: '6px 0 0', fontSize: 12.5, color: subText, textAlign: align }}>この期の見込み</p>
      <p style={{ margin: '0 0 6px', fontSize: bigSize, fontWeight: 'bold', color: diffColor(b.plannedTotal, isDark), textAlign: align }}>{formatSignedMin(b.plannedTotal)}</p>
      <div style={{ borderTop: `1px dashed ${borderColor}`, paddingTop: 4, marginBottom: 2 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, padding: '2px 8px', color: text }}>
          <span style={{ fontWeight: 'bold' }}>確定</span>
          <span style={{ fontWeight: 'bold', color: diffColor(b.total, isDark) }}>{formatSignedMin(b.total)}</span>
        </div>
        <div style={{ background: isDark ? '#343a40' : '#e9ecef', borderRadius: 8, padding: '4px 8px 6px', marginTop: 4 }}>
          <div style={{ fontSize: 13.5, fontWeight: 'bold', color: text, padding: '2px 0' }}>未確定</div>
          {plannedBreakdownRows(b).map(([label, min]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: subText, padding: '1px 0 1px 8px' }}>
              <span>└ {label}</span>
              <span style={{ fontWeight: 'bold', color: diffColor(min, isDark) }}>{formatSignedMin(min)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
};

/** 1行の形（管理画面・表入力・まとめて申請・期の見出し）。
 *  待ちがあれば「見込み ＋2:00（確定 −8:00・実績報告待ち ＋8:00・確認待ち ＋2:00）」、無ければ「確定 ＋3:30」 */
export const OvertimeBalanceInline: React.FC<{ b: BalanceLike; isDark: boolean; numSize?: number; prefix?: string }> = ({ b, isDark, numSize, prefix = '' }) => {
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const num = (min: number, big?: boolean) => (
    <b style={{ color: diffColor(min, isDark), fontSize: big ? numSize : undefined }}>{formatSignedMin(min)}</b>
  );
  if (!hasPendingBalance(b)) return <span>{prefix}確定 {num(b.total, true)}</span>;
  return (
    <span>
      {prefix}見込み {num(b.plannedTotal, true)}
      <span style={{ color: subText }}>
        （確定 {num(b.total)}{plannedBreakdownRows(b).map(([label, min]) => <React.Fragment key={label}>・{label} {num(min)}</React.Fragment>)}）
      </span>
    </span>
  );
};
