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

/**
 * 奨励日の回答の選択肢（2026-10-19 ユーザー確定・計画 docs/計画-有休奨励日の申請止め.md）。
 * 回答の画面（components/EncouragementAnswerModal）と管理画面の回答の修正が同じものを使う。
 * 🚨 数字は DB の paid_leave_encouragement_responses.choice と answer_encouragement_day に合わせる（変えない）
 *   4 は「出勤する」（working=true・休暇は作らない）。working が空の4は 2026-10-19 より前の回答（休暇「その他」を作ったもの）
 *   5 は「ほかの休みを申請する」（休暇は作らない・慶弔は休暇申請、振替休日・欠勤は残業申請から別に出してもらう）
 */
export interface EncChoice { value: 1 | 2 | 3 | 4 | 5; label: string; sub: string; color: string; needsNote: boolean; working?: boolean }
export const ENC_CHOICES: EncChoice[] = [
  { value: 1, label: '有給休暇', sub: '', color: '#28a745', needsNote: false },
  { value: 2, label: '時間外調整休', sub: '', color: '#fd7e14', needsNote: false },
  { value: 3, label: '定休日', sub: '', color: '#17a2b8', needsNote: false },
  { value: 4, label: '出勤する（イベント・会議など）', sub: '休暇は作られません', color: '#6c757d', needsNote: true, working: true },
  { value: 5, label: 'ほかの休みを申請する（慶弔・振替休日・欠勤）', sub: '', color: '#6c757d', needsNote: true },
];

/** 選択肢5のときの案内（どこから申請するか） */
export const ENC_OTHER_LEAVE_GUIDE = 'この回答では休暇は作られません。慶弔休暇は「休暇申請」、振替休日・欠勤は「残業申請」から、別に申請してください。';

/** 回答の名前（管理画面の一覧など）。昔の「その他」（出勤のチェックの記録が無い4）も読めるように */
export function encChoiceLabel(choice: number | null | undefined, working?: boolean | null): string {
  if (choice === 4) {
    if (working === true) return '出勤する';
    if (working === false) return 'その他（休む）';
    return 'その他';
  }
  return ENC_CHOICES.find(c => c.value === choice)?.label ?? '';
}
