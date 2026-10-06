// 有休奨励日（会社が指定して年次有給休暇の取得をすすめる日）
// 🚨 2026-10-06 ユーザー確定：画面・通知の言葉は「有休奨励日」に統一する。
// 🚨 ただし保存されている目印は昔の文字「有給奨励日」のまま変えない
//    （休暇の reason='【有給奨励日】'・purpose='有給奨励日'。DB の関数 answer_encouragement_day と
//     shift_adjust_recompute がこの文字で判定している）。目印は下の定数だけを使い、画面に出すときは
//     leavePurposeLabel を通す。
// 🚨 通知の本文は「有給奨励日」（2026-10-06 より前）と「有休奨励日」（それ以降）が混ざるので、
//    見分けるときは isEncouragementText で両方を見る。

/** 画面・通知に出す言葉 */
export const ENC_LABEL = '有休奨励日';

/** 休暇の reason に入れる目印（変えない） */
export const ENC_REASON_MARK = '【有給奨励日】';

/** 休暇の purpose に入れる目印（変えない） */
export const ENC_PURPOSE_MARK = '有給奨励日';

/** 通知の本文が有休奨励日のものか（昔の書き方も含む） */
export function isEncouragementText(s: string | null | undefined): boolean {
  if (!s) return false;
  return s.includes('有休奨励日') || s.includes('有給奨励日');
}

/** 休暇の事由（purpose）を画面に出すときの文字。目印の「有給奨励日」だけ今の言葉に置き換える */
export function leavePurposeLabel(purpose: string | null | undefined): string {
  if (!purpose) return '';
  return purpose === ENC_PURPOSE_MARK ? ENC_LABEL : purpose;
}
