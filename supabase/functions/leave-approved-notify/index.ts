import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

// 休暇「マネージャー受理」時の FYI（誰がいつ休むか共有）を、役職＋グループ範囲で
// リーダー・マネージャー・社長へ配信する。申請者本人は結果通知(leave_request)で別途受け取るため除外する。
// ・サイト通知: source_type='leave_request:fyi' / reference_id=休暇初日(YYYY-MM-DD)。
//   → App.tsx がタップ時にカレンダーの該当日へジャンプ＋強調する（event_key は付けない＝push_queue非経由）。
// ・プッシュ: attendance-notify と同じく send-push を直接呼ぶ（固定文面）。
// ・メール: 役職で解決した宛先へ送る。

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// グループ絞り込みを無視して常に届く役職の既定値。
// 管理画面の「絞り込みの対象外にする役職」で上書きできる（recipient.orgWideRoles）。
const DEFAULT_ORG_WIDE_ROLES = ['社長', '管理者']

function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(.+?)\}\}/g, (_, key) => vars[key.trim()] ?? `{{${key.trim()}}}`)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  try {
    // applicant_id = 休暇を申請した本人。受理操作者ではない。leave_dates は 'YYYY-MM-DD' の配列。
    const { applicant_id, applicant_name, leave_dates, leave_type } = await req.json()
    if (!applicant_id || !Array.isArray(leave_dates) || leave_dates.length === 0) {
      return new Response(JSON.stringify({ error: 'missing params' }), { status: 400, headers: CORS_HEADERS })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const sortedDates = [...(leave_dates as string[])].sort()
    const first = sortedDates[0]
    const dateLabel = `${Number(first.slice(5, 7))}/${Number(first.slice(8, 10))}`
      + (sortedDates.length > 1 ? ` 他${sortedDates.length - 1}日` : '')
    const vars: Record<string, string> = {
      '申請者名': applicant_name ?? '',
      '休暇種別': leave_type ?? '',
      '日付': dateLabel,
      'リンク': 'https://fivem-portal.vercel.app/calendar',
    }

    const { data: settingsData } = await supabase
      .from('notification_settings')
      .select('channel, enabled, recipient, subject, template')
      .eq('event_key', 'leave:approved_fyi')

    const settings = (settingsData ?? []) as { channel: string; enabled: boolean; recipient: string | null; subject: string | null; template: string | null }[]
    const getSetting = (ch: string) => settings.find(s => s.channel === ch)

    // 申請者本人のグループ（groupFilter=same のとき同グループのみに絞る基準）
    const { data: applicantProfile } = await supabase
      .from('profiles')
      .select('group_names')
      .eq('id', applicant_id)
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

    // 役職＋グループフィルタで通知対象user_idを解決（申請者本人は必ず除外）
    // ・リーダー/マネージャー … groupFilter=same のとき同グループのみ
    // ・社長/管理者 … 組織全体を見る立場なのでグループ絞り込みを無視して常に対象
    async function resolveTargetIds(recipient: string | null): Promise<string[]> {
      let roles: string[] = ['リーダー', 'マネージャー', '社長']
      let groupFilter = 'all'
      let orgWide: string[] = DEFAULT_ORG_WIDE_ROLES
      try {
        const p = JSON.parse(recipient ?? '{}')
        if (Array.isArray(p.roles)) roles = p.roles
        if (p.groupFilter) groupFilter = p.groupFilter
        if (Array.isArray(p.orgWideRoles)) orgWide = p.orgWideRoles
      } catch { /* use defaults */ }

      const queryRoles = roles.filter(r => r !== '申請者本人')
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
      ids.delete(applicant_id) // 本人は結果通知で別途受け取るためFYIからは除外
      return [...ids]
    }

    let notifiedSite = 0, notifiedEmail = 0, notifiedPush = 0

    // サイト通知（バナー／ベル）
    const siteSetting = getSetting('site')
    if (siteSetting?.enabled) {
      const template = siteSetting.template ?? '休暇申請がマネージャーに受理されました 「{{申請者名}}（{{日付}}）」'
      const message = applyTemplate(template, vars)
      const subMessage = siteSetting.subject ? applyTemplate(siteSetting.subject, vars) : null
      const targetIds = await resolveTargetIds(siteSetting.recipient)
      if (targetIds.length > 0) {
        // reference_id に休暇初日(YYYY-MM-DD)を入れ、バナーから正しい月へジャンプ＋該当行を強調できるようにする。
        // event_key は付けない（push_queueパイプライン非経由。プッシュは下で send-push を直接呼ぶ）。
        await supabase.from('notifications').insert(
          targetIds.map(id => ({ user_id: id, message, sub_message: subMessage, source_type: 'leave_request:fyi', reference_id: first }))
        )
        notifiedSite = targetIds.length
      }
    }

    // プッシュ通知（文面はシステム固定・安全語のみ）
    const pushSetting = getSetting('push')
    if (pushSetting?.enabled) {
      const pushTargetIds = await resolveTargetIds(pushSetting.recipient)
      if (pushTargetIds.length > 0) {
        const { data: subs } = await supabase.from('push_subscriptions').select('user_id').in('user_id', pushTargetIds)
        const pushIds = [...new Set(((subs ?? []) as { user_id: string }[]).map(s => s.user_id))]
        if (pushIds.length > 0) {
          await supabase.functions.invoke('send-push', {
            body: { user_ids: pushIds, title: 'ファイブM 休暇申請', body: '新着 1件', url: '/calendar', tag: 'leave-fyi' },
          })
          notifiedPush = pushIds.length
        }
      }
    }

    // メール通知
    const emailSetting = getSetting('email')
    if (emailSetting?.enabled && emailSetting.template) {
      const subject = emailSetting.subject ? applyTemplate(emailSetting.subject, vars) : '休暇が受理されました'
      const text = applyTemplate(emailSetting.template, vars)
      const ids = await resolveTargetIds(emailSetting.recipient)
      if (ids.length > 0) {
        const { data } = await supabase.from('profiles').select('email').in('id', ids)
        const emails = ((data ?? []) as { email: string }[]).map(d => d.email).filter(Boolean)
        for (const to of emails) {
          await supabase.functions.invoke('send-email', { body: { to, subject, text } })
          notifiedEmail++
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, notifiedSite, notifiedEmail, notifiedPush }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: CORS_HEADERS,
    })
  }
})
