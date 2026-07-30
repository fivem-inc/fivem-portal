// 入力エラーのハイライト（アプリ共通）
//
// 「送信を押したら赤いバナーが出たが、どの欄が原因か分からない」を防ぐための仕組み。
// 未入力・不正の欄そのものを薄赤にして、入力し直すと消える。
//
// ⚠️ 色は必ずここを使う。以前は交通費が薄ピンク（#ffe4e8/#f06292）、休暇申請が薄赤（#fdecea/#e24b4a）で
//    ばらついていた。CLAUDE.md の配色ルール「入力欄のエラーはテーマ追従（固定色にしない）」に従い、
//    ダークでは暗い赤・ライトでは薄赤にする（固定の明るい色にすると、入力文字が白いダークで読めなくなる）。

import type { CSSProperties } from 'react';

export const ERROR_BORDER = '#e24b4a';
export const ERROR_LABEL = '#dc3545';
export const errorBg = (isDark: boolean) => (isDark ? '#4a2b30' : '#fdecea');

/**
 * 入力欄に重ねるスタイル。エラーでなければ何も返さない（既存のスタイルをそのまま使う）。
 *
 *   <input style={{ ...inputStyle, ...errorStyle(errFields.has('amount'), isDark) }} />
 */
export const errorStyle = (hasError: boolean, isDark: boolean): CSSProperties =>
  hasError ? { background: errorBg(isDark), borderColor: ERROR_BORDER } : {};

/** ラベルの文字色。エラーのときだけ赤にする */
export const errorLabelColor = (hasError: boolean, normalColor: string) =>
  hasError ? ERROR_LABEL : normalColor;

/**
 * エラーになった最初の欄まで自動スクロールする。
 * 画面下のエラーバナーしか出ないと、原因が上の方の欄だったとき気づけないため。
 * 欄には data-err-field="<キー>" を付けておく。
 */
export const scrollToFirstError = (fields: Iterable<string>) => {
  const first = [...fields][0];
  if (!first) return;
  // 描画（ハイライト付け）を待ってから探す
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-err-field="${first}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
};
