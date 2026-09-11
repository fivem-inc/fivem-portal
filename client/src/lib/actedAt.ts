// 「誰がいつその操作をしたか」の**いつ**を出すときの、共通の書式。
//
// 🚨 同じ意味のものを画面ごとに違う書き方にしない（このリポジトリで何度も起きている）。
//    シフト調整の記録・休暇の受理日時など、**人の操作の記録**はすべてこれを通す。
//
// 🚨 必ず日本時間に直してから取り出す。`toISOString().slice(0,10)` はUTCで切るので、
//    **朝9時より前の操作が前日になる**（実測：2026-09-09 08:05 JST → UTCでは 09-08）。
//
// 🚨 年も時刻も出す（2026-09-11 ユーザー指示）。
//    ・年 … 休暇の記録は年をまたいで残るので、月日だけだと去年のものと区別が付かない
//    ・時刻 … 同じ日に何人かが触ったときの前後を読めるようにするため

/** 例: 2026/9/9 14:30。値が無い・読めないときは空文字（呼び出し側は「何も出さない」） */
export function actedAtLabel(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
