import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// 締め後申請の許可依頼が届いた時 → 経理（role_title='管理者'）全員へ一斉配信。
// 役職一斉配信は shift-report-confirmed-notify / time-adjustment-notify と同じパターン
// （notification_settings を読んで site/push/email を出し分け。プッシュはこの関数が直接 send-push を呼ぶ）。

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
    const { applicant_name, work_dates_label, request_id } = await req.json()
    if (!applicant_name || !work_dates_label) {
      return new Response(JSON.stringify({ error: 'missing params' }), { status: 400, headers: CORS_HEADERS })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const vars: Record<string, string> = {
      '申請者名': applicant_name,
      '対象日': work_dates_label,
      'リンク': 'https://fivem-portal.vercel.app/admin?tab=overtime_admin&section=grants',
    }

    const { data: settingsData } = await supabase
      .from('notification_settings')
      .select('channel, enabled, recipient, subject, template')
      .eq('event_key', 'overtime:grant_request')
    const settings = (settingsData ?? []) as { channel: string; enabled: boolean; recipient: string | null; subject: string | null; template: string | null }[]
    const getSetting = (ch: string) => settings.find(s => s.channel === ch)

    async function resolveTargetIds(recipient: string | null): Promise<string[]> {
      let roles: string[] = ['管理者']
      try {
        const p = JSON.parse(recipient ?? '{}')
        if (Array.isArray(p.roles)) roles = p.roles
      } catch { /* use default */ }
      const { data } = await supabase.from('profiles').select('id').in('role_title', roles).eq('is_active', true)
      return ((data ?? []) as { id: string }[]).map(d => d.id)
    }

    async function resolveTargetEmails(recipient: string | null): Promise<string[]> {
      const ids = await resolveTargetIds(recipient)
      if (ids.length === 0) return []
      const { data } = await supabase.from('profiles').select('email').in('id', ids)
      return ((data ?? []) as { email: string }[]).map(d => d.email).filter(Boolean)
    }

    let notifiedSite = 0, notifiedEmail = 0

    // サイト通知
    const siteSetting = getSetting('site')
    if (siteSetting?.enabled && siteSetting.template) {
      const message = applyTemplate(siteSetting.template, vars)
      const targetIds = await resolveTargetIds(siteSetting.recipient)
      if (targetIds.length > 0) {
        await supabase.from('notifications').insert(
          targetIds.map(id => ({ user_id: id, message, sub_message: work_dates_label, source_type: 'overtime_grant_request', reference_id: request_id ?? null }))
        )
        notifiedSite = targetIds.length
      }
    }

    // プッシュ通知（文面はシステム固定・実機テスト済みの安全語のみ）
    const pushSetting = getSetting('push')
    if (pushSetting?.enabled) {
      const pushTargetIds = await resolveTargetIds(pushSetting.recipient)
      if (pushTargetIds.length > 0) {
        const { data: subs } = await supabase.from('push_subscriptions').select('user_id').in('user_id', pushTargetIds)
        const pushIds = [...new Set(((subs ?? []) as { user_id: string }[]).map(s => s.user_id))]
        if (pushIds.length > 0) {
          await supabase.functions.invoke('send-push', {
            body: { user_ids: pushIds, title: 'ファイブM 残業', body: '未承認 1件', url: '/admin?tab=overtime_admin&section=grants', tag: 'overtime_grant_request' },
          })
        }
      }
    }

    // メール通知
    const emailSetting = getSetting('email')
    if (emailSetting?.enabled && emailSetting.template) {
      const subject = emailSetting.subject ? applyTemplate(emailSetting.subject, vars) : '締め後申請の許可依頼が届きました'
      const text = applyTemplate(emailSetting.template, vars)
      const emails = await resolveTargetEmails(emailSetting.recipient)
      for (const to of emails) {
        await supabase.functions.invoke('send-email', { body: { to, subject, text } })
        notifiedEmail++
      }
    }

    return new Response(JSON.stringify({ ok: true, notifiedSite, notifiedEmail }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: CORS_HEADERS })
  }
})
