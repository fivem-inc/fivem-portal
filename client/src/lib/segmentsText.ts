// 入る時間帯（開始・終了・校）を1行の文にする（2026-09-14）
//
//   [{start:'09:00',end:'12:00',location:'四条本校'},{start:'13:00',end:'18:00',location:'西陣校'}]
//   → 「09:00〜12:00 四条本校 ＋ 13:00〜18:00 西陣校」
//
// 🚨 シフト調整の決定欄・決定の通知・残業ページの依頼カードの3か所が同じ文を出すので、ここ1か所で作る
// 🚨 このファイルは supabase を読まない

export interface SegmentLike {
  start: string;
  end: string;
  location?: string | null;
}

export const segmentsText = (segs: readonly SegmentLike[] | null | undefined): string =>
  (segs ?? [])
    .filter(s => s.start || s.end)
    .map(s => `${s.start}〜${s.end}${s.location ? ` ${s.location}` : ''}`)
    .join(' ＋ ');
