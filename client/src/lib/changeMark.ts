// 「変わった所」の印（2026-10-06 ユーザー確定）。
//   ・変わったマス＝薄い黄色（字は黒）
//   ・マスの中で変わった名前・時刻・クラス名＝濃いピンク（蛍光ペンを引いた形）
//   ・抜けた名前・前の時刻などは、マスの最後に「前：○○」と取り消し線で出す
//   ・暗い画面でも同じ色（明るい画面と同じ見え方にそろえる・ユーザー確定）
//
// 🚨 こどもシフト表・大人シフト表・掃除担当表・勤務表の4つの表と PDF を、この1か所にそろえる（赤い字はやめる）
// 🚨 画面にも PDF にも「変わった所に印を付ける」の切り替えを置く（大きく変わったときは外せるように）
// 🚨 supabase を読まない側（画面を開かずに検算できる）

import type React from 'react';

/** 変わったマスの地の色（薄い黄色） */
export const CHANGE_CELL_BG = '#fff6c4';
/** マスの中で変わった所の色（濃いピンク） */
export const CHANGE_MARK_BG = '#ffb3e6';

/** 変わったマスに付ける見た目（印を付けないときは空）。🚨 暗い画面でも同じ色・字は黒 */
export function changeCellStyle(on: boolean): React.CSSProperties {
  return on ? { background: CHANGE_CELL_BG, color: '#000' } : {};
}

/** マスの中で変わった所（名前・時刻など）に付ける見た目 */
export const CHANGE_MARK_SPAN: React.CSSProperties = { background: CHANGE_MARK_BG, color: '#000', padding: '0 2px', borderRadius: 2 };

/** PDF（印刷用の HTML）の class。🚨 print-color-adjust を付けないと、印刷で地の色が消える */
export const CHANGE_MARK_PRINT_CSS = [
  `.chgcell { background: ${CHANGE_CELL_BG}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }`,
  `.chg { background: ${CHANGE_MARK_BG}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }`,
  `.gone { text-decoration: line-through; }`,
].join('\n  ');

export interface MarkedPart { text: string; hit: boolean }
export interface MarkedCell {
  /** 行ごとの文字。hit＝前に無かった（変わった）所 */
  lines: MarkedPart[][];
  /** 前にはあって、いまは無いもの（抜けた名前・前の時刻など） */
  removed: string[];
}

// 区切り（名前と名前の間の「・」、空白、かっこ、「〜」など）。🚨 「:」は区切らない（「15:40」を1つとして比べる）
const DELIM = /([・\s\u3000（）()〜~、,／]+)/;

/**
 * マスの文字を、前の文字と比べて「変わった所」を見つける。
 * 名前や時刻を1つずつの言葉に分け、前に無かった言葉を印にする。同じ言葉が2回あるときは数で比べる。
 * 🚨 マスが新しく入った（前が空）ときは全部が印になる（中身がまるごと新しいので、それで正しい）
 */
export function diffLines(lines: string[], baseLines: string[]): MarkedCell {
  const left = new Map<string, number>();
  for (const l of baseLines) for (const t of l.split(DELIM)) {
    if (!t || DELIM.test(t)) continue;
    left.set(t, (left.get(t) ?? 0) + 1);
  }
  const out = lines.map(l => l.split(DELIM).filter(t => t !== '').map<MarkedPart>(t => {
    if (DELIM.test(t)) return { text: t, hit: false };
    const n = left.get(t) ?? 0;
    if (n > 0) { left.set(t, n - 1); return { text: t, hit: false }; }
    return { text: t, hit: true };
  }));
  const removed: string[] = [];
  for (const [t, n] of left) for (let i = 0; i < n; i++) removed.push(t);
  return { lines: out, removed };
}
