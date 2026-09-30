// 送る・戻る・追加のボタンの色と形（2026-09-30 ユーザー確定「案B」）。
//
// 🚨 決まり（各画面はここを呼ぶ。色の値を画面に書き写さない＝片方だけ直す事故を防ぐ）
//   ・青の塗り（primaryBtn）… その画面でいちばん押すボタン。**1画面に1つだけ**
//        申請する・送信する・報告する・受理して送る・依頼する・提案を送る など
//   ・赤の塗り（primaryBtn({ danger: true })）… 差し戻す・安否確認の送信
//   ・白地に灰色の枠（backBtn）… 戻る・修正する・キャンセル・やめる
//   ・薄い青（tintBtn）… 追加など2番目のボタン（［＋ 申請リストに追加］［⇄ 往復で追加］）
//   ・確認画面は［戻る］が左・送る方が右で幅2倍（flex 1 : 2）。受理の画面は押し間違いを防ぐため並びを変えない
// 根拠：デジタル庁・Apple・Google・Microsoft・SmartHR の手引きはどれも「主のボタン＝青の塗り・1画面に1つ・2番目は同じ色の枠か薄い色」。
//       受理（緑）と差し戻し（赤）の並びは、赤と緑の区別がつきにくい人（男性の約5％）には同じ色に見えるため青にした。
// 🚨 緑は「送信しました」などの成功の知らせ（薄緑のカード）だけに使う。ボタンには使わない
import type React from 'react';

export const BTN_BLUE = '#0d6efd';
/**
 * 選ぶ・切り替えるボタン（択一トグル・🎨🔒）の「選んでいるもの」の濃い青。選んでいないものはテーマに合わせた灰色。
 * 日付を選ぶカレンダーの「選んだ日」の塗りも同じ色（今日は青い枠だけ・2026-09-30 ユーザー確定）
 */
export const TOGGLE_BLUE = '#1976d2';
/**
 * ページの上のタブ（PageTabs：休暇・残業・勤務変更・勤怠カレンダー・備品精算）と、出張報告の［到着］［終了］の「選んでいるタブ」の緑。
 * 🚨 2026-09-30 ユーザー確定：ページの上のタブは緑のまま（中の切り替え＝TOGGLE_BLUE とは別の決まり）
 */
export const PAGE_TAB_GREEN = '#28a745';
export const BTN_RED = '#dc3545';
const BTN_DISABLED = '#6c757d';

/** いちばん押すボタン（青の塗り）。幅（width / flex）と余白の上下は呼ぶ側で足す */
export function primaryBtn(opts: { disabled?: boolean; danger?: boolean } = {}): React.CSSProperties {
  const { disabled = false, danger = false } = opts;
  return {
    background: disabled ? BTN_DISABLED : danger ? BTN_RED : BTN_BLUE,
    color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 'bold', padding: '12px 0',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
  };
}

/** 戻る・修正する・キャンセル（白地に灰色の枠）。🚨 画面の地が暗いときは isDark を渡す（地が白で固定の確認画面は false） */
export function backBtn(isDark: boolean): React.CSSProperties {
  return {
    background: 'transparent', color: isDark ? '#f8f9fa' : '#212529',
    border: `1px solid ${isDark ? '#6c757d' : '#ced4da'}`, borderRadius: 10, fontSize: 15, padding: '12px 0', cursor: 'pointer',
  };
}

/** 追加など2番目のボタン（薄い青）。大きさは呼ぶ側で足す */
export function tintBtn(isDark: boolean): React.CSSProperties {
  return {
    background: isDark ? '#1e3a5f' : '#e3f2fd', color: isDark ? '#90caf9' : '#1565c0',
    border: `1px solid ${isDark ? '#4a90d9' : '#90caf9'}`, borderRadius: 6, fontWeight: 'bold', cursor: 'pointer',
  };
}
