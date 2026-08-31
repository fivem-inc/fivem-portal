import { supabase } from './supabaseClient';
import { insertNotification } from './notifications';
import { getNotificationTemplate } from './notificationDispatch';

// 備品購入申請の「質問・回答」。
// 表示は履歴・承認画面・管理画面の3か所にあるが、取得も投稿もここに集約する
// （同じUIとロジックを3か所に書くと、必ず片方だけ直す事故になる）。

export interface PurchaseComment {
  id: string;
  purchase_request_id: string;
  author_id: string;
  body: string;
  created_at: string;
  // 共有ファイル（承認後に届く確定見積書・納品書など）。未添付なら null。
  // 承認の根拠になった相見積もり（purchase_request_item_quotes）は承認確定後に
  // 書き換えられない仕様なので、あとから届いたものはここに「追記」として残す。
  file_path: string | null;
  file_label: string | null;   // 種類の名札（確定見積書／納品書 など）
}

/** 申請idの配列に対する質問・回答をまとめて取得（古い順） */
export async function fetchPurchaseComments(
  requestIds: string[],
): Promise<Record<string, PurchaseComment[]>> {
  if (requestIds.length === 0) return {};
  const { data, error } = await supabase
    .from('purchase_request_comments')
    .select('id, purchase_request_id, author_id, body, created_at, file_path, file_label')
    .in('purchase_request_id', requestIds)
    .order('created_at');
  if (error) return {};
  const byId: Record<string, PurchaseComment[]> = {};
  (data ?? []).forEach(c => {
    (byId[(c as PurchaseComment).purchase_request_id] ??= []).push(c as PurchaseComment);
  });
  return byId;
}

/**
 * 質問・回答を投稿し、関係者へ通知する。
 * 通知先＝申請者 ∪ その申請の承認者 ∪ すでに書いた人 ∪ マネージャー以上全員 − 投稿者本人
 * （閲覧は「申請が見える人だけ」だが、通知はマネージャー以上にも届ける＝ユーザー決定）
 *
 * ⚠️ source_type は既存の 'purchase_request' を使い回す。
 *    新しい source_type を作ると App.tsx の分岐・除外リスト・自動消し込みの
 *    どれかが漏れて「消えないバナー」や「タップしても何も起きない」が生まれる。
 */
export async function postPurchaseComment(params: {
  requestId: string;
  body: string;
  authorId: string;
  authorName: string;
  itemName: string;
  // 共有ファイル（任意・複数可）。DBは1行=1ファイルなので、
  // 2件以上は行を分けて保存する（本文は先頭の行にだけ持たせる）
  files?: { path: string; label: string | null }[];
}): Promise<{ ok: boolean; error?: string }> {
  const body = params.body.trim();
  const files = (params.files ?? []).map(f => ({
    path: f.path,
    label: f.label?.trim() || '共有ファイル',
  }));
  // ファイルだけの共有も許す（「確定見積書を貼るだけ」という使い方があるため）
  if (!body && files.length === 0) {
    return { ok: false, error: '内容を入力するか、ファイルを添付してください' };
  }

  const rows = files.length === 0
    ? [{ body, file_path: null as string | null, file_label: null as string | null }]
    : files.map((f, i) => ({ body: i === 0 ? body : '', file_path: f.path, file_label: f.label }));

  const { error } = await supabase.from('purchase_request_comments').insert(
    rows.map(r => ({
      purchase_request_id: params.requestId,
      author_id: params.authorId,
      ...r,
    })),
  );
  if (error) return { ok: false, error: error.message };

  // 通知は投稿の成否と切り離す（通知が失敗しても投稿は成立している）
  try {
    const targets = new Set<string>();

    const { data: req } = await supabase.from('purchase_requests')
      .select('user_id, leader_id, requested_manager_ids, shared_manager_ids, board_approver_ids')
      .eq('id', params.requestId).maybeSingle();
    if (req) {
      const r = req as {
        user_id: string; leader_id: string | null;
        requested_manager_ids: string[] | null; shared_manager_ids: string[] | null;
        board_approver_ids: string[] | null;
      };
      targets.add(r.user_id);
      if (r.leader_id) targets.add(r.leader_id);
      (r.requested_manager_ids ?? []).forEach(id => targets.add(id));
      (r.shared_manager_ids ?? []).forEach(id => targets.add(id));
      (r.board_approver_ids ?? []).forEach(id => targets.add(id));
    }

    // すでにこのやりとりに書いた人
    const { data: prev } = await supabase.from('purchase_request_comments')
      .select('author_id').eq('purchase_request_id', params.requestId);
    (prev ?? []).forEach(c => targets.add((c as { author_id: string }).author_id));

    // マネージャー以上（申請本体を全件見られる人＝タップして着地できる）
    const { data: mgrs } = await supabase.from('profiles')
      .select('id').eq('is_active', true)
      .in('role_title', ['マネージャー', '社長', '管理者']);
    (mgrs ?? []).forEach(m => targets.add((m as { id: string }).id));

    targets.delete(params.authorId);
    if (targets.size === 0) return { ok: true };

    const tpl = await getNotificationTemplate('purchase_request:comment_added', 'site', {
      投稿者名: params.authorName,
      品目名: params.itemName,
    });
    if (!tpl) return { ok: true };   // 管理画面でOFFにされている

    // 2行目：ファイルがあれば何が共有されたかを出す（本文だけなら従来どおり冒頭40字）。
    // 1行目（tpl.template）は変えない。App.tsx の分岐は1行目の文言を見ており、
    // 「お知らせ」「リマインド」等の語が入ると連絡板の通知と誤判定されるため。
    const sub = files.length > 0
      ? `${files[0].label}${files.length > 1 ? ` 他${files.length - 1}件` : ''}が共有されました${body ? `：${body.slice(0, 30)}` : ''}`
      : (tpl.subject || body.slice(0, 40));

    await Promise.all([...targets].map(id =>
      insertNotification(
        id, tpl.template, sub,
        'purchase_request', params.requestId, 'purchase_request:comment_added',
      ),
    ));
  } catch { /* 通知の失敗で投稿を失敗扱いにしない */ }

  return { ok: true };
}
