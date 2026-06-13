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
    const { user_id, user_name, date, types, reason } = await req.json()
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
      '登録者名': user_name ?? '',
      '種別': typeLabels,
      '日付': dateLabel,
      '理由': reason ?? '',
    }

    // notification_settings を取得
    const { data: settingsData } = await supabase
      .from('notification_settings')
      .select('channel, enabled, recipient, subject, template')
      .eq('event_key', 'time_adjustment:registered')

    const settings = (settingsData ?? []) as { channel: string; enabled: boolean; recipient: string | null; subject: string | null; template: string | null }[]
    const getSetting = (ch: string) => settings.find(s => s.channel === ch)

    // 申請者のグループを取得
    const { data: senderProfile } = await supabase
      .from('profiles')
      .select('group_names')
      .eq('id', user_id)
      .single()
    const senderGroups: string[] = (senderProfile as { group_names?: string[] } | null)?.group_names ?? []

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
        if (groupFilter === 'same' && senderGroups.length > 0) {
          query = query.overlaps('group_names', senderGroups)
        }
        const { data } = await query
        ids = ((data ?? []) as { id: string }[]).map(d => d.id)
      }
      if (includeApplicant) ids = [...new Set([...ids, user_id])]
      return ids
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
    if (siteSetting?.enabled) {
      const template = siteSetting.template ?? '⏰ {{登録者名}}さんが{{日付}}に{{種別}}を登録しました。理由：{{理由}}'
      const message = applyTemplate(template, vars)
      const targetIds = await resolveTargetIds(siteSetting.recipient)
      if (targetIds.length > 0) {
        await supabase.from('notifications').insert(
          targetIds.map(id => ({ user_id: id, message, sub_message: null }))
        )
        notifiedSite = targetIds.length
      }
    } else if (!siteSetting) {
      // DB未設定のフォールバック（後方互換）
      const { data: targets } = senderGroups.length > 0
        ? await supabase.from('profiles').select('id').in('role_title', ['リーダー', 'マネージャー']).eq('is_active', true).overlaps('group_names', senderGroups)
        : await supabase.from('profiles').select('id').in('role_title', ['マネージャー', '管理者']).eq('is_active', true)
      const fallbackIds = ((targets ?? []) as { id: string }[]).map(d => d.id)
      if (fallbackIds.length > 0) {
        const message = `⏰ 時間調整が登録されました`
        const subMessage = `${user_name}さんが ${dateLabel} に ${typeLabels} を登録しました。理由：${reason}`
        await supabase.from('notifications').insert(
          fallbackIds.map(id => ({ user_id: id, message, sub_message: subMessage }))
        )
        notifiedSite = fallbackIds.length
      }
    }

    // Slack通知
    const slackSetting = getSetting('slack')
    if (slackSetting?.enabled) {
      let channels: string[] = []
      try { channels = JSON.parse(slackSetting.recipient ?? '{}').channels ?? [] } catch { /* ignore */ }
      const slackMsg = `⏰ *時間調整が登録されました*\n\n*登録者：* ${user_name}\n*日付：* ${dateLabel}\n*種別：* ${typeLabels}`
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
      const subject = emailSetting.subject ? applyTemplate(emailSetting.subject, vars) : '時間調整が登録されました'
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
