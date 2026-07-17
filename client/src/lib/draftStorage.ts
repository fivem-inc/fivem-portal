// 各申請フォームの「入力中の下書き」を端末に自動保存する共通ヘルパー。
//
// 仕様（全フォーム共通・2026-07 統一）:
//   - 入力するたびlocalStorageへ自動保存（無期限）
//   - フォームを開き直すと自動で復元（復元バナーは出さない・黙って残す）
//   - 消えるのは「送信成功時」と「🗑クリアボタン」だけ
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
  boardCompose: 'fivem_draft_board_compose', // 連絡板お知らせ作成
  boardChat: 'fivem_draft_board_chat',   // 連絡板グループ/DM/リプライ（キー配下にIDで細分化）
} as const;

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
