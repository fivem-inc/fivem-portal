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

// 表で見る（部門集計の人の画面・ご本人の履歴）の1文字の印（2026-10-31 ユーザー確定）。読み方は表の上に出す
export const STATUS_MARK: Record<OvertimeStatus, string> = {
  requested: '待', request_confirmed: '受', reported: '待', confirmed: '済', returned: '戻', cancelled: '消',
};
/** 印の読み方（表の上の1行）。同じ字が2つの状態にあるので、状態ではなく字ごとに書く */
export const STATUS_MARK_LEGEND: Record<string, string> = {
  受: '受理済み（あとで報告）', 済: '確定', 待: '確認待ち', 戻: '差し戻し', 消: '取消',
};
