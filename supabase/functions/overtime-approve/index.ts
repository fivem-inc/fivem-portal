// 残業・時間管理の 受理／差し戻し／取消 をサーバー側で一括実行する。
// ステータス更新・通知・GCal同期（gcal-sync action:'sync'）を直列で行い、
// GCal同期の失敗を握りつぶさずクライアントへ返す（同期漏れの静かな発生を防ぐ）。
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const DOW = ['日', '月', '火', '水', '木', '金', '土']
function dowLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return DOW[new Date(y, m - 1, d).getDay()]
}

function formatSignedMin(min: number): string {
  const sign = min > 0 ? '+' : min < 0 ? '-' : '±'
  const abs = Math.abs(min)
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

    // 呼び出し元ユーザーの特定（JWT検証）
    const authHeader = req.headers.get('Authorization') ?? ''
    const jwt = authHeader.replace(/^Bearer\s+/i, '')
    const authClient = createClient(supabaseUrl, anonKey)
    const { data: userData, error: userErr } = await authClient.auth.getUser(jwt)
    if (userErr || !userData?.user) return json({ success: false, error: '認証に失敗しました' }, 401)
    const caller = userData.user
    const isAdmin = (caller.app_metadata?.role ?? '') === 'admin'

    const { report_id, action, comment } = await req.json()
    if (!report_id || !['approve', 'return', 'cancel'].includes(action)) {
      return json({ success: false, error: '不正なリクエストです' }, 400)
    }
    if (action === 'return' && !String(comment ?? '').trim()) {
      return json({ success: false, error: '差し戻しの理由を入力してください' }, 400)
    }

    const db = createClient(supabaseUrl, serviceKey)
    const { data: r, error: loadErr } = await db
      .from('overtime_reports')
      .select('id, applicant_id, reviewer_id, work_date, status, entry_type, diff_minutes, application_types')
      .eq('id', report_id)
      .maybeSingle()
    if (loadErr || !r) return json({ success: false, error: '対象の申請が見つかりません' }, 404)
    if (r.entry_type !== 'manual') return json({ success: false, error: '自動計上分は操作できません' }, 400)

    // 終日種別（調整休・振替休日・欠勤）：実績報告の概念がないため受理で confirmed 直行
    const FULL_DAY = ['chosei_off', 'furikae_off', 'absence']
    const types: string[] = r.application_types ?? []
    const isFullDay = types.some(t => FULL_DAY.includes(t))
    const FULL_DAY_LABEL: Record<string, string> = { chosei_off: '時間外調整休', furikae_off: '振替休日', absence: '欠勤' }
    const fullDayLabel = types.map(t => FULL_DAY_LABEL[t]).filter(Boolean).join('・')

    // 申請者名（通知・GCalタイトル用）
    const { data: prof } = await db.from('profiles').select('name').eq('id', r.applicant_id).maybeSingle()
    const applicantName = prof?.name ?? ''

    let notification: Record<string, unknown> | null = null

    if (action === 'approve') {
      if (!(isAdmin || caller.id === r.reviewer_id)) return json({ success: false, error: '権限がありません' }, 403)
      // 欠勤は本人受理禁止（管理者でも本人なら不可。DB CHECK制約と合わせた3層ガード）
      if (types.includes('absence') && caller.id === r.applicant_id) {
        return json({ success: false, error: '欠勤は本人以外の受理が必要です' }, 403)
      }
      if (!['requested', 'reported'].includes(r.status)) return json({ success: false, error: 'この状態では受理できません' }, 409)
      const isAdvance = r.status === 'requested'
      // 終日は実績報告が無いため、事前申請の受理でも confirmed 直行
      const next = (isAdvance && !isFullDay)
        ? { status: 'request_confirmed' }
        : { status: 'confirmed', confirmed_by: caller.id, confirmed_at: new Date().toISOString() }
      const { error } = await db.from('overtime_reports').update(next).eq('id', r.id).eq('status', r.status)
      if (error) return json({ success: false, error: '更新に失敗しました: ' + error.message }, 500)
      notification = {
        user_id: r.applicant_id,
        message: isFullDay ? `${fullDayLabel}の申請が受理されました` : (isAdvance ? '事前申請が受理されました' : '残業・時間調整の実績が確認されました'),
        sub_message: `${r.work_date}（${dowLabel(r.work_date)}）${isFullDay ? `　${fullDayLabel}` : `　${formatSignedMin(r.diff_minutes ?? 0)}`}`,
        source_type: 'overtime_request',
        reference_id: r.id,
        event_key: (isAdvance && !isFullDay) ? 'overtime:request_confirmed' : 'overtime:confirmed',
        read: false,
      }
    } else if (action === 'return') {
      if (!(isAdmin || caller.id === r.reviewer_id)) return json({ success: false, error: '権限がありません' }, 403)
      if (!['requested', 'reported'].includes(r.status)) return json({ success: false, error: 'この状態では差し戻せません' }, 409)
      const { error } = await db.from('overtime_reports')
        .update({ status: 'returned', return_comment: String(comment).trim() })
        .eq('id', r.id).eq('status', r.status)
      if (error) return json({ success: false, error: '更新に失敗しました: ' + error.message }, 500)
      notification = {
        user_id: r.applicant_id,
        message: '残業・時間調整の申請が差し戻されました',
        sub_message: `${r.work_date}（${dowLabel(r.work_date)}）　理由：${String(comment).trim()}`,
        source_type: 'overtime_request:pending_resubmit',
        reference_id: r.id,
        event_key: 'overtime:returned',
        read: false,
      }
    } else {
      // cancel（本人取消）
      if (caller.id !== r.applicant_id && !isAdmin) return json({ success: false, error: '権限がありません' }, 403)
      if (!['requested', 'request_confirmed', 'reported', 'returned'].includes(r.status)) {
        return json({ success: false, error: 'この状態では取消できません' }, 409)
      }
      const { data: snapshot } = await db.from('overtime_reports').select('*').eq('id', r.id).maybeSingle()
      await db.from('overtime_report_history').insert({
        report_id: r.id, changed_by: caller.id, change_kind: 'cancelled', change_summary: '取消', snapshot,
      })
      const { error } = await db.from('overtime_reports').update({ status: 'cancelled' }).eq('id', r.id)
      if (error) return json({ success: false, error: '更新に失敗しました: ' + error.message }, 500)
      if (r.reviewer_id && r.reviewer_id !== caller.id && ['requested', 'request_confirmed', 'reported'].includes(r.status)) {
        notification = {
          user_id: r.reviewer_id,
          message: `${applicantName}さんが残業・時間調整の申請を取り消しました`,
          sub_message: `${r.work_date}（${dowLabel(r.work_date)}）`,
          source_type: 'overtime_request',
          reference_id: r.id,
          event_key: 'overtime:cancelled',
          read: false,
        }
      }
    }

    if (notification) {
      const { error: nErr } = await db.from('notifications').insert(notification)
      if (nErr) console.error('[overtime-approve] 通知作成失敗:', nErr.message)
    }

    // GCal同期（冪等な再計算）。失敗はエラーにせず結果として返す→クライアントがインライン表示＋再試行。
    let gcalOk = true
    let gcalError = ''
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/gcal-sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync', source_type: 'overtime', source_id: r.id }),
      })
      const data = await res.json()
      if (!res.ok || data?.success === false) { gcalOk = false; gcalError = data?.error ?? `status=${res.status}` }
    } catch (e) {
      gcalOk = false
      gcalError = e instanceof Error ? e.message : String(e)
    }
    if (!gcalOk) console.error('[overtime-approve] GCal同期失敗:', gcalError)

    return json({ success: true, gcal_ok: gcalOk, gcal_error: gcalOk ? undefined : gcalError })
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
