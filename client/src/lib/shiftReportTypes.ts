// 勤務変更の報告の種別（2026-10-21 管理画面の勤務変更タブから移した・［表で見る］と共用）。
// 🚨 種別の名前を画面ごとに書かない
export type ShiftAppType = 'overtime' | 'holiday_work' | 'early_leave' | 'tardiness' | 'absence' | 'early_start' | 'location_change' | 'missed_clock';

export const SHIFT_TYPE_INFO: Record<ShiftAppType, { label: string; color: string; emoji: string }> = {
  overtime:     { label: '残業',     color: '#1565c0', emoji: '⏰' },
  holiday_work: { label: '休日出勤', color: '#0f766e', emoji: '🏢' },
  early_leave:  { label: '早退',     color: '#e65100', emoji: '🏃' },
  tardiness:    { label: '遅刻',     color: '#7b1fa2', emoji: '🕐' },
  absence:      { label: '欠勤',     color: '#c62828', emoji: '❌' },
  early_start:  { label: '早出',     color: '#0891b2', emoji: '🌅' },
  location_change: { label: '勤務地変更', color: '#6d28d9', emoji: '📍' },
  missed_clock: { label: '打刻忘れ', color: '#5a6b7d', emoji: '📋' },
};
