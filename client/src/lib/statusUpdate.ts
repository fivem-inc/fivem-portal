// 申請の「状態を変える1文」を、失敗が必ず見える形で書くための共通処理。
//
// 【なぜ要るか（2026-09-09）】
// このリポジトリでは同じ書き方が2通りに割れていた。
//   ・スタッフ側（LeaveApprovals）… .eq('status', 元の状態).select('id') で競合まで見る
//   ・管理画面（LeaveRequestsTab）… 戻り値を受けず、失敗しても素通り
// 同じ leave_requests の同じ状態遷移なのに、片方だけが守られている状態だった。
// エラー表示を共通化しても、この食い違いは直らない。**書き方そのもの**を1本にする。
//
// 【いちばん大事な前提】
// 🚨 RLS（権限）で弾かれた update は、error ではなく「0件成功」で返る。
//    だから error を見るだけでは足りず、必ず .select('id') の件数を見る。
//    2026-09-09 の実例：勤務変更報告の受理が通っていないのに、
//    申請者へ「受理されました」と通知が飛んでいた。
//
// 🚨 このファイルは supabase を import しない（クエリは呼び出し側から渡す）。
//    画面を開かずに検算できる形を保つため。

import { isTransientFailure } from './netFailure';

/** update(...).select('id') の戻りだけを受け取れる、最小の形 */
export interface UpdateOutcome {
  data: { id: string }[] | null;
  error: { message: string; code?: string } | null;
  /** supabase が返す HTTP ステータス。0/未設定＝通信が届かなかった。渡すと文言が変わる */
  status?: number | null;
}

/**
 * 件数0になる理由は3つあり、利用者が次にすべきことが違うので文言を分ける。
 *   competing … 他の人が先に状態を変えた（→ 一覧を更新して確認する）
 *   missing   … 権限が無い／対象が消えている（→ 管理者に相談する。自分では解決できない）
 * 🚨 この2つを混ぜないこと。混ぜると「更新すれば直る」のか
 *    「自分では無理」なのかが伝わらない。
 */
export type ZeroRowReason = 'competing' | 'missing';

/**
 * 状態変更の結果を、画面にそのまま出せる1行の文にする。
 * 成功なら null を返す（purchaseApprovalActions.ts と同じ約束）。
 *
 * @param outcome  supabase の update(...).select('id') の戻り
 * @param actionLabel 「受理」「差し戻し」など、利用者が押したボタンの言葉
 * @param zeroReason  件数0のときにどちらの理由として扱うか
 */
export function describeUpdate(
  outcome: UpdateOutcome,
  actionLabel: string,
  zeroReason: ZeroRowReason,
): string | null {
  if (outcome.error) {
    // 🚨 「もう一度で直る失敗」と「何度やっても直らない失敗」を言い分ける。
    //    利用者がすべきことが正反対で、これを混ぜると
    //    直る失敗なのに諦めさせ、直らない失敗を延々と押させることになる。
    //    判定は lib/netFailure.ts の1本に任せる（文字列で判定しない。
    //    iPhone Safari の失敗は "Load failed" で "fetch" も "network" も入らないため）。
    if (isTransientFailure(outcome.status, outcome.error)) {
      return `通信が不安定なようです。少し待ってから、もう一度お試しください（${actionLabel}は行われていません）`;
    }
    return `${actionLabel}に失敗しました：${outcome.error.message}`;
  }
  if (!outcome.data || outcome.data.length === 0) {
    return zeroReason === 'competing'
      // 文言は purchaseApprovalActions.ts の既存のものに合わせる（2か所に別の言い方を作らない）
      ? '他の操作によりステータスが変わっているため、この操作は反映されませんでした。一覧を更新してご確認ください。'
      : `${actionLabel}できませんでした（権限が不足しているか、すでに取消・削除されています）`;
  }
  return null;
}

/**
 * 「DBは確定したが、そのあとの外部処理（Googleカレンダー・メール・Slack）が失敗した」ときの文。
 * 🚨 これを赤（失敗）で出さないこと。本体は成立しているので、
 *    赤にすると「できなかった」と読まれ、今度は逆向きの誤解になる。
 */
export function describePartial(actionLabel: string, whatFailed: string): string {
  return `${actionLabel}は完了しましたが、${whatFailed}。お手数ですが内容をご確認ください。`;
}
