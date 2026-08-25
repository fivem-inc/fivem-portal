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

// 管理画面「通知設定」(notification_settings) の1行。
// ⚠️ 行が無いときは「送る」(fail-open)。差し戻し等の通知が欠落すると業務が止まる（本人が再提出しない）ため、
//    seed漏れやRLS失敗で静かに無通知になるより送る側に倒す。クライアント側 shouldSend() は fail-closed なので挙動が違う点に注意。
type NotifSetting = { enabled: boolean; recipient: string | null; subject: string | null; template: string | null }

function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(.+?)\}\}/g, (_, key) => vars[String(key).trim()] ?? `{{${String(key).trim()}}}`)
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
      .select('id, applicant_id, reviewer_id, work_date, status, entry_type, diff_minutes, application_types, pay_period_start')
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
    // Slackに流すイベント。🚨 notification とは切り離して持つ。
    // 取消は「確認者が自分自身（自己受理した申請）」だと notification が作られないため、
    // notification にぶら下げると取消がSlackに出なくなる
    let slackEventKey: string | null = null

    if (action === 'approve') {
      if (!(isAdmin || caller.id === r.reviewer_id)) return json({ success: false, error: '権限がありません' }, 403)
      // 欠勤の自己受理はマネージャー以上のみ（2026-08-21 に開放。リーダー以下は他の人の受理が必要）
      // 🚨 同じ判定が overtime_reports の RLS（overtime_insert_own）にもある。
      //    自己受理は受理ボタンを通らず直接 INSERT されるため、あちらが本来の砦。片方だけ直さないこと。
      if (types.includes('absence') && caller.id === r.applicant_id && !isAdmin) {
        const { data: me } = await db.from('profiles').select('role_title').eq('id', caller.id).maybeSingle()
        if (!['社長', '管理者', 'マネージャー'].includes(me?.role_title ?? '')) {
          return json({ success: false, error: '欠勤の自己受理はマネージャー以上のみです' }, 403)
        }
      }
      if (!['requested', 'reported'].includes(r.status)) return json({ success: false, error: 'この状態では受理できません' }, 409)
      const isAdvance = r.status === 'requested'
      // 終日は実績報告が無いため、事前申請の受理でも confirmed 直行
      // 事前受理は日時も残す。残さないと status が reported に進んだ時点で
      // 「事前に受理したのか、受理を飛ばして報告されたのか」が分からなくなる（2026-08-25）
      const next = (isAdvance && !isFullDay)
        ? { status: 'request_confirmed', request_confirmed_at: new Date().toISOString() }
        : { status: 'confirmed', confirmed_by: caller.id, confirmed_at: new Date().toISOString() }
      // 🚨 楽観ロックは .eq('status') だけでは足りない。update は0件でもエラーにならないので、
      //    件数を見ないと「実際は何も更新していないのに受理の通知だけ飛ぶ」ことが起きる。
      //    未受理のまま本人が実績報告できるようにした（2026-08-25）ことで、
      //    上長の受理と本人の報告が同時に起きうるようになったため必ず件数を確認する
      const { data: updated, error } = await db.from('overtime_reports')
        .update(next).eq('id', r.id).eq('status', r.status).select('id')
      if (error) return json({ success: false, error: '更新に失敗しました: ' + error.message }, 500)
      if (!updated || updated.length === 0) {
        return json({ success: false, error: 'この申請の状態が変わっています。画面を更新してからやり直してください' }, 409)
      }
      notification = {
        user_id: r.applicant_id,
        message: isFullDay ? `${fullDayLabel}の申請が受理されました` : (isAdvance ? '事前申請が受理されました' : '残業・時間調整の実績が確認されました'),
        sub_message: `${r.work_date}（${dowLabel(r.work_date)}）${isFullDay ? `　${fullDayLabel}` : `　${formatSignedMin(r.diff_minutes ?? 0)}`}`,
        source_type: 'overtime_request',
        reference_id: r.id,
        event_key: (isAdvance && !isFullDay) ? 'overtime:request_confirmed' : 'overtime:confirmed',
        read: false,
      }
      slackEventKey = (isAdvance && !isFullDay) ? 'overtime:request_confirmed' : 'overtime:confirmed'
    } else if (action === 'return') {
      if (!(isAdmin || caller.id === r.reviewer_id)) return json({ success: false, error: '権限がありません' }, 403)
      if (!['requested', 'reported'].includes(r.status)) return json({ success: false, error: 'この状態では差し戻せません' }, 409)
      // 受理と同じ理由で、差し戻しも件数を見る（0件なら差し戻せていないので通知を出さない）
      const { data: updated, error } = await db.from('overtime_reports')
        .update({ status: 'returned', return_comment: String(comment).trim() })
        .eq('id', r.id).eq('status', r.status).select('id')
      if (error) return json({ success: false, error: '更新に失敗しました: ' + error.message }, 500)
      if (!updated || updated.length === 0) {
        return json({ success: false, error: 'この申請の状態が変わっています。画面を更新してからやり直してください' }, 409)
      }
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
      // 本人取消の制限（管理者は対象外）：reported(実績報告済＝実態あり)は不可／支給月17日を過ぎたら不可。
      // 締め後(その期の16〜17日)の本人取消は管理者へアラート。期間＝16日〜翌15日（15締め25支給）。
      // ※新規申請の締めロック（DBトリガー enforce_overtime_submission_window）と同じ17日で統一。
      let notifyAfterClose = false
      if (!isAdmin) {
        if (r.status === 'reported') {
          return json({ success: false, error: '実績報告済みのため取り消せません。申請先の担当者に取り下げ（差し戻し）を依頼してください' }, 403)
        }
        const [ppy, ppm] = String(r.pay_period_start ?? '').split('-').map(Number)
        if (ppy && ppm) {
          const payY = ppm === 12 ? ppy + 1 : ppy
          const payM = ppm === 12 ? 1 : ppm + 1
          const mm = String(payM).padStart(2, '0')
          const cutoff17 = `${payY}-${mm}-17`, periodEnd = `${payY}-${mm}-15`
          const jst = new Date(Date.now() + 9 * 60 * 60 * 1000)
          const todayStr = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`
          if (todayStr > cutoff17) {
            return json({ success: false, error: '給与計算が始まっているため（毎月17日以降）取り消せません。管理者に依頼してください' }, 403)
          }
          if (todayStr > periodEnd) notifyAfterClose = true
        }
      }
      const { data: snapshot } = await db.from('overtime_reports').select('*').eq('id', r.id).maybeSingle()
      // 楽観ロック：ロード時の status と一致する時だけ取消（別確認者が confirmed 等へ遷移させた確定レコードを踏み潰さない）
      const { data: updated, error } = await db.from('overtime_reports')
        .update({ status: 'cancelled' }).eq('id', r.id).eq('status', r.status).select('id')
      if (error) return json({ success: false, error: '更新に失敗しました: ' + error.message }, 500)
      if (!updated || updated.length === 0) {
        return json({ success: false, error: 'この申請の状態が変わったため取り消せませんでした。画面を更新してください' }, 409)
      }
      await db.from('overtime_report_history').insert({
        report_id: r.id, changed_by: caller.id, change_kind: 'cancelled', change_summary: '取消', snapshot,
      })
      slackEventKey = 'overtime:cancelled'
      if (r.reviewer_id && r.reviewer_id !== caller.id && ['requested', 'request_confirmed', 'reported'].includes(r.status)) {
        notification = {
          user_id: r.reviewer_id,
          message: `${applicantName}さんが残業・時間調整の申請を取り消しました`,
          sub_message: `${r.work_date}（${dowLabel(r.work_date)}）`,
          // 🚨 'overtime_request'（＝本人への結果報告）にすると、確認者がタップしたとき
          //    「自分の履歴」を開いて存在しないIDを探しに行き必ず空振りする。
          //    取消は確認待ち一覧からも消えているので、専用の source_type で
          //    「移動しないお知らせ」として扱う（2026-08-18 修正）
          source_type: 'overtime_request:cancelled_fyi',
          reference_id: r.id,
          event_key: 'overtime:cancelled',
          read: false,
        }
      }
      // 締め後(16〜20日)の本人取消 → 管理者・社長へアラート（情報通知・タップは閉じるのみ）
      if (notifyAfterClose) {
        const { data: admins } = await db.from('profiles').select('id').in('role_title', ['管理者', '社長'])
        const rows = (admins ?? [])
          .filter((a: { id: string }) => a.id !== caller.id)
          .map((a: { id: string }) => ({
            user_id: a.id,
            message: `⚠️ ${applicantName}さんが給与締め後に残業申請を取り消しました（${String(r.work_date).slice(5).replace('-', '/')}）`,
            sub_message: null,
            source_type: null,
            reference_id: null,
            read: false,
          }))
        if (rows.length) {
          const { error: aErr } = await db.from('notifications').insert(rows)
          if (aErr) console.error('[overtime-approve] 締め後アラート作成失敗:', aErr.message)
        } else {
          console.warn('[overtime-approve] 締め後アラートの宛先(role_title=管理者/社長)が0件。役職名の実値を確認')
        }
      }
    }

    // 通知（管理画面「通知設定」に従う）。
    // ・サイト通知(site) … ベル。event_key を付けて入れると、DBトリガー経由でプッシュも自動で流れる
    //                      （＝サイト通知OFFにするとプッシュも止まる。管理画面にその旨を注記済み）
    // ・プッシュ(push)  … ここでは何もしない（送ると二重送信になる）
    // ・メール(email)   … 宛先はサイト通知と同じ人（本人 or 確認をお願いする人）
    // ※ 下の「締め後アラート」は給与計算に直結するガバナンス通知のため、この設定の対象外（常時送る）
    if (notification) {
      const eventKey = String(notification.event_key)
      const { data: settingRows } = await db
        .from('notification_settings')
        .select('channel, enabled, recipient, subject, template')
        .eq('event_key', eventKey)
        .in('channel', ['site', 'email'])
      const settings = new Map<string, NotifSetting>()
      for (const s of (settingRows ?? []) as (NotifSetting & { channel: string })[]) {
        settings.set(s.channel, s)
      }
      const siteSetting = settings.get('site')
      const emailSetting = settings.get('email')

      if (siteSetting?.enabled ?? true) {
        const { error: nErr } = await db.from('notifications').insert(notification)
        if (nErr) console.error('[overtime-approve] 通知作成失敗:', nErr.message)
      }

      if (emailSetting?.enabled && emailSetting.template) {
        const targetId = String(notification.user_id)
        const isToApplicant = targetId === r.applicant_id
        const vars: Record<string, string> = {
          申請者名: applicantName,
          日付: `${r.work_date}（${dowLabel(r.work_date)}）`,
          種別: isFullDay ? fullDayLabel : '残業・時間調整',
          時間: isFullDay ? fullDayLabel : formatSignedMin(r.diff_minutes ?? 0),
          差し戻し理由: String(comment ?? '').trim() || '（記載なし）',
          リンク: `https://fivem-portal.vercel.app/overtime${isToApplicant ? '?tab=history' : '?view=confirm'}`,
        }
        const { data: targetProf } = await db.from('profiles').select('email').eq('id', targetId).maybeSingle()
        const to = (targetProf as { email?: string } | null)?.email
        if (to) {
          // メール送信の失敗で受理・差し戻しそのものを失敗扱いにはしない（ログのみ）
          try {
            const res = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                to,
                subject: emailSetting.subject ? applyTemplate(emailSetting.subject, vars) : eventKey,
                text: applyTemplate(emailSetting.template, vars),
              }),
            })
            if (!res.ok) console.error('[overtime-approve] メール送信失敗: status=', res.status)
          } catch (e) {
            console.error('[overtime-approve] メール送信失敗:', e instanceof Error ? e.message : String(e))
          }
        }
      }
    }

    // Slack通知（送信先チャンネルとON/OFFは管理画面の通知設定に従う。本文は send-overtime-slack が組み立てる）
    // 失敗しても受理・取消そのものは成功のままにする（ログのみ）
    if (slackEventKey) {
      try {
        await fetch(`${supabaseUrl}/functions/v1/send-overtime-slack`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ report_id: r.id, event_key: slackEventKey }),
        })
      } catch (e) {
        console.error('[overtime-approve] Slack送信失敗:', e instanceof Error ? e.message : String(e))
      }
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
