// 日付と時刻をまとめた値（送信予約・期限・表示期間）の組み立てと確認。
// 画面の部品は components/DateTimeInput.tsx。
//
// 🚨 なぜ <input type="datetime-local"> をやめたか（2026-10-03・ユーザー指示）
//    iPhone では時刻がドラム（くるくる回す）でしか選べず、数字で打てない。
//    ほかの画面の時刻は TimeInput（時・分の2枠・テンキー）にそろえてあり、
//    連絡板の送信予約などだけが違う入れ方になっていた。
//
// 値の形（親の state にそのまま持つ）：
//   ''                  … 未入力
//   'YYYY-MM-DDTHH:mm'  … 日付と時刻がそろった（datetime-local と同じ形なので、保存の処理は変えなくてよい）
//   'YYYY-MM-DD'        … 日付だけ入っている（途中）
//   'THH:mm'            … 時刻だけ入っている（途中）
// 🚨 途中の値を捨てて '' にしないこと。日付を選んで時刻を入れ忘れたとき '' になると、
//    「予約なし＝すぐ送る」と区別がつかず、予約したつもりのお知らせが即時に送られてしまう。
//    途中の値は残して、各画面が dateTimeProblem で送信・保存を止める。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

/** 値 → 日付と時刻に分ける。読めない部分は空 */
export function splitDateTime(v: string | null | undefined): { date: string; time: string } {
  const s = (v ?? '').trim();
  if (!s) return { date: '', time: '' };
  const i = s.indexOf('T');
  const date = i >= 0 ? s.slice(0, i) : s;
  const time = i >= 0 ? s.slice(i + 1, i + 6) : '';
  return { date: DATE_RE.test(date) ? date : '', time: TIME_RE.test(time) ? time : '' };
}

/** 日付と時刻 → 値（上の4つの形のどれか） */
export function joinDateTime(date: string, time: string): string {
  if (date && time) return `${date}T${time}`;
  if (date) return date;
  if (time) return `T${time}`;
  return '';
}

/** 日付と時刻の両方がそろっているか */
export const isCompleteDateTime = (v: string | null | undefined): boolean => {
  const { date, time } = splitDateTime(v);
  return !!date && !!time;
};

/**
 * 送信・保存してよいかを確かめる。問題があれば画面に出す文、なければ null。空（未入力）は null。
 *  requireTime … 日付だけでは足りない（送信予約・期限）。false なら日付だけでも通す（お知らせの表示期間：0:00／23:59 とみなす）
 *  future      … 今より後でなければならない（送信予約）
 */
export function dateTimeProblem(
  v: string | null | undefined,
  opts: { requireTime?: boolean; future?: boolean } = {},
): string | null {
  if (!v) return null;
  const { date, time } = splitDateTime(v);
  if (!date) return '日付を選んでください';
  if (!time) return opts.requireTime ? '時刻を入れてください' : null;
  // 🚨 保存側と同じく端末の時刻で解釈する（各画面は new Date(値).toISOString() で保存している）
  if (opts.future && new Date(`${date}T${time}`).getTime() <= Date.now()) return 'この日時はもう過ぎています';
  return null;
}
