import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

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

// グループ絞り込みを無視して常に届く役職の既定値。
// 管理画面の「絞り込みの対象外にする役職」で上書きできる（recipient.orgWideRoles）。
const DEFAULT_ORG_WIDE_ROLES = ['社長', '管理者']

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
    const { user_id, user_name, date, types, location, report_id } = await req.json()
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
    const rawGroups: string[] = (applicantProfile as { group_names?: string[] } | null)?.group_names ?? []

    // 🚨 絞り込みに使ってよいのは所属チーム（こども/大人/管理部）だけ。
    // group_names には配信用グループ（正社員・契約社員 等）が混在しており、
    // そのまま突き合わせると「同グループのみ」が実質「全員」になってしまう。
    const { data: teamOptions } = await supabase
      .from('master_options')
      .select('value')
      .eq('category', 'shift_report_group')
    const teamMaster: string[] = ((teamOptions ?? []) as { value: string }[]).map(t => t.value)
    // マスタが取れなかったときだけ従来どおり全グループで判定する（誰にも届かないより安全側）
    const applicantGroups: string[] = teamMaster.length > 0
      ? rawGroups.filter(g => teamMaster.includes(g))
      : rawGroups

    // 役職+グループフィルタで通知対象user_idを解決
    async function resolveTargetIds(recipient: string | null): Promise<string[]> {
      let roles: string[] = ['リーダー', 'マネージャー']
      let groupFilter = 'same'
      let orgWide: string[] = DEFAULT_ORG_WIDE_ROLES
      try {
        const p = JSON.parse(recipient ?? '{}')
        if (Array.isArray(p.roles)) roles = p.roles
        if (p.groupFilter) groupFilter = p.groupFilter
        if (Array.isArray(p.orgWideRoles)) orgWide = p.orgWideRoles
      } catch { /* use defaults */ }

      const queryRoles = roles.filter(r => r !== '申請者本人')
      // 「絞り込みの対象外にする役職」はチームに関係なく全件受け取る
      const groupRoles = queryRoles.filter(r => !orgWide.includes(r))
      const orgWideRoles = queryRoles.filter(r => orgWide.includes(r))

      const ids = new Set<string>()

      if (groupRoles.length > 0) {
        let query = supabase.from('profiles').select('id').in('role_title', groupRoles).eq('is_active', true)
        if (groupFilter === 'same' && applicantGroups.length > 0) {
          query = query.overlaps('group_names', applicantGroups)
        }
        const { data } = await query
        for (const d of ((data ?? []) as { id: string }[])) ids.add(d.id)
      }
      if (orgWideRoles.length > 0) {
        const { data } = await supabase.from('profiles').select('id').in('role_title', orgWideRoles).eq('is_active', true)
        for (const d of ((data ?? []) as { id: string }[])) ids.add(d.id)
      }
      ids.delete(user_id) // 申請者本人には既に別途「受理されました」通知が届くため二重送信を避ける
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
    if (siteSetting?.enabled && siteSetting.template) {
      const message = applyTemplate(siteSetting.template, vars)
      const targetIds = await resolveTargetIds(siteSetting.recipient)
      if (targetIds.length > 0) {
        // reference_id に報告IDを入れると、受け取った人がタップしたときに
        // 履歴でその報告の給与期間が自動で開き、該当行がハイライトされる
        await supabase.from('notifications').insert(
          targetIds.map(id => ({
            user_id: id, message, sub_message: null,
            source_type: 'shift_report',
            reference_id: report_id ?? null,
          }))
        )
        notifiedSite = targetIds.length
      }
    }

    // プッシュ通知（サイト通知とは別に役職を選択できる。文面はシステム固定。「受理」は 2026-08-18 実機確認済みの安全語）
    // タップ先は履歴タブ＋該当行。/shift-report だけだと既定の「報告」フォームに着地して何も見えない
    // （2026-08-17 リーダーからの報告）。プッシュのタブ指定漏れは 8/8 に他の通知で直したがここは漏れていた
    const pushSetting = getSetting('push')
    if (pushSetting?.enabled) {
      const pushTargetIds = await resolveTargetIds(pushSetting.recipient)
      if (pushTargetIds.length > 0) {
        const { data: subs } = await supabase.from('push_subscriptions').select('user_id').in('user_id', pushTargetIds)
        const pushIds = [...new Set(((subs ?? []) as { user_id: string }[]).map(s => s.user_id))]
        if (pushIds.length > 0) {
          await supabase.functions.invoke('send-push', {
            body: { user_ids: pushIds, title: 'ファイブM 勤務変更報告', body: '受理 1件', url: report_id ? `/shift-report?tab=history&focus=${report_id}` : '/shift-report?tab=history', tag: 'shift_report_confirmed' },
          })
        }
      }
    }

    // Slack通知
    const slackSetting = getSetting('slack')
    if (slackSetting?.enabled) {
      let channels: string[] = []
      try { channels = JSON.parse(slackSetting.recipient ?? '{}').channels ?? [] } catch { /* ignore */ }
      const slackMsg = slackSetting.template
        ? applyTemplate(slackSetting.template, vars)
        : `⏰ *勤務変更報告が受理されました*\n\n*報告者：* ${user_name}\n*種別：* ${typeLabels}\n*日付：* ${dateLabel}`
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
      const subject = emailSetting.subject ? applyTemplate(emailSetting.subject, vars) : '勤務変更報告が受理されました'
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
