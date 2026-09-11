import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const TYPE_LABEL: Record<string, string> = {
  late_start: '調整遅出',
  early_end:  '調整早退',
}

// グループ絞り込みを無視して常に届く役職の既定値。
// 管理画面の「絞り込みの対象外にする役職」で上書きできる（recipient.orgWideRoles）。
// 🚨 役職名の既定値（旧 DEFAULT_ORG_WIDE_ROLES）は持たない。DB の resolve_role_recipients が属性「経営」を既定にする（2026-09-10）

// URLにパラメータを足す（?の有無を自動で判断する）
function addParams(url: string, params: Record<string, string>): string {
  const parts = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
  return parts.length === 0 ? url : url + (url.includes('?') ? '&' : '?') + parts.join('&')
}

const SLACK_WEBHOOK_KEYS: Record<string, string> = {
  leader:     'SLACK_WEBHOOK_LEADER',
  manager:    'SLACK_WEBHOOK_MANAGER',
  accounting: 'SLACK_WEBHOOK_ACCOUNTING',
  president:  'SLACK_WEBHOOK_PRESIDENT',
  overtime:   'SLACK_WEBHOOK_OVERTIME',
}

function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(.+?)\}\}/g, (_, key) => vars[key.trim()] ?? `{{${key.trim()}}}`)
}

// 「09:00」→「9:00」。Googleカレンダー・勤怠通知と同じ書式に揃える
function hm(t?: string | null): string {
  if (!t) return ''
  const [h, m] = String(t).split(':')
  return `${parseInt(h, 10)}:${m}`
}

