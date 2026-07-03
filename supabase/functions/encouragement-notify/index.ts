import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const applyVars = (text: string, vars: Record<string, string>) =>
  text.replace(/\{\{(.+?)\}\}/g, (_, k) => vars[k.trim()] ?? `{{${k.trim()}}}`)

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const { data: daysSetting } = await supabase
      .from('reminder_days_settings')
      .select('days_before, send_hour, send_minute')
      .eq('event_key', 'encouragement_notify')
      .maybeSingle()
    const daysBefore: number[] = daysSetting?.days_before ?? [3, 0]

    // 設定された送信時刻(JST)でなければ何もしない（cronは5分おきに呼ばれる）
    const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000)
    const sendHour = daysSetting?.send_hour ?? 9
    const sendMinute = daysSetting?.send_minute ?? 0
    if (jstNow.getUTCHours() !== sendHour || jstNow.getUTCMinutes() !== sendMinute) {
      return new Response(JSON.stringify({ ok: true, skipped: 'not send time' }), { headers: CORS_HEADERS })
    }

    const today = new Date().toISOString().slice(0, 10)
    const todayDate = new Date(today + 'T00:00:00Z')

    // deadline - today が 3日 or 0日 の奨励日を取得
    const { data: days } = await supabase
      .from('paid_leave_encouragement_days')
      .select('id, target_date, deadline')
      .gte('deadline', today)

    if (!days || days.length === 0) {
      return new Response(JSON.stringify({ ok: true, notified: 0 }), { headers: CORS_HEADERS })
    }

    const targetDays = (days as { id: string; target_date: string; deadline: string }[]).filter(d => {
      const deadlineDate = new Date(d.deadline + 'T00:00:00Z')
      const diff = Math.round((deadlineDate.getTime() - todayDate.getTime()) / 86400000)
      return daysBefore.includes(diff)
    })

    if (targetDays.length === 0) {
      return new Response(JSON.stringify({ ok: true, notified: 0 }), { headers: CORS_HEADERS })
    }

    // メール通知設定（管理画面の「リマインド」グループでON/OFF）を一度だけ取得
    const { data: emailSetting } = await supabase
      .from('notification_settings')
      .select('enabled, subject, template')
      .eq('event_key', 'reminder:encouragement')
      .eq('channel', 'email')
      .maybeSingle()

    let totalNotified = 0

    for (const day of targetDays) {
      const deadlineDate = new Date(day.deadline + 'T00:00:00Z')
      const diff = Math.round((deadlineDate.getTime() - todayDate.getTime()) / 86400000)
      const dateLabel = `${Number(day.deadline.slice(5, 7))}月${Number(day.deadline.slice(8, 10))}日`

      const msg = diff === 0
        ? `🔴 有給奨励日（${day.target_date}）の回答期限は本日です！`
        : `⚠️ 有給奨励日（${day.target_date}）の回答期限まで${diff}日です（期限: ${dateLabel}）`

      // 対象者を取得
      const { data: targets } = await supabase
        .from('paid_leave_encouragement_targets')
        .select('user_id')
        .eq('encouragement_day_id', day.id)

      if (!targets || targets.length === 0) continue

      const userIds = targets.map((t: { user_id: string }) => t.user_id)

      // 既回答者を除外
      const { data: responses } = await supabase
        .from('paid_leave_encouragement_responses')
        .select('user_id')
        .eq('encouragement_day_id', day.id)
        .in('user_id', userIds)

      const answeredIds = new Set((responses || []).map((r: { user_id: string }) => r.user_id))
      const unansweredIds = userIds.filter((id: string) => !answeredIds.has(id))

      if (unansweredIds.length === 0) continue

      await supabase.from('notifications').insert(
        unansweredIds.map((uid: string) => ({ user_id: uid, message: msg }))
      )

      if (emailSetting?.enabled && emailSetting.template) {
        const vars = { '対象日': day.target_date, '期限': dateLabel }
        const subject = applyVars(emailSetting.subject || '', vars)
        const text = applyVars(emailSetting.template, vars)
        const { data: profiles } = await supabase.from('profiles').select('email').in('id', unansweredIds)
        const emails = (profiles ?? []).map((p: { email: string | null }) => p.email).filter(Boolean) as string[]
        let emailFailed = 0
        for (const to of emails) {
          const { error: emailError } = await supabase.functions.invoke('send-email', { body: { to, subject, text } })
          if (emailError) { emailFailed++; console.error('[encouragement-notify] send-email error:', emailError) }
          await new Promise(r => setTimeout(r, 80))
        }
        if (emailFailed > 0) console.error(`[encouragement-notify] ${emailFailed}/${emails.length}件のメール送信に失敗`)
      }

      totalNotified += unansweredIds.length
    }

    return new Response(JSON.stringify({ ok: true, notified: totalNotified }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: CORS_HEADERS,
    })
  }
})
