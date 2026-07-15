import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const TYPE_LABEL: Record<string, string> = {
  absent:      '全欠勤',
  late:        '遅刻',
  early_leave: '早退',
  late_start:  '遅出(調整)',
  early_end:   '早退(調整)',
}

// グループ絞り込みを無視して常に届く役職（組織全体を見る立場）
const ORG_WIDE_ROLES = ['社長', '管理者']

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
    // user_id = 欠勤等を登録された本人（該当スタッフ）。登録操作者ではない。
    const { user_id, user_name, dates, types } = await req.json()
    if (!user_id || !dates?.length || !types?.length) {
      return new Response(JSON.stringify({ error: 'missing params' }), { status: 400, headers: CORS_HEADERS })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const typeLabels = (types as string[]).map((t: string) => TYPE_LABEL[t] ?? t).join('・')
    const sortedDates = [...(dates as string[])].sort()
    const first = sortedDates[0]
    const dateLabel = `${first.slice(5, 7)}月${parseInt(first.slice(8, 10))}日`
      + (sortedDates.length > 1 ? ` 他${sortedDates.length - 1}日` : '')
    const vars: Record<string, string> = {
      '対象者名': user_name ?? '',
      '種別': typeLabels,
      '日付': dateLabel,
      'リンク': 'https://fivem-portal.vercel.app/calendar',
    }

    const { data: settingsData } = await supabase
      .from('notification_settings')
      .select('channel, enabled, recipient, subject, template')
      .eq('event_key', 'attendance:registered')

    const settings = (settingsData ?? []) as { channel: string; enabled: boolean; recipient: string | null; subject: string | null; template: string | null }[]
    const getSetting = (ch: string) => settings.find(s => s.channel === ch)

    // 該当スタッフのグループ
    const { data: staffProfile } = await supabase
      .from('profiles')
      .select('group_names')
      .eq('id', user_id)
      .single()
    const staffGroups: string[] = (staffProfile as { group_names?: string[] } | null)?.group_names ?? []

    // 役職＋グループフィルタで通知対象user_idを解決
    // ・リーダー/マネージャー … groupFilter=same のとき同グループのみ
    // ・社長/管理者 … 組織全体を見る立場なのでグループ絞り込みを無視して常に対象
    // ・申請者本人(=該当スタッフ) … チェックされていれば本人も対象
    async function resolveTargetIds(recipient: string | null): Promise<string[]> {
      let roles: string[] = ['リーダー', 'マネージャー']
      let groupFilter = 'same'
      try {
        const p = JSON.parse(recipient ?? '{}')
        if (Array.isArray(p.roles)) roles = p.roles
        if (p.groupFilter) groupFilter = p.groupFilter
      } catch { /* use defaults */ }

      const includeStaff = roles.includes('申請者本人')
      const queryRoles = roles.filter(r => r !== '申請者本人')
      const groupRoles = queryRoles.filter(r => !ORG_WIDE_ROLES.includes(r))
      const orgWideRoles = queryRoles.filter(r => ORG_WIDE_ROLES.includes(r))

      const ids = new Set<string>()

      if (groupRoles.length > 0) {
        let query = supabase.from('profiles').select('id').in('role_title', groupRoles).eq('is_active', true)
        if (groupFilter === 'same' && staffGroups.length > 0) {
          query = query.overlaps('group_names', staffGroups)
        }
        const { data } = await query
        for (const d of ((data ?? []) as { id: string }[])) ids.add(d.id)
      }
      if (orgWideRoles.length > 0) {
        const { data } = await supabase.from('profiles').select('id').in('role_title', orgWideRoles).eq('is_active', true)
        for (const d of ((data ?? []) as { id: string }[])) ids.add(d.id)
      }
      if (includeStaff) ids.add(user_id)
      return [...ids]
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
      const template = siteSetting.template ?? '🔴 {{対象者名}}さんの{{種別}}が登録されました（{{日付}}）'
      const message = applyTemplate(template, vars)
      const targetIds = await resolveTargetIds(siteSetting.recipient)
      if (targetIds.length > 0) {
        await supabase.from('notifications').insert(
          targetIds.map(id => ({ user_id: id, message, sub_message: null, source_type: 'attendance' }))
        )
        notifiedSite = targetIds.length
      }
    }

    // プッシュ通知（文面はシステム固定）
    const pushSetting = getSetting('push')
    if (pushSetting?.enabled) {
      const pushTargetIds = await resolveTargetIds(pushSetting.recipient)
      if (pushTargetIds.length > 0) {
        const { data: subs } = await supabase.from('push_subscriptions').select('user_id').in('user_id', pushTargetIds)
        const pushIds = [...new Set(((subs ?? []) as { user_id: string }[]).map(s => s.user_id))]
        if (pushIds.length > 0) {
          await supabase.functions.invoke('send-push', {
            body: { user_ids: pushIds, title: 'ファイブM 欠勤・遅刻・早退', body: '新着 1件', url: '/calendar', tag: 'attendance' },
          })
        }
      }
    }

    // Slack通知
    const slackSetting = getSetting('slack')
    if (slackSetting?.enabled) {
      let channels: string[] = []
      try { channels = JSON.parse(slackSetting.recipient ?? '{}').channels ?? [] } catch { /* ignore */ }
      const slackMsg = `🔴 *欠勤・遅刻・早退が登録されました*\n\n*対象者：* ${user_name}\n*日付：* ${dateLabel}\n*種別：* ${typeLabels}`
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
      const subject = emailSetting.subject ? applyTemplate(emailSetting.subject, vars) : '欠勤・遅刻・早退が登録されました'
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
