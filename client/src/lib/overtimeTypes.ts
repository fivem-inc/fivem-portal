// 残業・時間管理の種別定義（本人ページ・管理タブで共通利用）。
// GCal側のタイトル・色・同期可否は supabase/functions/gcal-sync/index.ts の OVERTIME_TYPES と対応。
// ラベルや種別を追加・変更する場合は両方を合わせて更新すること。
export type OvertimeType =
  | 'overtime' | 'early_start' | 'tardiness' | 'early_leave'
  | 'holiday_work' | 'location_change' | 'late_start_adj' | 'early_end_adj';

export const OT_TYPE_INFO: Record<OvertimeType, { label: string; color: string; darkBg: string }> = {
  overtime:        { label: '残業',       color: '#1565c0', darkBg: '#1e3a5f' },
  early_start:     { label: '早出',       color: '#0891b2', darkBg: '#123a42' },
  tardiness:       { label: '遅刻',       color: '#7b1fa2', darkBg: '#3a1f4d' },
  early_leave:     { label: '早退',       color: '#e65100', darkBg: '#4a2c0a' },
  holiday_work:    { label: '休日出勤',   color: '#0f766e', darkBg: '#123a35' },
  location_change: { label: '勤務地変更', color: '#6d28d9', darkBg: '#2e1a5c' },
  late_start_adj:  { label: '調整遅出',   color: '#2e7d32', darkBg: '#1b3a1e' },
  early_end_adj:   { label: '調整早退',   color: '#7d3c98', darkBg: '#3a1f4d' },
};

export function isOvertimeType(t: string): t is OvertimeType {
  return t in OT_TYPE_INFO;
}
