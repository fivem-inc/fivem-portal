import { useEffect, useRef, useState } from 'react';
import { buildTime, normalizeTime, splitTime } from '../lib/timeInput';

// 時刻の入力欄。時と分を2つの枠に分け、スマホでテンキーが出るようにしたもの。
//
// 🚨 なぜ <input type="time"> をやめたか（2026-08-26・iPhoneユーザーの要望）
//    iOS Safari は type="time" を必ずドラム（ホイール）で表示し、属性でテンキーにできない。
//    分は60項目あり、指で回すのが遅い。
// 🚨 なぜ1つの枠にまとめず「時」「分」に分けたか
//    iOSのテンキーには「:」が無い。1枠にすると `930` としか打てず、
//    `9:3` が 9:30 なのか 9:03 なのか決められない。勝手に決めると27分ズレた数字が
//    正しい顔で通ってしまう（給与に直結する）。2枠なら「9」と「30」で迷いようがない。
// 🚨 文字サイズは16px以上にすること
//    iOSは16px未満のテキスト欄にふれるとページ全体を勝手に拡大する。
//    このアプリは 2026-07-30 に購入申請で一度踏んでいる。
//
// 値の受け渡しは "HH:MM"（ゼロ埋め）か ""（未入力）だけ。
// 中途半端な値は外に出さないので、呼び出し側は今までと同じ扱いでよい。

interface Props {
  value: string;                       // "HH:MM" または ""
  onChange: (v: string) => void;       // "HH:MM" または "" だけを返す
  isDark: boolean;
  /** 分を2桁入れ終わったら、次の時刻欄（DOM上の次の「時」）へ自動で移動する。開始側に付ける */
  advance?: boolean;
  disabled?: boolean;
  /** 送信前チェックなど、外から赤くしたいとき */
  invalid?: boolean;
  ariaLabel?: string;                  // 例：「勤務1 開始時刻」。「〜」の前後は読み上げで区別できないため
  /** 外側の枠に渡すスタイル（flex:1 など。入力欄そのものの見た目は部品側が持つ） */
  style?: React.CSSProperties;
  'data-err-field'?: string;
}

/** 全角数字を半角にして数字だけ取り出し、2桁までに切る */
const digits2 = (raw: string): string =>
  raw.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\D/g, '').slice(0, 2);

