import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

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
      return diff === 3 || diff === 0
    })

    if (targetDays.length === 0) {
      return new Response(JSON.stringify({ ok: true, notified: 0 }), { headers: CORS_HEADERS })
    }

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
