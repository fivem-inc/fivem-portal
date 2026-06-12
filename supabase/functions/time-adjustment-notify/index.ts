import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const TYPE_LABEL: Record<string, string> = {
  late_start: '調整遅出',
  early_end:  '調整早退',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  try {
    const { user_id, user_name, date, types, reason } = await req.json()
    if (!user_id || !date || !types?.length) {
      return new Response(JSON.stringify({ error: 'missing params' }), { status: 400, headers: CORS_HEADERS })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // 申請者が所属するグループのリーダー・マネージャーを取得
    const { data: senderProfile } = await supabase
      .from('profiles')
      .select('group_names')
      .eq('id', user_id)
      .single()

    const groups: string[] = senderProfile?.group_names ?? []

    // 同グループのリーダー・マネージャーを取得
    let notifyTargets: { id: string }[] = []
    if (groups.length > 0) {
      const { data: targets } = await supabase
        .from('profiles')
        .select('id')
        .in('role_title', ['リーダー', 'マネージャー'])
        .eq('is_active', true)
        .overlaps('group_names', groups)
      notifyTargets = targets ?? []
    }

    // グループ未設定の場合は全マネージャーにフォールバック
    if (notifyTargets.length === 0) {
      const { data: fallback } = await supabase
        .from('profiles')
        .select('id')
        .in('role_title', ['マネージャー', '管理者'])
        .eq('is_active', true)
      notifyTargets = fallback ?? []
    }

    const typeLabels = (types as string[]).map(t => TYPE_LABEL[t] ?? t).join('・')
    const dateLabel = `${date.slice(5, 7)}月${parseInt(date.slice(8, 10))}日`
    const message = `⏰ 時間調整が登録されました`
    const subMessage = `${user_name}さんが ${dateLabel} に ${typeLabels} を登録しました。理由：${reason}`

    // 通知INSERT（Service Roleでヘイパス）
    const notifications = notifyTargets.map((t) => ({
      user_id: t.id,
      message,
      sub_message: subMessage,
    }))

    if (notifications.length > 0) {
      await supabase.from('notifications').insert(notifications)
    }

    return new Response(JSON.stringify({ ok: true, notified: notifications.length }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: CORS_HEADERS,
    })
  }
})