/** DOM上で次に来る「時」の欄へ移動する（同じ行の 開始→終了 を想定） */
const focusNextHour = (from: HTMLInputElement) => {
  // 🚨 起点は「分」の欄なので、時の一覧に対する indexOf では見つからない（-1になり先頭へ戻る）。
  //    書類上の前後関係で「自分より後ろにある最初の時の欄」を選ぶこと
  const next = Array.from(document.querySelectorAll<HTMLInputElement>('input[data-time-part="hour"]'))
    .find(el => !el.disabled && (from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  if (next) { next.focus(); next.select(); }
};

const TimeInput: React.FC<Props> = ({
  value, onChange, isDark, advance, disabled, invalid, ariaLabel, style, ...rest
}) => {
  const [hour, setHour] = useState(() => splitTime(value).hour);
  const [minute, setMinute] = useState(() => splitTime(value).minute);
  const [selfInvalid, setSelfInvalid] = useState(false);
  const hourRef = useRef<HTMLInputElement>(null);
  const minuteRef = useRef<HTMLInputElement>(null);
  // 自分が最後に親へ渡した値。親から来た値がこれと同じなら、入力中の表示を書き換えない
  const lastEmitted = useRef(normalizeTime(value) || '');

  useEffect(() => {
    const norm = normalizeTime(value) || '';
    if (norm === lastEmitted.current) return;   // 自分が出した値の往復では同期しない
    const t = splitTime(value);
    setHour(t.hour); setMinute(t.minute);
    setSelfInvalid(false);
    lastEmitted.current = norm;
  }, [value]);

  /** 組み立てて親へ渡す。中途半端な値は渡さない（赤くするだけ） */
  const emit = (h: string, m: string) => {
    const built = buildTime(h, m);
    if (built === null) { setSelfInvalid(true); return; }
    setSelfInvalid(false);
    if (built !== lastEmitted.current) { lastEmitted.current = built; onChange(built); }
  };

  // 🚨 自動移動を onChange だけに任せないこと。
  //    Reactは「入力後の値が前と同じ」ときイベントを起こさない（内部の変更検知の仕様）。
  //    例：時の欄に 9 が入っている状態で選択して 9 を打ち直すと onChange が発火せず、
  //    移動しないまま次の数字が時の欄に入って "93" になる（実機で再現・確認済み）。
  //    そのため打鍵のたびに DOM の実値を見て判定する。二重に呼ばれても移動先は同じで無害。
  const advanceFromHour = () => {
    const d = digits2(hourRef.current?.value ?? '');
    // 3〜9 は次に数字が来ない（90時は無い）ので1桁で確定 → すぐ分へ
    // 0・1・2 は 10〜23時があるので2桁目を待つ
    const done = (d.length === 1 && Number(d) >= 3) || d.length === 2;
    if (done && buildTime(d, digits2(minuteRef.current?.value ?? '')) !== null) {
      minuteRef.current?.focus(); minuteRef.current?.select();
    }
  };
  const advanceFromMinute = () => {
    if (!advance || !minuteRef.current) return;
    const d = digits2(minuteRef.current.value);
    if (d.length === 2 && buildTime(digits2(hourRef.current?.value ?? ''), d) !== null) {
      focusNextHour(minuteRef.current);
    }
  };
  // 🚨 keyup は「押した欄」ではなく「そのとき focus がある欄」で発火する。
  //    時を1文字打つと advanceFromHour が先に分へ移すので、その**同じ打鍵**の keyup が
  //    分の欄で起きる。分が既に埋まっていると（予定のプリフィル等）advanceFromMinute が
  //    走ってしまい、分を飛ばして次の時＝終了へ行く。
  //    実機で「開始の時を入れると分を飛び越えて終了時間に行く」として報告された不具合。
  //    keydown を押した欄と一致するときだけ動かし、打鍵の持ち主を取り違えないようにする。
  const keyDownPart = useRef<'hour' | 'minute' | null>(null);

  /** 数字キーのときだけ移動を試す（矢印・BackSpaceで飛ばないように） */
  const onDigitKeyUp = (e: React.KeyboardEvent<HTMLInputElement>, part: 'hour' | 'minute', fn: () => void) => {
    if (keyDownPart.current !== part) return;   // 別の欄で押された打鍵の keyup は無視する
    if (/^\d$/.test(e.key)) fn();
  };

  // 🚨 相方の欄の値は state ではなく DOM から読むこと。
  //    速く打つと React がまだ state を反映しておらず、古い値で組み立ててしまう。
  //    実際これで「45 と打ったのに 30 に戻る」＝入力が上書きされる不具合が出た（ブラウザで再現）。
  const domHour = () => digits2(hourRef.current?.value ?? '');
  const domMinute = () => digits2(minuteRef.current?.value ?? '');

  const onHour = (raw: string) => {
    const d = digits2(raw);
    setHour(d);
    emit(d, domMinute());
    advanceFromHour();
  };

  const onMinute = (raw: string) => {
    const d = digits2(raw);
    setMinute(d);
    emit(domHour(), d);
    advanceFromMinute();
  };

  /** 分が空のときにバックスペースを押したら時の欄へ戻す（打ち直しやすく） */
  const onMinuteKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    keyDownPart.current = 'minute';
    if (e.key === 'Backspace' && !domMinute()) { hourRef.current?.focus(); hourRef.current?.select(); }
  };

  /** 部品の外へフォーカスが出たときだけ整形する（時→分の内部移動では整形しない） */
  const onBlurContainer = (e: React.FocusEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    const built = buildTime(domHour(), domMinute());   // ここも DOM の実値から組み立てる
    if (built === null) { setSelfInvalid(true); return; }   // 打った文字は消さずに残す
    setSelfInvalid(false);
    const t = splitTime(built);
    setHour(t.hour); setMinute(t.minute);                    // 分の 00 補完はここで画面に出る
    if (built !== lastEmitted.current) { lastEmitted.current = built; onChange(built); }
  };

  const bad = invalid || selfInvalid;
  const border = bad ? '#e24b4a' : (isDark ? '#495057' : '#dee2e6');
  const field: React.CSSProperties = {
    flex: 1, minWidth: 0, width: '100%', textAlign: 'center',
    padding: '7px 2px', borderRadius: 8,
    border: `1px solid ${border}`,
    background: disabled ? (isDark ? '#3a3f44' : '#e9ecef') : (isDark ? '#495057' : '#fff'),
    color: isDark ? '#f8f9fa' : '#212529',
    fontSize: 16,   // 🚨 16px未満にしないこと（iOSが画面を勝手に拡大する）
    boxSizing: 'border-box',
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, ...style }} onBlur={onBlurContainer}>
      <input
        ref={hourRef} data-time-part="hour" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off"
        maxLength={2} disabled={disabled} value={hour} placeholder="9"
        onChange={e => onHour(e.target.value)} onFocus={e => e.target.select()}
        onKeyDown={() => { keyDownPart.current = 'hour'; }} onKeyUp={e => onDigitKeyUp(e, 'hour', advanceFromHour)}
        aria-label={ariaLabel ? `${ariaLabel}（時）` : '時'} aria-invalid={bad || undefined}
        style={field} {...rest}
      />
      <span style={{ fontSize: 14, color: isDark ? '#adb5bd' : '#6c757d' }}>:</span>
      <input
        ref={minuteRef} data-time-part="minute" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off"
        maxLength={2} disabled={disabled} value={minute} placeholder="30"
        onChange={e => onMinute(e.target.value)} onFocus={e => e.target.select()} onKeyDown={onMinuteKeyDown} onKeyUp={e => onDigitKeyUp(e, 'minute', advanceFromMinute)}
        aria-label={ariaLabel ? `${ariaLabel}（分）` : '分'} aria-invalid={bad || undefined}
        style={field}
      />
    </div>
  );
};

export default TimeInput;
