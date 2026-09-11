// 休暇の日付の書き方（2026-09-11 ユーザー確定）。受理の画面と本人の履歴が**この1か所**を呼ぶ。
//   1日      … 2026年10月3日（土）（1日間）
//   連続     … 2026年10月3日（土） ～ 2026年10月5日（月）（3日間）
//   飛び飛び … 2026年10月3日（土）・10月5日（月）（2日間）  ※年が変わるときだけ年を付け直す
// 🚨 日数は「実際に休む日の数」（leave_dates の件数）。開始〜終了の範囲で数えると、
//    飛び飛びの申請で実際より多く出る（本番に2件ある）。
// 🚨 月・日の頭にゼロを付けない（「09/03」ではなく「9/3」）。
// 🚨 通知・メール・Slack の文面は lib/notifications.ts の formatLeaveDateSummary が別に作っている。
//    文面を変えると一斉に届く内容が変わるので、ここと混ぜない。

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

/** 'YYYY-MM-DD' を数に分ける。形が違えば null */
const split = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
};

/** 翌日の 'YYYY-MM-DD'。🚨 Date.UTC で組み立てているので toISOString でも日付がずれない */
const nextDay = (s: string) => {
  const p = split(s)!;
  return new Date(Date.UTC(p.y, p.m - 1, p.d + 1)).toISOString().slice(0, 10);
};

/** 🚨 曜日は末尾に T00:00:00 を付けて端末の時刻として読む（付けないと UTC 扱いで前日になる端末がある） */
const weekday = (s: string) => WEEK[new Date(`${s}T00:00:00`).getDay()];

const jpDate = (s: string, withYear: boolean) => {
  const p = split(s);
  if (!p) return s;
  return `${withYear ? `${p.y}年` : ''}${p.m}月${p.d}日（${weekday(s)}）`;
};

/** 短い形（管理画面の一覧用）。'2026-09-03' → '9/3'（withYear なら '2026/9/3'） */
export function shortLeaveDate(s: string | null | undefined, withYear = false): string {
  if (!s) return '';
  const p = split(s);
  if (!p) return s;
  return withYear ? `${p.y}/${p.m}/${p.d}` : `${p.m}/${p.d}`;
}

/** 休む日の一覧（並べ替え・重複なし）。leave_dates が無い旧申請は開始〜終了を1日ずつ展開する */
export function leaveDateList(
  leaveDates: string | null | undefined,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): string[] {
  let dates: string[] = [];
  try {
    const v: unknown = leaveDates ? JSON.parse(leaveDates) : [];
    if (Array.isArray(v)) dates = v.filter((x): x is string => typeof x === 'string' && split(x) !== null);
  } catch { /* 読めないときは下で範囲から作る */ }
  if (dates.length === 0 && startDate && endDate && split(startDate) && split(endDate)) {
    // 366 は打ち間違いの日付で止まらなくなるのを防ぐ上限
    for (let d = startDate, i = 0; d <= endDate && i < 366; d = nextDay(d), i++) dates.push(d);
  }
  return [...new Set(dates)].sort();
}

/** 休暇の期間を画面に出す文字にする（書き方はファイル冒頭） */
export function formatLeavePeriod(
  leaveDates: string | null | undefined,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): string {
  const dates = leaveDateList(leaveDates, startDate, endDate);
  const n = dates.length;
  if (n === 0) return startDate ?? '';
  if (n === 1) return `${jpDate(dates[0], true)}（1日間）`;
  const consecutive = dates.every((d, i) => i === 0 || nextDay(dates[i - 1]) === d);
  if (consecutive) return `${jpDate(dates[0], true)} ～ ${jpDate(dates[n - 1], true)}（${n}日間）`;
  const list = dates.map((d, i) => jpDate(d, i === 0 || d.slice(0, 4) !== dates[i - 1].slice(0, 4))).join('・');
  return `${list}（${n}日間）`;
}
