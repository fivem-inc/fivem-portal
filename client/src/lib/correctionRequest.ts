import { supabase } from './supabaseClient'

// 修正依頼（本人→管理者）の種別
export type CorrectionTargetType = 'leave' | 'shift' | 'overtime'

// 構造化した希望値（管理者に旧→新が一目で伝わる）。自由記述(message)は別で送る。
export interface CorrectionChange {
  label: string   // 項目名（例：日付 / 校 / 時間）
  from: string    // 現在の値
  to: string      // 希望する値
}

export type CorrectionRequestKind = 'edit' | 'cancel'

export interface CorrectionRequestRow {
  id: string
  target_type: CorrectionTargetType
  target_id: string
  requester_id: string
  request_kind: CorrectionRequestKind
  message: string
  requested_changes: CorrectionChange[] | null
  status: 'open' | 'resolved' | 'declined' | 'withdrawn'
  admin_reply: string | null
  resolved_by: string | null
  resolved_at: string | null
  created_at: string
}

// バッジ（未対応件数）の再取得を各所に促すイベント。既存の *-pending-changed に合わせる。
export function notifyCorrectionChanged() {
  window.dispatchEvent(new Event('correction-pending-changed'))
}

// Slack通知（best-effort）。失敗しても保存は成立させる＝呼び出し側で握りつぶす。
async function sendCorrectionSlack(body: {
  targetType: CorrectionTargetType
  requesterName: string
  targetLabel: string
  message: string
  changesText: string
}) {
  try {
    await supabase.functions.invoke('send-correction-slack', { body })
  } catch (e) {
    console.error('修正依頼Slack通知エラー:', e)
  }
}

// 本人が修正依頼／取消依頼を送る。成功でidを返す。二重open等はerrorで返る。
export async function submitCorrectionRequest(args: {
  targetType: CorrectionTargetType
  targetId: string
  message: string
  changes: CorrectionChange[]
  requestKind: CorrectionRequestKind
  // Slack用の表示情報
  requesterName: string
  targetLabel: string
}): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await supabase.rpc('submit_correction_request', {
    p_target_type: args.targetType,
    p_target_id: args.targetId,
    p_message: args.message,
    p_requested_changes: args.changes.length ? args.changes : null,
    p_request_kind: args.requestKind,
  })
  if (error) return { id: null, error: error.message }

  notifyCorrectionChanged()
  const changesText = args.requestKind === 'cancel'
    ? '（この申請の取り消し）'
    : args.changes.map(c => `${c.label}：${c.from}→${c.to}`).join(' / ')
  await sendCorrectionSlack({
    targetType: args.targetType,
    requesterName: args.requesterName,
    targetLabel: args.targetLabel,
    message: args.message,
    changesText,
  })
  return { id: (data as string) ?? null, error: null }
}

// 本人が自分の未対応(open)依頼を取り下げる
export async function withdrawCorrectionRequest(id: string): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('withdraw_correction_request', { p_id: id })
  if (!error) notifyCorrectionChanged()
  return { error: error?.message ?? null }
}

// 管理者：対応済みにする
export async function resolveCorrectionRequest(id: string, adminReply?: string): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('resolve_correction_request', {
    p_id: id,
    p_admin_reply: adminReply?.trim() || null,
  })
  if (!error) notifyCorrectionChanged()
  return { error: error?.message ?? null }
}

// 管理者：対応不可にする（理由必須）
export async function declineCorrectionRequest(id: string, reason: string): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('decline_correction_request', {
    p_id: id,
    p_reason: reason,
  })
  if (!error) notifyCorrectionChanged()
  return { error: error?.message ?? null }
}

// 本人の履歴カードに「修正依頼中/対応済み」を出すため、対象申請の最新依頼を引く。
// target_id配列で一括取得し、target_id→最新row のMapを返す。
export async function fetchLatestCorrectionByTarget(
  targetType: CorrectionTargetType,
  targetIds: string[],
): Promise<Map<string, CorrectionRequestRow>> {
  const map = new Map<string, CorrectionRequestRow>()
  if (targetIds.length === 0) return map
  const { data } = await supabase
    .from('correction_requests')
    .select('*')
    .eq('target_type', targetType)
    .in('target_id', targetIds)
    .order('created_at', { ascending: false })
  for (const row of (data as CorrectionRequestRow[] | null) ?? []) {
    if (!map.has(row.target_id)) map.set(row.target_id, row) // 先頭＝最新
  }
  return map
}
