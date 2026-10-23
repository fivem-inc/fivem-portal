// 申請の［削除］（休暇・残業・勤務変更・交通費）。2026-10-23 ユーザー確定 案A・理由は必須
//
// 🚨 画面から申請を消すときは、表を直接 .delete() せず必ずここを通す。
//    DB の関数 delete_applications が理由を受け取り、消す直前にトリガー（log_application_deletion）が
//    消す前の中身・消した人・日時・理由を application_deletion_log に残す（管理画面「修正依頼」の「削除の記録」で見る）。
//    直接 .delete() しても記録は残るが、理由が空になる。
// 🚨 消せるかどうかは今までどおり各表の RLS が決める（関数は SECURITY INVOKER）。消せなかった分は件数に入らない
import { supabase } from './supabaseClient';

export type DeleteKind = 'leave' | 'overtime' | 'shift' | 'expense';

/** 理由の欄の下に出す、押すだけで入る理由 */
export const DELETE_REASON_PRESETS = ['二重に入っていたため', '試しに入れたため', '本人の依頼'];

export const DELETE_REASON_MAX = 200;

/** 消した件数と、失敗したときの文（成功なら null） */
export async function deleteApplications(kind: DeleteKind, ids: string[], reason: string): Promise<{ n: number; error: string | null }> {
  const r = reason.trim();
  if (!r) return { n: 0, error: '削除の理由を入力してください' };
  const { data, error } = await supabase.rpc('delete_applications', { p_kind: kind, p_ids: ids, p_reason: r });
  if (error) return { n: 0, error: `削除できませんでした：${error.message}` };
  const n = typeof data === 'number' ? data : 0;
  if (n < ids.length) return { n, error: n === 0 ? '削除できませんでした（権限が無いか、すでに消えています）。一覧を読み直してください。' : `${ids.length}件のうち${n}件だけ削除しました。一覧を読み直してください。` };
  return { n, error: null };
}
