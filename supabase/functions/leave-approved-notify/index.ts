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
// 🚨 役職名の既定値（旧 DEFAULT_ORG_WIDE_ROLES）は持たない。DB の resolve_role_recipients が属性「経営」を既定にする（2026-09-10）

// URLにパラメータを足す（?の有無を自動で判断する）
function addParams(url: string, params: Record<string, string>): string {
  const parts = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
  return parts.length === 0 ? url : url + (url.includes('?') ? '&' : '?') + parts.join('&')
}

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

    // 🚨 ここにあった「申請者の所属チームを組み立てる処理」は削除した（2026-09-11）。
    //    2026-09-10 段4 で宛先の解決を DB の resolve_role_recipients に移したあと、
    //    **計算した結果をどこからも使っていなかった**（profiles と master_options を
    //    読むだけ読んで捨てていた）。同じ絞り込みは RPC の中で行っている
    //    （group_names を master_options の shift_report_group で絞る／マスタが空なら
    //     全グループで判定する、という逃げ道まで同じ）。
    //    🚨 **同じ判定を2か所に置かない**。復活させると、片方だけ直す事故の種になる。

    // 役職＋グループフィルタで通知対象user_idを解決（申請者本人は必ず除外）
    // ・リーダー/マネージャー … groupFilter=same のとき同グループのみ
    // ・社長/管理者 … 組織全体を見る立場なのでグループ絞り込みを無視して常に対象
    // 🚨 宛先の解決は DB の resolve_role_recipients に任せる（2026-09-10 段4・役職名の直書きと写しをやめる）。
    //    既定値は立場のコード（leader / manager / president）・全グループ。本人は DB 側で必ず除外される。
    async function resolveTargetIds(recipient: string | null): Promise<string[]> {
      let parsed: Record<string, unknown> = {}
      try { parsed = JSON.parse(recipient ?? '{}') } catch { /* 旧形式は既定 */ }
      const spec = { roles: ['leader', 'manager', 'president'], groupFilter: 'all', ...parsed }
      const { data, error } = await supabase.rpc('resolve_role_recipients', { p_applicant: applicant_id, p_recipient: spec })
      if (error) { console.error('[leave-approved-notify] 宛先を解決できません', error.message); return [] }
      return [...new Set(((data ?? []) as ({ resolve_role_recipients: string } | string)[])
        .map(row => (typeof row === 'string' ? row : row.resolve_role_recipients)))]
    }

    let notifiedSite = 0, notifiedEmail = 0, notifiedPush = 0
    // 「その人に作ったベル通知のID」。プッシュのURLに載せると、押したとき着地画面で
    // ベル一覧が開き該当行が光る。ベル通知が無い人（プッシュだけの宛先）には載せない
    const nidByUser = new Map<string, string>()

    // サイト通知（バナー／ベル）
    const siteSetting = getSetting('site')
    if (siteSetting?.enabled) {
      const template = siteSetting.template ?? '🌿 休暇申請がマネージャーに受理されました 「{{申請者名}}（{{日付}}）」'
      const message = applyTemplate(template, vars)
      const subMessage = siteSetting.subject ? applyTemplate(siteSetting.subject, vars) : null
      const targetIds = await resolveTargetIds(siteSetting.recipient)
      if (targetIds.length > 0) {
        // reference_id に休暇初日(YYYY-MM-DD)を入れ、バナーから正しい月へジャンプ＋該当行を強調できるようにする。
        // event_key は付けない（push_queueパイプライン非経由。プッシュは下で send-push を直接呼ぶ）。
        // 作った行のIDを受け取り、プッシュのURLに載せる（押したときベル一覧で該当行を光らせるため）
        const { data: inserted } = await supabase.from('notifications').insert(
          targetIds.map(id => ({ user_id: id, message, sub_message: subMessage, source_type: 'leave_request:fyi', reference_id: first }))
        ).select('id, user_id')
        for (const r of (inserted ?? []) as { id: string; user_id: string }[]) nidByUser.set(r.user_id, r.id)
        notifiedSite = targetIds.length
      }
    }

    // プッシュ通知（文面はシステム固定・安全語のみ。「受理」は 2026-08-18 実機テストで警告にならないことを確認済み）
    // タップ先はベル通知と同じ「その月のカレンダー＋該当日ハイライト」。/calendar だけだと今月が開くだけで
    // 対象（来年の休暇など）が見えず「押したのに何もない」になる（2026-08-17 リーダーからの報告）
    const pushSetting = getSetting('push')
    if (pushSetting?.enabled) {
      const pushTargetIds = await resolveTargetIds(pushSetting.recipient)
      if (pushTargetIds.length > 0) {
        const { data: subs } = await supabase.from('push_subscriptions').select('user_id').in('user_id', pushTargetIds)
        const pushIds = [...new Set(((subs ?? []) as { user_id: string }[]).map(s => s.user_id))]
        if (pushIds.length > 0) {
          const baseUrl = `/calendar?focus=${first}&view=fyi`
          // 押したときベル一覧を開いて該当行を光らせる。ベル通知が無い人はそのままカレンダーへ
          const urlsByUser: Record<string, string> = {}
          for (const uid of pushIds) {
            const nid = nidByUser.get(uid)
            if (nid) urlsByUser[uid] = addParams(baseUrl, { nids: nid, bell: '1' })
          }
          await supabase.functions.invoke('send-push', {
            body: { user_ids: pushIds, title: 'ファイブM 休暇申請', body: '休暇申請が受理されました', url: baseUrl, urls_by_user: urlsByUser, tag: 'leave-fyi' },
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
