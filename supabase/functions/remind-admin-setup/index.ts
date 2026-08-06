// 管理者の「入力もれ」を週1回知らせる
//
// ・次年度の会社カレンダーが未登録（12月〜3月／登録が進めば自動的に止まる）
// ・通常シフトの見直し時期（3月・9月の下旬）
//
// 🚨 何を出すかの判定は DB の admin_setup_alerts() 1本に集約している。
//    画面のバッジも同じ関数を呼ぶので、条件を2か所に書かない。
//    しきい値や時期を変えるときは、その関数だけ直せばよい。
//
// cron から週1回（月曜9時JST）呼ばれる。出すものが無ければ何もせず終了する。
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

// チャンネルごとのWebhook URL（Supabase Edge Function Secrets に設定済み）
const SLACK_WEBHOOK_KEYS: Record<string, string> = {
  leader: 'SLACK_WEBHOOK_LEADER',
  manager: 'SLACK_WEBHOOK_MANAGER',
  accounting: 'SLACK_WEBHOOK_ACCOUNTING',
  president: 'SLACK_WEBHOOK_PRESIDENT',
}

type Alert = { key: string; title: string; detail: string; link: string }

Deno.serve(async (req) => {
  // cron（service_role）からの呼び出しのみ受け付ける。
  // トークンの文字列一致だけでは Vault 経由のJWT形式と一致しないため、role クレームも見る
  const auth = req.headers.get('Authorization') ?? ''
  const token = auth.replace('Bearer ', '')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  let isService = token === serviceKey
  if (!isService && token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]))
      isService = payload?.role === 'service_role'
    } catch { /* 判定できなければ拒否 */ }
  }
  if (!isService) return new Response('Unauthorized', { status: 401 })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    serviceKey,
  )

  const { data: alertData, error: alertErr } = await supabase.rpc('admin_setup_alerts')
  if (alertErr) {
    return new Response(JSON.stringify({ error: alertErr.message }), { status: 500 })
  }
  const alerts = (alertData ?? []) as Alert[]
  if (alerts.length === 0) {
    return new Response(JSON.stringify({ ok: true, alerts: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // 通知設定（管理画面からON/OFFできる）
  const { data: setRows } = await supabase
    .from('notification_settings')
    .select('channel, enabled, recipient, template')
    .eq('event_key', 'admin:setup_alert')
  const settingOf = (ch: string) => (setRows ?? []).find((s: { channel: string }) => s.channel === ch)
  const site = settingOf('site')
  const slack = settingOf('slack')

  // 宛先＝管理者＋社長。管理者は app_metadata で持っているので profiles だけでは分からない
  const { data: authUsers } = await supabase.auth.admin.listUsers({ perPage: 1000 })
  const adminIds = (authUsers?.users ?? [])
    .filter(u => (u.app_metadata as { role?: string } | null)?.role === 'admin')
    .map(u => u.id)

  const { data: presidents } = await supabase
    .from('profiles')
    .select('id')
    .eq('is_active', true)
    .eq('role_title', '社長')
  const targetIds = [...new Set([...adminIds, ...(presidents ?? []).map(p => p.id)])]

  let siteSent = 0
  if (site?.enabled !== false && targetIds.length > 0) {
    for (const a of alerts) {
      // 同じ内容を毎週積み上げないよう、未読で同じ件名が残っていれば送らない
      const { data: dup } = await supabase
        .from('notifications')
        .select('id')
        .eq('message', a.title)
        .eq('read', false)
        .in('user_id', targetIds)
        .limit(1)
      if (dup && dup.length > 0) continue

      const rows = targetIds.map(uid => ({
        user_id: uid,
        message: a.title,
        sub_message: a.detail,
        source_type: 'admin_setup',
        reference_id: a.key,
        event_key: null, // push_queue に積ませない（この通知はベルとバッジで受ける方針）
        read: false,
      }))
      const { error } = await supabase.from('notifications').insert(rows)
      if (!error) siteSent += rows.length
    }
  }

  let slackSent = 0
  if (slack?.enabled) {
    let channels: string[] = []
    try {
      const p = JSON.parse((slack.recipient as string) ?? '{}')
      if (Array.isArray(p.channels)) channels = p.channels
    } catch { /* 未設定なら送らない */ }

    const body = alerts.map(a => `• *${a.title}*\n　${a.detail}`).join('\n')
    const text = `⚠️ *【スタッフサイト】設定の確認をお願いします*\n\n${body}`

    for (const ch of channels) {
      const url = Deno.env.get(SLACK_WEBHOOK_KEYS[ch] ?? '')
      if (!url) continue
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
        }),
      })
      if (res.ok) slackSent++
    }
  }

  return new Response(JSON.stringify({ ok: true, alerts: alerts.length, siteSent, slackSent }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
