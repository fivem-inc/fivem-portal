import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(.+?)\}\}/g, (_, key) => vars[key.trim()] ?? `{{${key.trim()}}}`)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  try {
    const { user_id, user_name, item_name, amount } = await req.json()
    if (!user_id || !item_name || amount == null) {
      return new Response(JSON.stringify({ error: 'missing params' }), { status: 400, headers: CORS_HEADERS })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const vars: Record<string, string> = {
      '申請者名': user_name ?? '',
      '品目名': item_name,
      '金額': String(amount),
    }

    const { data: settingsData } = await supabase
      .from('notification_settings')
      .select('channel, enabled, recipient, template')
      .eq('event_key', 'purchase:reimbursement_recorded')

    const settings = (settingsData ?? []) as { channel: string; enabled: boolean; recipient: string | null; template: string | null }[]
    const siteSetting = settings.find(s => s.channel === 'site')

    let notifiedSite = 0

    if (siteSetting?.enabled && siteSetting.template) {
      let roles: string[] = ['マネージャー', '社長']
      try {
        const p = JSON.parse(siteSetting.recipient ?? '{}')
        if (Array.isArray(p.roles)) roles = p.roles
      } catch { /* use defaults */ }

      const { data } = await supabase
        .from('profiles')
        .select('id')
        .in('role_title', roles)
        .eq('is_active', true)
      const targetIds = ((data ?? []) as { id: string }[])
        .map(d => d.id)
        .filter(id => id !== user_id) // 記録した本人には送らない

      if (targetIds.length > 0) {
        const message = applyTemplate(siteSetting.template, vars)
        await supabase.from('notifications').insert(
          targetIds.map(id => ({ user_id: id, message, sub_message: null, source_type: 'purchase_request' }))
        )
        notifiedSite = targetIds.length
      }
    }

    // プッシュ通知（サイト通知とは別に役職を選択できる。文面はシステム固定）
    const pushSetting = settings.find(s => s.channel === 'push')
    if (pushSetting?.enabled) {
      let pushRoles: string[] = ['社長']
      try {
        const p = JSON.parse(pushSetting.recipient ?? '{}')
        if (Array.isArray(p.roles)) pushRoles = p.roles
      } catch { /* use defaults */ }
      const { data: pushProfiles } = await supabase
        .from('profiles').select('id').in('role_title', pushRoles).eq('is_active', true)
      const pushTargetIds = ((pushProfiles ?? []) as { id: string }[]).map(d => d.id).filter(id => id !== user_id)
      if (pushTargetIds.length > 0) {
        const { data: subs } = await supabase.from('push_subscriptions').select('user_id').in('user_id', pushTargetIds)
        const pushIds = [...new Set(((subs ?? []) as { user_id: string }[]).map(s => s.user_id))]
        if (pushIds.length > 0) {
          await supabase.functions.invoke('send-push', {
            // ⚠️ /purchase の既定タブは「💰 精算」の入力フォーム。tab=history を省くと
            //    他人の精算記録を見に来た社長が自分の入力画面に着地する（2026-08-18 修正）
            body: { user_ids: pushIds, title: 'ファイブM 備品精算', body: '新着 1件', url: '/purchase?tab=history', tag: 'reimbursement_recorded' },
          })
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, notifiedSite }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: CORS_HEADERS,
    })
  }
})
