// 残業申請の状態と、その表示（ラベル・色）。
// 🚨 1件フォームの履歴（OvertimePage.tsx）と「表でまとめて入力」（OvertimeGrid.tsx）の両方がここを使う（2026-09-24 に移した）。
//    同じ意味のラベル・色を2か所に書かないこと。

export type OvertimeStatus = 'requested' | 'request_confirmed' | 'reported' | 'confirmed' | 'returned' | 'cancelled';

// ステータス表示（既存STATUS_INFOの配色規約に合わせる。グレー=取消済みのため事後報告はティール）
export const STATUS_INFO: Record<OvertimeStatus, { label: string; color: string; darkBg: string }> = {
  requested:         { label: '事前申請 確認待ち', color: '#e65100', darkBg: '#4a2c0a' },
  request_confirmed: { label: '事前申請 受理済み', color: '#2e7d32', darkBg: '#1b3a1e' },
  reported:          { label: '実績 確認待ち',     color: '#e65100', darkBg: '#4a2c0a' },
  confirmed:         { label: '確認済み',          color: '#1565c0', darkBg: '#1e3a5f' },
  returned:          { label: '差し戻し',          color: '#c62828', darkBg: '#4a1515' },
  cancelled:         { label: '取消済み',          color: '#6c757d', darkBg: '#3a3f44' },
};
