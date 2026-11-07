// 各申請フォームの「入力中の下書き」を端末に自動保存する共通ヘルパー。
//
// 仕様（全フォーム共通・2026-07 統一）:
//   - 入力するたびlocalStorageへ自動保存（無期限）
//   - フォームを開き直すと自動で復元（復元バナーは出さない・黙って残す）
//   - 消えるのは「送信成功時」と「クリアボタン」だけ
//   - スマホで参考情報を別アプリに調べに行って戻っても消えない対策
//
// 既存の備品フォーム(PurchaseRequestForm)は独自実装だが仕様は同じ。
// キーは衝突しないよう fivem_draft_ プレフィックスで統一する。

export const DRAFT_KEYS = {
  expense: 'fivem_draft_expense',        // 交通費（入力中＋追加済みリスト）
  trip: 'fivem_draft_trip',              // 出張報告
  leave: 'fivem_draft_leave',            // 休暇申請
  leaveAdjustment: 'fivem_draft_leave_adjustment', // 時間調整
  attendance: 'fivem_draft_attendance',  // 休暇カレンダーの欠勤入力
  shiftReport: 'fivem_draft_shift_report', // 勤務変更報告
  overtime: 'fivem_draft_overtime',      // 残業・時間管理（正社員）
  // 🚨 保存に失敗した「残業のメモ」だけを端末に1件だけ預ける場所（2026-09-18）。
  //    電車の中など電波の弱い場所で書くことが多く、失敗で入力が消えると機能の意味が無くなるため。
  //    保存できたら消す。ふつうのメモは端末ではなくサーバー（overtime_memos）にある
  overtimeMemoUnsent: 'fivem_draft_overtime_memo_unsent',
  // 残業の「表でまとめて入力」（2026-09-24）。🚨 実際のキーは「これ:利用者ID:給与期間」にする
  //    （共用PCで前の人の時刻・理由が見えないように。期間ごとに別の下書き）
  overtimeGrid: 'fivem_draft_overtime_grid',
  // 残業の［まとめて申請］の箱（2026-09-29）。🚨 実際のキーは「これ:利用者ID」（共用の端末で前の人の入力が見えないように）
  overtimeBox: 'fivem_draft_overtime_box',
  boardCompose: 'fivem_draft_board_compose', // 連絡板お知らせ作成
  boardChat: 'fivem_draft_board_chat',   // 連絡板グループ/DM/リプライ（キー配下にIDで細分化）
} as const;

// 下書きが消えた合図（components/DraftRestoredLine が「前回の入力の続き」の1行を消すのに使う・2026-11-07）
export const DRAFT_CLEARED_EVENT = 'fivem-draft-cleared';

// ほかの画面が中身を入れてからフォームを開くとき（表から申請・申請の依頼・写して作る など）はこちらで保存する。
// 🚨 印（__prefill）が付くので「前回の入力の続き」の1行を出さない。フォームの自動保存（saveDraft）で印は消える
export function savePrefillDraft(key: string, data: object): void {
  saveDraft(key, { ...data, __prefill: true });
}
// 開いた時点の下書きが「人が入力した前回の分」か（prefill の印が無い）
export function isUserDraft(d: unknown): boolean {
  return !!d && typeof d === 'object' && !(d as { __prefill?: boolean }).__prefill;
}

export function loadDraft<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveDraft(key: string, data: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* 保存容量超過などは無視（下書きは無くても致命的ではない） */
  }
}

export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  try { window.dispatchEvent(new CustomEvent(DRAFT_CLEARED_EVENT, { detail: key })); } catch { /* ignore */ }
}

// 連絡板のチャット系（チャンネル/相手/元メッセージごとに書きかけを分ける）用。
// 1つのJSONに { [subKey]: text } でまとめて持つ。
export function loadChatDraft(subKey: string): string {
  const map = loadDraft<Record<string, string>>(DRAFT_KEYS.boardChat) ?? {};
  return map[subKey] ?? '';
}

export function saveChatDraft(subKey: string, text: string): void {
  const map = loadDraft<Record<string, string>>(DRAFT_KEYS.boardChat) ?? {};
  if (text) map[subKey] = text;
  else delete map[subKey];
  saveDraft(DRAFT_KEYS.boardChat, map);
}
