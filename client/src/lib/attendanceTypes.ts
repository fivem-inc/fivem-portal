// 勤怠入力（attendance_exceptions）の種別ラベル・配色・勤務時間帯の整形。
//
// これまで CalendarPage.tsx と admin/LeaveRequestsTab.tsx に同じ表が別々に存在し、
// ラベルがずれていた（遅出(調整) / 遅出）。片方だけに種別を足すと、もう片方は
// undefined を参照して画面が真っ白になるため、ここを唯一の定義とする。

export type AttendanceType =
  | 'absent' | 'late' | 'early_leave' | 'late_start' | 'early_end' | 'holiday_work' | 'location_change';

/** 勤務時間帯（1日の中で校を移動する場合や、間に勤務しない時間がある場合に複数持つ） */
export interface WorkSegment {
  start: string;    // 'HH:MM'
  end: string;      // 'HH:MM'
  location: string; // 校名（「その他」を選んだ場合は自由入力の値そのもの）
}

export const ABSENCE_LABEL: Record<string, string> = {
  absent:          '全欠勤',
  late:            '遅刻',
  early_leave:     '早退',
  late_start:      '遅出(調整)',
  early_end:       '早退(調整)',
  holiday_work:    '休日出勤',
  location_change: '勤務地変更',
};

// 一覧・カレンダーのバッジ色。ダークな背景の上でも沈まないよう、ベタ塗り＋白文字を基本にする。
export const ABSENCE_COLOR: Record<string, { bg: string; text: string }> = {
  absent:          { bg: '#fde8e8', text: '#c0392b' },
  late:            { bg: '#ff9800', text: '#fff' },
  early_leave:     { bg: '#1565c0', text: '#fff' },
  late_start:      { bg: '#558b2f', text: '#fff' },
  early_end:       { bg: '#7b1fa2', text: '#fff' },
  holiday_work:    { bg: '#0f766e', text: '#fff' },
  location_change: { bg: '#6d28d9', text: '#fff' },
};

// 入力シートのチェックボックスと同じ絵文字（確認画面・一覧で見分けやすくするため）
export const ABSENCE_EMOJI: Record<string, string> = {
  absent:          '🔴',
  late:            '🟠',
  early_leave:     '🔵',
  late_start:      '🟢',
  early_end:       '🟣',
  holiday_work:    '🏢',
  location_change: '📍',
};

/** 種別が未知でも画面を落とさないためのフォールバック付き取得 */
export const absenceLabel = (type: string): string => ABSENCE_LABEL[type] ?? type;
export const absenceEmoji = (type: string): string => ABSENCE_EMOJI[type] ?? '';
export const absenceColor = (type: string): { bg: string; text: string } =>
  ABSENCE_COLOR[type] ?? { bg: '#e9ecef', text: '#495057' };

/** DBから来た jsonb を WorkSegment[] として安全に読む（配列でなければ空） */
export const parseSegments = (raw: unknown): WorkSegment[] => {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is WorkSegment =>
    !!s && typeof s === 'object'
    && typeof (s as WorkSegment).start === 'string'
    && typeof (s as WorkSegment).end === 'string'
  );
};

/** 'HH:MM:SS' も 'HH:MM' も表示用の 'H:MM' に揃える（先頭の0は付けない。例: 06:30 → 6:30） */
export const hhmm = (t: string): string => (t || '').slice(0, 5).replace(/^0/, '');

/**
 * 時間帯の一覧表記。確認パネル・月別リストの2行目・Googleカレンダーのタイトルで共用する。
 * 例: '09:00〜12:00［四条本校］/ 14:00〜18:00［洛西口校］'
 * 3箇所で書式がずれる事故を防ぐため、必ずこの関数を通すこと。
 */
export const formatSegments = (segments: WorkSegment[]): string =>
  segments.map(s => `${hhmm(s.start)}〜${hhmm(s.end)}${s.location ? `［${s.location}］` : ''}`).join(' / ');

/** 校を重複なくつないだ表示用の文字列。例: '四条本校→洛西口校'（シフト表の取り込みと同じ書き方） */
export const joinSegmentLocations = (segments: WorkSegment[]): string =>
  [...new Set(segments.map(s => s.location).filter(Boolean))].join('→');
