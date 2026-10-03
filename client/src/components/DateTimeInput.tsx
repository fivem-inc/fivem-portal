import TimeInput from './TimeInput';
import { joinDateTime, splitDateTime } from '../lib/dateTimeValue';

// 日付＋時刻の入力欄（送信予約・期限・表示期間）。日付は日付選び、時刻は TimeInput（時・分の2枠）。
// 値の形と、途中の値を捨てない理由は lib/dateTimeValue.ts を参照。
// 🚨 <input type="datetime-local"> に戻さないこと（iPhone で時刻を数字で打てない）。

interface Props {
  value: string;
  onChange: (v: string) => void;
  isDark: boolean;
  /** 日付の下限・上限（'YYYY-MM-DD'）。時刻までは縛らない（送信前に dateTimeProblem で確かめる） */
  minDate?: string;
  maxDate?: string;
  invalid?: boolean;
  ariaLabel?: string;                  // 例：「送信予約」→「送信予約（日付）」「送信予約（時）」
  style?: React.CSSProperties;
  id?: string;                         // <label htmlFor> 用。日付の欄に付ける
}

const DateTimeInput: React.FC<Props> = ({ value, onChange, isDark, minDate, maxDate, invalid, ariaLabel, style, id }) => {
  const { date, time } = splitDateTime(value);
  // 色と文字の大きさは TimeInput にそろえる（1つの欄に見えるように）
  const dateStyle: React.CSSProperties = {
    flex: '1 1 140px', minWidth: 130, padding: '7px 8px', borderRadius: 8,
    border: `1px solid ${invalid ? '#e24b4a' : (isDark ? '#495057' : '#dee2e6')}`,
    background: isDark ? '#495057' : '#fff', color: isDark ? '#f8f9fa' : '#212529',
    fontSize: 16,   // 🚨 16px未満にしないこと（iOSが画面を勝手に拡大する）
    colorScheme: isDark ? 'dark' : 'light', boxSizing: 'border-box',
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', ...style }}>
      <input id={id} type="date" value={date} min={minDate} max={maxDate}
        onChange={e => onChange(joinDateTime(e.target.value, time))}
        aria-label={ariaLabel ? `${ariaLabel}（日付）` : '日付'} aria-invalid={invalid || undefined}
        style={dateStyle} />
      <TimeInput value={time} onChange={t => onChange(joinDateTime(date, t))} isDark={isDark}
        invalid={invalid} ariaLabel={ariaLabel} style={{ width: 112, flex: '0 0 auto' }} />
    </div>
  );
};

export default DateTimeInput;
