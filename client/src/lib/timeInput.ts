// 時刻の入口（入力）と出口（保存）を1本にまとめる共通処理。
//
// 🚨 なぜこれが要るか（2026-08-26・実測で確認）
//    これまで時刻は <input type="time"> だけを使っており、「値は "" か "HH:MM" のどちらか」
//    「00:00〜23:59 に収まる」という保証をブラウザが与えてくれていた。
//    アプリ側に時刻の形式チェックは1か所も無く、その保証だけで成立していた。
//    テキスト入力に変えるとこの保証が消え、崩れると**エラーではなく別の数字が静かに入る**。
//      例1: 勤務変更の休憩計算に "930" を渡すと NaN 経由で最後の return 60 に落ち、
//           警告も出ずに「休憩60分」が記録される（node で実測）
//      例2: PostgreSQL の time 型は寛容で、'930'::time は 09:30:00 として黙って保存される
//    そのため **画面から受け取った時刻は、保存する直前に必ず normalizeTime を通す**こと。
//    null が返ったら保存せず、入力欄を赤くして止める。

/** 全角数字・全角コロン・句点などを半角に寄せる（日本語キーボード対策） */
const toHalfWidth = (s: string): string =>
  s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：∶︓]/g, ':')
    .trim();

/** 時・分が時刻として成り立つか（00:00〜23:59） */
const inRange = (h: number, m: number): boolean =>
  Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59;

/** 時・分 → "HH:MM"（ゼロ埋め） */
const pad = (h: number, m: number): string =>
  `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

/**
 * 時の欄・分の欄の値から "HH:MM" を作る（時/分の2枠入力用）。
 * 分だけ空のときは 00 として扱う（9 → 09:00。画面にも 9:00 と出るので違えば気づける）。
 * 両方空は「未入力」なので '' を返す。不正な値は null。
 */
export function buildTime(hour: string, minute: string): string | null | '' {
  const h = toHalfWidth(hour ?? '');
  const m = toHalfWidth(minute ?? '');
  if (!h && !m) return '';          // 未入力。必須かどうかは各画面の送信前チェックが決める
  if (!h) return null;               // 分だけ入っている＝時の入れ忘れ
  const hn = Number(h), mn = m ? Number(m) : 0;
  if (!/^\d{1,2}$/.test(h) || (m && !/^\d{1,2}$/.test(m))) return null;
  return inRange(hn, mn) ? pad(hn, mn) : null;
}

/**
 * どんな入力でも "HH:MM"（ゼロ埋め）に正規化する。不正なら null、空なら ''。
 * 受け付ける形：`9:30` `09:30` `930` `0930` `9`（＝9:00）／全角数字も可。
 * 🚨 `9:3` `93` のような曖昧な値は **推測せず null にする**。
 *    9:30 と 9:03 では27分ちがい、勝手に決めると誤った数字が正しい顔で通ってしまう。
 */
export function normalizeTime(raw: string | null | undefined): string | null | '' {
  if (raw == null) return '';
  const s = toHalfWidth(String(raw));
  if (!s) return '';
  const colon = /^(\d{1,2}):(\d{2})$/.exec(s);          // 9:30 / 09:30
  if (colon) {
    const h = Number(colon[1]), m = Number(colon[2]);
    return inRange(h, m) ? pad(h, m) : null;
  }
  const digits = /^(\d{1,4})$/.exec(s);
  if (digits) {
    const d = digits[1];
    if (d.length <= 2) {                                 // 9 → 9:00 ／ 17 → 17:00
      const h = Number(d);
      return inRange(h, 0) ? pad(h, 0) : null;
    }
    if (d.length === 3 || d.length === 4) {               // 930 → 9:30 ／ 0930 → 9:30
      const h = Number(d.slice(0, d.length - 2)), m = Number(d.slice(-2));
      return inRange(h, m) ? pad(h, m) : null;
    }
  }
  return null;
}

/**
 * 時刻 → その日の0:00からの分。不正・空は null。
 * 🚨 NaN を返さないこと。NaN は比較がすべて false になるため、
 *    呼び出し側の if 判定を素通りして想定外の分岐に落ちる（休憩60分の事故がこれ）。
 */
export function timeToMinutes(raw: string | null | undefined): number | null {
  const t = normalizeTime(raw);
  if (!t) return null;
  const [h, m] = t.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * DBに保存する直前に通す最後の砦。'' も不正値も null にする。
 * 🚨 PostgreSQL の time 型は入力に寛容で、'930'::time は 09:30:00 として**黙って保存される**。
 *    エラーで気づけないぶん、別の時刻として記録されるほうが危険なのでここで落とす。
 */
export function toDbTime(raw: string | null | undefined): string | null {
  const t = normalizeTime(raw);
  return t ? t : null;
}

/** "HH:MM" → 時の欄・分の欄に入れる値（2枠入力の初期化用）。時のゼロ埋めは外す */
export function splitTime(value: string | null | undefined): { hour: string; minute: string } {
  const t = normalizeTime(value);
  if (!t) return { hour: '', minute: '' };
  const [h, m] = t.split(':');
  return { hour: String(Number(h)), minute: m };
}
