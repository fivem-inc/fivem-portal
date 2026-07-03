import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const TYPE_LABEL: Record<string, string> = {
  overtime: '残業',
  holiday_work: '休日出勤',
  early_leave: '早退',
  tardiness: '遅刻',
  absence: '欠勤',
  early_start: '早出',
  location_change: '勤務地変更',
}

const SLACK_WEBHOOK_KEYS: Record<string, string> = {
  leader:     'SLACK_WEBHOOK_LEADER',
  manager:    'SLACK_WEBHOOK_MANAGER',
  accounting: 'SLACK_WEBHOOK_ACCOUNTING',
  president:  'SLACK_WEBHOOK_PRESIDENT',
}

function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(.+?)\}\}/g, (_, key) => vars[key.trim()] ?? `{{${key.trim()}}}`)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  try {
    const { user_id, user_name, date, types, location } = await req.json()
    if (!user_id || !date || !types?.length) {
      return new Response(JSON.stringify({ error: 'missing params' }), { status: 400, headers: CORS_HEADERS })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const typeLabels = (types as string[]).map((t: string) => TYPE_LABEL[t] ?? t).join('・')
    const dateLabel = `${date.slice(5, 7)}月${parseInt(date.slice(8, 10))}日`
    const vars: Record<string, string> = {
      '申請者名': user_name ?? '',
      '種別': typeLabels,
      '日付': dateLabel,
      '勤務地': location ?? '',
      'リンク': 'https://fivem-portal.vercel.app/shift-report?tab=history',
    }

    // notification_settings を取得
    const { data: settingsData } = await supabase
      .from('notification_settings')
      .select('channel, enabled, recipient, subject, template')
      .eq('event_key', 'shift_report:confirmed')

    const settings = (settingsData ?? []) as { channel: string; enabled: boolean; recipient: string | null; subject: string | null; template: string | null }[]
    const getSetting = (ch: string) => settings.find(s => s.channel === ch)

    // 申請者のグループを取得
    const { data: applicantProfile } = await supabase
      .from('profiles')
      .select('group_names')
      .eq('id', user_id)
      .single()
    const applicantGroups: string[] = (applicantProfile as { group_names?: string[] } | null)?.group_names ?? []

    // 役職+グループフィルタで通知対象user_idを解決
    async function resolveTargetIds(recipient: string | null): Promise<string[]> {
      let roles: string[] = ['リーダー', 'マネージャー']
      let groupFilter = 'same'
      try {
        const p = JSON.parse(recipient ?? '{}')
        if (Array.isArray(p.roles)) roles = p.roles
        if (p.groupFilter) groupFilter = p.groupFilter
      } catch { /* use defaults */ }

      const includeApplicant = roles.includes('申請者本人')
      const queryRoles = roles.filter(r => r !== '申請者本人')

      let ids: string[] = []
      if (queryRoles.length > 0) {
        let query = supabase.from('profiles').select('id').in('role_title', queryRoles).eq('is_active', true)
        if (groupFilter === 'same' && applicantGroups.length > 0) {
          query = query.overlaps('group_names', applicantGroups)
        }
        const { data } = await query
        ids = ((data ?? []) as { id: string }[]).map(d => d.id)
      }
      if (includeApplicant) ids = [...new Set([...ids, user_id])]
      return ids.filter(id => id !== user_id) // 申請者本人には既に別途「受理されました」通知が届くため二重送信を避ける
    }

    async function resolveTargetEmails(recipient: string | null): Promise<string[]> {
      const ids = await resolveTargetIds(recipient)
      if (ids.length === 0) return []
      const { data } = await supabase.from('profiles').select('email').in('id', ids)
      return ((data ?? []) as { email: string }[]).map(d => d.email).filter(Boolean)
    }

    let notifiedSite = 0, notifiedSlack = 0, notifiedEmail = 0

    // サイト通知
    const siteSetting = getSetting('site')
    if (siteSetting?.enabled && siteSetting.template) {
      const message = applyTemplate(siteSetting.template, vars)
      const targetIds = await resolveTargetIds(siteSetting.recipient)
      if (targetIds.length > 0) {
        await supabase.from('notifications').insert(
          targetIds.map(id => ({ user_id: id, message, sub_message: null, source_type: 'shift_report' }))
        )
        notifiedSite = targetIds.length
      }
    }

    // Slack通知
    const slackSetting = getSetting('slack')
    if (slackSetting?.enabled) {
      let channels: string[] = []
      try { channels = JSON.parse(slackSetting.recipient ?? '{}').channels ?? [] } catch { /* ignore */ }
      const slackMsg = slackSetting.template
        ? applyTemplate(slackSetting.template, vars)
        : `⏰ *勤務変更申請が受理されました*\n\n*申請者：* ${user_name}\n*種別：* ${typeLabels}\n*日付：* ${dateLabel}`
      for (const ch of channels) {
        const url = Deno.env.get(SLACK_WEBHOOK_KEYS[ch] ?? '')
        if (!url) continue
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: slackMsg, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: slackMsg } }] }),
        })
        notifiedSlack++
      }
    }

    // メール通知
    const emailSetting = getSetting('email')
    if (emailSetting?.enabled && emailSetting.template) {
      const subject = emailSetting.subject ? applyTemplate(emailSetting.subject, vars) : '勤務変更申請が受理されました'
      const text = applyTemplate(emailSetting.template, vars)
      const emails = await resolveTargetEmails(emailSetting.recipient)
      for (const to of emails) {
        await supabase.functions.invoke('send-email', { body: { to, subject, text } })
        notifiedEmail++
      }
    }

    return new Response(JSON.stringify({ ok: true, notifiedSite, notifiedSlack, notifiedEmail }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: CORS_HEADERS,
    })
  }
})