// 調整遅出＝その時刻から出勤、調整早退＝その時刻まで勤務
function timeLabelFor(type: string, time?: string | null): string {
  if (!time) return ''
  if (type === 'late_start') return `${hm(time)}〜`
  if (type === 'early_end') return `〜${hm(time)}`
  return hm(time)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  try {
    // details = Slack本文に出す時間（[{ type, time }]）。調整遅出＝13:00〜、調整早退＝〜18:00
    const { user_id, user_name, date, types, reason, details } = await req.json()
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
      // 上長宛のお知らせなので、飛び先は本人の休暇申請ページではなくチームカレンダーの該当日にする
      'リンク': `https://fivem-portal.vercel.app/calendar?focus=${date}`,
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
    const rawGroups: string[] = (senderProfile as { group_names?: string[] } | null)?.group_names ?? []

    // 🚨 絞り込みに使ってよいのは所属チーム（こども/大人/管理部）だけ。
    // group_names には配信用グループ（正社員・契約社員 等）が混在しており、
    // そのまま突き合わせると「同グループのみ」が実質「全員」になってしまう。
    const { data: teamOptions } = await supabase
      .from('master_options')
      .select('value')
      .eq('category', 'shift_report_group')
    const teamMaster: string[] = ((teamOptions ?? []) as { value: string }[]).map(t => t.value)
    // マスタが取れなかったときだけ従来どおり全グループで判定する（誰にも届かないより安全側）
    const senderGroups: string[] = teamMaster.length > 0
      ? rawGroups.filter(g => teamMaster.includes(g))
      : rawGroups

    // 役職+グループフィルタで通知対象user_idを解決
    // 🚨 宛先の解決は DB の resolve_role_recipients に任せる（2026-09-10 段4・役職名の直書きと写しをやめる）。
    //    既定値は立場のコード（leader / manager）。登録した本人は DB 側で除外され、
    //    「申請者本人」にチェックがあるときだけ足す（以前は本人が上長なら役職経由で自分にも届いていた）。
    async function resolveTargetIds(recipient: string | null): Promise<string[]> {
      let parsed: Record<string, unknown> = {}
      try { parsed = JSON.parse(recipient ?? '{}') } catch { /* 旧形式は既定 */ }
      const spec = { roles: ['leader', 'manager'], groupFilter: 'same', ...parsed }
      const roles = Array.isArray(spec.roles) ? (spec.roles as string[]) : []
      const { data, error } = await supabase.rpc('resolve_role_recipients', { p_applicant: user_id, p_recipient: spec })
      if (error) { console.error('[time-adjustment-notify] 宛先を解決できません', error.message); return [] }
      const ids = new Set(((data ?? []) as ({ resolve_role_recipients: string } | string)[])
        .map(row => (typeof row === 'string' ? row : row.resolve_role_recipients)))
      if (roles.includes('申請者本人')) ids.add(user_id)
      return [...ids]
    }

    async function resolveTargetEmails(recipient: string | null): Promise<string[]> {
      const ids = await resolveTargetIds(recipient)
      if (ids.length === 0) return []
      const { data } = await supabase.from('profiles').select('email').in('id', ids)
      return ((data ?? []) as { email: string }[]).map(d => d.email).filter(Boolean)
    }

    let notifiedSite = 0, notifiedSlack = 0, notifiedEmail = 0
    // 「その人に作ったベル通知のID」。プッシュのURLに載せると、押したとき着地画面で
    // ベル一覧が開き該当行が光る。ベル通知が無い人（プッシュだけの宛先）には載せない
    const nidByUser = new Map<string, string>()

    // サイト通知
    const siteSetting = getSetting('site')
    if (siteSetting?.enabled) {
      const template = siteSetting.template ?? '📅 {{登録者名}}さんが{{日付}}に{{種別}}を登録しました。理由：{{理由}}'
      const message = applyTemplate(template, vars)
      const targetIds = await resolveTargetIds(siteSetting.recipient)
      if (targetIds.length > 0) {
        // 作った行のIDを受け取り、プッシュのURLに載せる（押したときベル一覧で該当行を光らせるため）
        const { data: inserted } = await supabase.from('notifications').insert(
          // 🚨 reference_id に対象日を入れる。これが無いとタップしても
          // カレンダーの該当行を強調できない（今月を開くだけになる）
          targetIds.map(id => ({ user_id: id, message, sub_message: null, source_type: 'time_adjustment', reference_id: date }))
        ).select('id, user_id')
        for (const r of (inserted ?? []) as { id: string; user_id: string }[]) nidByUser.set(r.user_id, r.id)
        notifiedSite = targetIds.length
      }
    } else if (!siteSetting) {
      // DB未設定のフォールバック（後方互換）
      // 🚨 役職名を直書きしない。同チームがあれば leader/manager を同グループで、無ければ manager/accounting を全体で
      const fallbackSpec = senderGroups.length > 0
        ? { roles: ['leader', 'manager'], groupFilter: 'same' }
        : { roles: ['manager', 'accounting'], groupFilter: 'all' }
      const { data: targets } = await supabase.rpc('resolve_role_recipients', { p_applicant: user_id, p_recipient: fallbackSpec })
      const fallbackIds = ((targets ?? []) as ({ resolve_role_recipients: string } | string)[])
        .map(row => (typeof row === 'string' ? row : row.resolve_role_recipients))
      if (fallbackIds.length > 0) {
        const message = `📅 時間調整が登録されました`
        const subMessage = `${user_name}さんが ${dateLabel} に ${typeLabels} を登録しました。理由：${reason}`
        const { data: inserted } = await supabase.from('notifications').insert(
          fallbackIds.map(id => ({ user_id: id, message, sub_message: subMessage, source_type: 'time_adjustment', reference_id: date }))
        ).select('id, user_id')
        for (const r of (inserted ?? []) as { id: string; user_id: string }[]) nidByUser.set(r.user_id, r.id)
        notifiedSite = fallbackIds.length
      }
    }

    // プッシュ通知（サイト通知とは別に役職を選択できる。文面はシステム固定）
    const pushSetting = getSetting('push')
    if (pushSetting?.enabled) {
      const pushTargetIds = await resolveTargetIds(pushSetting.recipient)
      if (pushTargetIds.length > 0) {
        const { data: subs } = await supabase.from('push_subscriptions').select('user_id').in('user_id', pushTargetIds)
        const pushIds = [...new Set(((subs ?? []) as { user_id: string }[]).map(s => s.user_id))]
        if (pushIds.length > 0) {
          const baseUrl = `/calendar?focus=${date}`
          // 押したときベル一覧を開いて該当行を光らせる。ベル通知が無い人はそのままカレンダーへ
          const urlsByUser: Record<string, string> = {}
          for (const uid of pushIds) {
            const nid = nidByUser.get(uid)
            if (nid) urlsByUser[uid] = addParams(baseUrl, { nids: nid, bell: '1' })
          }
          await supabase.functions.invoke('send-push', {
            body: { user_ids: pushIds, title: 'ファイブM 時間調整', body: '時間調整の申請が届いています', url: baseUrl, urls_by_user: urlsByUser, tag: 'time_adjustment' },
          })
        }
      }
    }

    // Slack通知
    const slackSetting = getSetting('slack')
    if (slackSetting?.enabled) {
      let channels: string[] = []
      try { channels = JSON.parse(slackSetting.recipient ?? '{}').channels ?? [] } catch { /* ignore */ }
      // 🚨 Slackはチーム・役職の絞り込みが効かない（チャンネルに入っている人全員に届く）。
      //    公開チャンネルに流れることもあるので、載せるのはカレンダー相当（氏名・種別・日付・時間）まで。
      //    理由（reason）はサイト通知・メールだけに留め、Slackには載せない。
      const detailList: { type: string; time?: string | null }[] = Array.isArray(details) ? details : []
      const timeLine = detailList
        .map(d => {
          const label = timeLabelFor(d.type, d.time)
          if (!label) return ''
          return detailList.length > 1 ? `${TYPE_LABEL[d.type] ?? d.type} ${label}` : label
        })
        .filter(Boolean)
        .join(' / ')
      const slackLines = [
        '🕐 *時間調整｜登録*',
        '',
        `*対象者：* ${user_name ?? ''}`,
        `*種別：* ${typeLabels}`,
        `*日付：* ${dateLabel}`,
      ]
      if (timeLine) slackLines.push(`*時間：* ${timeLine}`)
      const slackMsg = slackLines.join('\n')
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
