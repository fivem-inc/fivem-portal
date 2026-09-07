// 社外FAQ集計の「期間の組み立て」だけを切り出したもの。
// 🚨 supabase を読まない側に置くこと。ここに置けば画面を開かずに検算できる。
//    日付の境目（JSTかUTCか・終了日を含むか）は間違えやすく、しかも間違えても
//    画面上は「それらしい数字」が出てしまうため、機械で確かめられる形にしている。

/** 月の初日 / 翌月の初日（JST）。
 *  🚨 toISOString() は UTC なので使わない。日付の境目が9時間ずれて前日になる */
export const monthRange = (ym: string): { from: string; to: string } => {
  const [y, m] = ym.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { from: `${ym}-01T00:00:00+09:00`, to: `${next}-01T00:00:00+09:00` };
};

export const addMonth = (ym: string, diff: number): string => {
  const [y, m] = ym.split('-').map(Number);
  const t = (y * 12 + (m - 1)) + diff;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

export const thisMonth = (): string => {
  const now = new Date();
  // 端末時刻そのままでよい（日本国内で使う画面）
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

export const todayStr = (): string => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
};

/** 期間の選び方 */
export type Mode = 'month' | 'year' | 'range';
/** 何と比べるか */
export type Compare = 'none' | 'prev' | 'lastYear';

export interface Span { from: string; to: string; label: string }

/** 日付を1日ずらす（境目の計算用）。JSTの日付文字列（YYYY-MM-DD）を返す */
export const shiftDay = (d: string, days: number): string => {
  const t = new Date(`${d}T12:00:00+09:00`);   // 昼で計算して夏時間・境目の丸めを避ける
  t.setDate(t.getDate() + days);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

/** その期間が何日ぶんか */
export const daysBetween = (from: string, to: string): number =>
  Math.round((new Date(`${to}T12:00:00+09:00`).getTime() - new Date(`${from}T12:00:00+09:00`).getTime()) / 86400000);

/** 選んだ期間を、DBに渡す形（JSTの境目つき）に組み立てる。
 *  🚨 境目は必ず +09:00 で作る。toISOString だと UTC になり、丸1日ずれる */
export const spanOf = (mode: Mode, ym: string, year: number, from: string, to: string): Span => {
  if (mode === 'month') {
    const r = monthRange(ym);
    return { from: r.from, to: r.to, label: ym };
  }
  if (mode === 'year') {
    return { from: `${year}-01-01T00:00:00+09:00`, to: `${year + 1}-01-01T00:00:00+09:00`, label: `${year}年` };
  }
  // 期間を指定。終了日「も含む」ので、翌日の0時までを見る
  return {
    from: `${from}T00:00:00+09:00`,
    to: `${shiftDay(to, 1)}T00:00:00+09:00`,
    label: `${from} 〜 ${to}`,
  };
};

/** 比べる相手の期間。
 *  ・prev     … 直前の同じ長さ（月なら前月、年なら前年、指定なら同じ日数だけ手前）
 *  ・lastYear … 1年前の同じ期間
 *  🚨 「指定」の prev は日数を数えて手前にずらす。月をまたぐと日数が変わるため、
 *     カレンダー上の「前月」ではなく実日数で合わせる（同じ長さでないと比べられない） */
export const compareSpanOf = (
  cmp: Compare, mode: Mode, ym: string, year: number, from: string, to: string,
): Span | null => {
  if (cmp === 'none') return null;
  if (mode === 'month') {
    const target = cmp === 'prev' ? addMonth(ym, -1) : addMonth(ym, -12);
    const r = monthRange(target);
    return { from: r.from, to: r.to, label: target };
  }
  if (mode === 'year') {
    // 年は prev も lastYear も「前の年」で同じ
    const y = year - 1;
    return { from: `${y}-01-01T00:00:00+09:00`, to: `${y + 1}-01-01T00:00:00+09:00`, label: `${y}年` };
  }
  if (cmp === 'lastYear') {
    const f = `${Number(from.slice(0, 4)) - 1}${from.slice(4)}`;
    const t = `${Number(to.slice(0, 4)) - 1}${to.slice(4)}`;
    return { from: `${f}T00:00:00+09:00`, to: `${shiftDay(t, 1)}T00:00:00+09:00`, label: `${f} 〜 ${t}` };
  }
  // 直前の同じ日数
  const len = daysBetween(from, to) + 1;         // 終了日を含むので +1
  const pTo = shiftDay(from, -1);
  const pFrom = shiftDay(pTo, -(len - 1));
  return { from: `${pFrom}T00:00:00+09:00`, to: `${shiftDay(pTo, 1)}T00:00:00+09:00`, label: `${pFrom} 〜 ${pTo}` };
};

/** 増減の表示。
 *  🚨 色は付けない。問い合わせは「減ったほうが良い」ので、赤字＝悪い という
 *     一般的な感覚と逆になり、色を付けるとかえって読み違える */
export const diffText = (now: number, before: number): string => {
  const d = now - before;
  if (d === 0) return '±0';
  return d > 0 ? `+${d}` : `${d}`;
};

