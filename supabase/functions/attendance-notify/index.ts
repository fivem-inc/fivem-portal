import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const TYPE_LABEL: Record<string, string> = {
  absent:       '全欠勤',
  late:         '遅刻',
  early_leave:  '早退',
  late_start:   '遅出(調整)',
  early_end:    '早退(調整)',
  holiday_work: '休日出勤',
  location_change: '勤務地変更',
  time_change:  '勤務時間変更',
}

// グループ絞り込みを無視して常に届く役職の既定値。
// 管理画面の「絞り込みの対象外にする役職」で上書きできる（recipient.orgWideRoles）。
// 設定が無い古い行はこの既定＝従来どおり社長・管理者だけが全件受け取る。
const DEFAULT_ORG_WIDE_ROLES = ['社長', '管理者']

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
}

function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(.+?)\}\}/g, (_, key) => vars[key.trim()] ?? `{{${key.trim()}}}`)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  try {
    // users  = 欠勤等を登録された本人たち（該当スタッフ）。登録操作者ではない。
    //          まとめて登録できるようになったため複数受け取る。[{ id, name }]
    // user_id/user_name = 1人しか登録できなかった頃の呼び出し方（取消などから今も来る）
    // mode = 'registered'（登録した）/ 'cancelled'（取消した）。省略時は登録扱い。
    const { users, user_id, user_name, dates, types, mode } = await req.json()
    const staffList: { id: string; name: string }[] = Array.isArray(users) && users.length > 0
      ? users.filter((u: { id?: string }) => u?.id).map((u: { id: string; name?: string }) => ({ id: u.id, name: u.name ?? '' }))
      : (user_id ? [{ id: user_id, name: user_name ?? '' }] : [])
    if (staffList.length === 0 || !dates?.length || !types?.length) {
      return new Response(JSON.stringify({ error: 'missing params' }), { status: 400, headers: CORS_HEADERS })
    }
    const staffIds = staffList.map(s => s.id)
    const isMulti = staffList.length > 1
    const isCancelled = mode === 'cancelled'
    const eventKey = isCancelled ? 'attendance:cancelled' : 'attendance:registered'

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const typeLabels = (types as string[]).map((t: string) => TYPE_LABEL[t] ?? t).join('・')
    const sortedDates = [...(dates as string[])].sort()
    const first = sortedDates[0]
    const dateLabel = `${first.slice(5, 7)}月${parseInt(first.slice(8, 10))}日`
      + (sortedDates.length > 1 ? ` 他${sortedDates.length - 1}日` : '')
    // 複数人のときは「大岡 佳奈恵さん 他2名」。1人のときは今までどおり名前だけ
    const nameLabel = isMulti
      ? `${staffList[0].name}さん 他${staffList.length - 1}名`
      : (staffList[0].name ?? '')
    const vars: Record<string, string> = {
      '対象者名': nameLabel,
      '種別': typeLabels,
      '日付': dateLabel,
      'リンク': 'https://fivem-portal.vercel.app/calendar',
    }

    const { data: settingsData } = await supabase
      .from('notification_settings')
      .select('channel, enabled, recipient, subject, template')
      .eq('event_key', eventKey)

    const settings = (settingsData ?? []) as { channel: string; enabled: boolean; recipient: string | null; subject: string | null; template: string | null }[]
    const getSetting = (ch: string) => settings.find(s => s.channel === ch)

    // 該当スタッフのグループ（複数人のときは全員分をまとめる。誰か1人でも同じチームなら届く）
    const { data: staffProfiles } = await supabase
      .from('profiles')
      .select('group_names')
      .in('id', staffIds)
    const rawGroups: string[] = [...new Set(
      ((staffProfiles ?? []) as { group_names?: string[] }[]).flatMap(p => p.group_names ?? [])
    )]

    // 🚨 絞り込みに使ってよいのは所属チーム（こども/大人/管理部）だけ。
    // group_names には配信用グループ（正社員・契約社員／マネージャー・リーダー 等）が混在しており、
    // リーダー・マネージャー全員が「正社員・契約社員」を持っているため、
    // そのまま突き合わせると「同グループのみ」が実質「全員」になってしまう。
    const { data: teamOptions } = await supabase
      .from('master_options')
      .select('value')
      .eq('category', 'shift_report_group')
    const teamMaster: string[] = ((teamOptions ?? []) as { value: string }[]).map(t => t.value)
    // マスタが取れなかったときだけ従来どおり全グループで判定する（誰にも届かないより安全側）
    const staffGroups: string[] = teamMaster.length > 0
      ? rawGroups.filter(g => teamMaster.includes(g))
      : rawGroups

    // 役職＋グループフィルタで通知対象user_idを解決
    // ・groupFilter=same のとき、所属チームが重なる人だけに絞る
    // ・「絞り込みの対象外にする役職」に入っている役職は、チームに関係なく常に対象
    // ・申請者本人(=該当スタッフ) … チェックされていれば本人も対象
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

      const includeStaff = roles.includes('申請者本人')
      const queryRoles = roles.filter(r => r !== '申請者本人')
      const groupRoles = queryRoles.filter(r => !orgWide.includes(r))
      const orgWideRoles = queryRoles.filter(r => orgWide.includes(r))

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
      if (includeStaff) for (const id of staffIds) ids.add(id)
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
      const template = siteSetting.template
        ?? (isCancelled
          ? '🔴 {{対象者名}}さんの{{種別}}が取消されました（{{日付}}）'
          : '🔴 {{対象者名}}さんの{{種別}}が登録されました（{{日付}}）')
      // 1人のときは管理画面のテンプレートをそのまま使う（「◯◯さんの…」という書き方が前提）。
      // 複数人のときは「◯◯さん 他2名さんの…」と日本語が崩れるので固定文で出す
      const message = isMulti
        ? `🔴 ${nameLabel}の${typeLabels}が${isCancelled ? '取消' : '登録'}されました（${dateLabel}）`
        : applyTemplate(template, vars)
      const targetIds = await resolveTargetIds(siteSetting.recipient)
      if (targetIds.length > 0) {
        // reference_id に対象日（先頭日・YYYY-MM-DD）を入れ、バナーから正しい月へジャンプ＋該当行を強調できるようにする
        // 取消は source_type を分ける：飛び先の行がもう無いため、バナー側で「移動せず閉じる」に出し分ける
        // 作った行のIDを受け取り、プッシュのURLに載せる（押したときベル一覧で該当行を光らせるため）
        const { data: inserted } = await supabase.from('notifications').insert(
          targetIds.map(id => ({
            user_id: id,
            message,
            sub_message: null,
            source_type: isCancelled ? 'attendance:cancelled' : 'attendance',
            reference_id: first,
          }))
        ).select('id, user_id')
        for (const r of (inserted ?? []) as { id: string; user_id: string }[]) nidByUser.set(r.user_id, r.id)
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
          const baseUrl = isCancelled ? '/calendar' : `/calendar?focus=${first}`
          // 押したときベル一覧を開いて該当行を光らせる。ベル通知が無い人はそのままカレンダーへ。
          // 取消は着地しても対象の行がもう無いので、ベルで本文（誰の・いつの分か）を読んでもらう
          const urlsByUser: Record<string, string> = {}
          for (const uid of pushIds) {
            const nid = nidByUser.get(uid)
            if (nid) urlsByUser[uid] = addParams(baseUrl, { nids: nid, bell: '1' })
          }
          await supabase.functions.invoke('send-push', {
            // 文面は「状態を表す漢字名詞＋件数」に限る（文章形や「確認」「依頼」はChromeが不正な通知と判定する）
            // 取消は対象の予定が既に削除済みでハイライトできないため focus を付けない（ベル通知と同じ挙動）
            body: {
              user_ids: pushIds,
              // 休日出勤・勤務地変更・勤務時間変更もこの入口から登録されるため、
              // 見出しは種別を限定しない「勤怠」にする（2026-08-18 実機確認済みの語）
              title: 'ファイブM 勤怠',
              body: isCancelled ? '取消 1件' : '新着 1件',
              url: baseUrl,
              urls_by_user: urlsByUser,
              tag: isCancelled ? 'attendance-cancel' : 'attendance',
            },
          })
        }
      }
    }

    // Slack通知
    const slackSetting = getSetting('slack')
    if (slackSetting?.enabled) {
      let channels: string[] = []
      try { channels = JSON.parse(slackSetting.recipient ?? '{}').channels ?? [] } catch { /* ignore */ }
      const slackHead = isCancelled ? '勤怠の登録が取消されました' : '勤怠が登録されました'
      const slackMsg = `📝 *${slackHead}*\n\n*対象者：* ${staffList.map(s => s.name).filter(Boolean).join('・')}\n*日付：* ${dateLabel}\n*種別：* ${typeLabels}`
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
      const subject = emailSetting.subject
        ? applyTemplate(emailSetting.subject, vars)
        : (isCancelled ? '勤怠の登録が取消されました' : '欠勤・遅刻・早退が登録されました')
      // サイト通知と同じ理由で、複数人のときは固定文にする
      const text = isMulti
        ? `${nameLabel}の${typeLabels}が ${dateLabel} に${isCancelled ? '取消' : '登録'}されました。\n\n下記のリンクからご確認ください。\n${vars['リンク']}`
        : applyTemplate(emailSetting.template, vars)
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
