// 残業がしきい値を超えている人へのお知らせ（毎月の指定日）
//
// 「超えた瞬間」の通知は DB のトリガー（notify_overtime_threshold_exceeded）が担当する。
// こちらは管理画面で選んだ日（既定 25日・5日）に念押しするぶん。
//
// ・本人には「あなたの残業が◯時間を超えています」
// ・上長には「同じ部門で◯人が超えています」＝1人ずつではなくまとめて1本
//   宛先の役職・グループ絞り込みは notification_settings（overtime:threshold）に従う
//
// cron から毎朝1回呼ばれ、その日が対象日でなければ何もせず終了する。
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

// 役職の序列（小さいほど上位）。
// ⚠️ client/src/pages/OvertimePage.tsx の ROLE_RANK と、
//    DB の overtime_role_rank() と同じ並び。変えるときは3つとも直すこと
const ROLE_RANK: Record<string, number> = {
  '社長': 1, '管理者': 1, 'マネージャー': 2, 'リーダー': 3,
  'フロア責任者': 4, '一般': 5, 'パート': 6,
}
const rankOf = (role?: string | null) => ROLE_RANK[role ?? ''] ?? 99

const jstToday = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)

/** 給与期間（16日〜翌15日）の開始日 */
function periodStartOf(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  if (d >= 16) return `${y}-${String(m).padStart(2, '0')}-16`
  const py = m === 1 ? y - 1 : y
  const pm = m === 1 ? 12 : m - 1
  return `${py}-${String(pm).padStart(2, '0')}-16`
}

const fmt = (min: number) => {
  const s = min < 0 ? '−' : '＋'
  const a = Math.abs(min)
  return `${s}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`
}

const applyVars = (t: string, v: Record<string, string>) =>
  t.replace(/\{\{(.+?)\}\}/g, (_, k) => v[k.trim()] ?? `{{${k.trim()}}}`)

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  )

  const today = jstToday()
  const dayNum = Number(today.slice(8, 10))
  // 翌日が1日なら今日は月末（定期リマインドと同じ「32＝月末日」の規約）
  const tomorrow = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)
  const isLastDay = tomorrow.slice(8, 10) === '01'

  const { data: settings } = await supabase
    .from('overtime_settings')
    .select('notify_days, notify_daily, banner_group_names')
    .eq('id', 1)
    .maybeSingle()

  const days: number[] = (settings?.notify_days as number[] | null) ?? [25, 5]
  const daily = Boolean(settings?.notify_daily)
  const teams: string[] = (settings?.banner_group_names as string[] | null) ?? []

  const isTargetDay = daily || days.includes(dayNum) || (isLastDay && days.includes(32))
  if (!isTargetDay) {
    return new Response(JSON.stringify({ ok: true, skipped: 'not a target day', today }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const period = periodStartOf(today)

  // 超過している人（在籍者のみ・除外者を除く。判定は見込み合計）
  const { data: overRows, error: overErr } = await supabase.rpc('overtime_threshold_over', { p_period: period })
  if (overErr) {
    return new Response(JSON.stringify({ error: overErr.message }), { status: 500 })
  }
  const over = (overRows ?? []) as { user_id: string; total_minutes: number; threshold_minutes: number }[]
  if (over.length === 0) {
    return new Response(JSON.stringify({ ok: true, over: 0, period }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // 通知設定
  const { data: setRows } = await supabase
    .from('notification_settings')
    .select('channel, enabled, recipient, subject, template')
    .eq('event_key', 'overtime:threshold')
  const settingOf = (ch: string) => (setRows ?? []).find((s: { channel: string }) => s.channel === ch)
  const site = settingOf('site')
  const email = settingOf('email')

  let roles: string[] = ['申請者本人', 'リーダー', 'マネージャー', '社長', '管理者']
  let orgWide: string[] = ['社長', '管理者']
  try {
    const p = JSON.parse((site?.recipient as string) ?? '{}')
    if (Array.isArray(p.roles)) roles = p.roles
    if (Array.isArray(p.orgWideRoles)) orgWide = p.orgWideRoles
  } catch { /* 既定のまま */ }
  const notifySelf = roles.includes('申請者本人')
  const managerRoles = roles.filter(r => r !== '申請者本人')

  // 対象者と上長のプロフィール
  const { data: profs } = await supabase
    .from('profiles')
    .select('id, name, role_title, group_names, email, is_active')
    .eq('is_active', true)
  const allProfs = (profs ?? []) as {
    id: string; name: string | null; role_title: string | null
    group_names: string[] | null; email: string | null
  }[]
  const profOf = new Map(allProfs.map(p => [p.id, p]))
  const teamsOf = (id: string) =>
    (profOf.get(id)?.group_names ?? []).filter(g => teams.includes(g))

  const periodLabel = (() => {
    const [y, m] = period.split('-').map(Number)
    const nm = m === 12 ? 1 : m + 1
    return `${m}/16〜${nm}/15`
  })()

  const notifications: Record<string, unknown>[] = []
  const records: Record<string, unknown>[] = []
  const mails: { to: string; subject: string; text: string }[] = []

  // ── 本人向け ──
  if (site?.enabled && notifySelf) {
    for (const o of over) {
      notifications.push({
        user_id: o.user_id,
        message: `今月の残業が${Math.floor(o.threshold_minutes / 60)}時間を超えています`,
        sub_message: `${periodLabel}　現在 ${fmt(o.total_minutes)}`,
        source_type: 'overtime:threshold',
        event_key: 'overtime:threshold',
        reference_id: period,
      })
    }
  }
  // 記録は通知のON/OFFに関わらず残す（上長向けの「前回からの増加」に使うため）
  for (const o of over) {
    records.push({
      user_id: o.user_id,
      pay_period_start: period,
      kind: 'scheduled',
      notify_key: today,
      total_minutes: o.total_minutes,
      threshold_minutes: o.threshold_minutes,
    })
  }

  if (email?.enabled && email.template && notifySelf) {
    for (const o of over) {
      const to = profOf.get(o.user_id)?.email
      if (!to) continue
      const vars = {
        '対象者名': profOf.get(o.user_id)?.name ?? '',
        '期間': periodLabel,
        '残業時間': fmt(o.total_minutes),
        'リンク': 'https://fivem-portal.vercel.app/overtime',
      }
      mails.push({
        to,
        subject: applyVars((email.subject as string) ?? '残業時間のお知らせ', vars),
        text: applyVars(email.template as string, vars),
      })
    }
  }

  // ── 上長向け（1人ずつではなく、自分が見る範囲でまとめて1本）──
  if (site?.enabled && managerRoles.length > 0) {
    const viewers = allProfs.filter(p => managerRoles.includes(p.role_title ?? ''))
    for (const v of viewers) {
      const vRank = rankOf(v.role_title)
      const vTeams = teamsOf(v.id)
      const seesAll = orgWide.includes(v.role_title ?? '')
      const targets = over.filter(o => {
        if (o.user_id === v.id) return false                     // 自分の分は本人向けで届く
        if (rankOf(profOf.get(o.user_id)?.role_title) < vRank) return false  // 自分より上位は見せない
        if (seesAll) return true
        return teamsOf(o.user_id).some(t => vTeams.includes(t))
      })
      if (targets.length === 0) continue
      const names = targets
        .sort((a, b) => b.total_minutes - a.total_minutes)
        .map(t => `${profOf.get(t.user_id)?.name ?? ''} ${fmt(t.total_minutes)}`)
        .join('／')
      notifications.push({
        user_id: v.id,
        message: `残業が目安を超えているスタッフが${targets.length}人います`,
        sub_message: `${periodLabel}　${names}`,
        source_type: 'overtime:threshold_summary',
        event_key: 'overtime:threshold',
        reference_id: period,
      })
    }
  }

  if (notifications.length > 0) {
    await supabase.from('notifications').insert(notifications)
  }
  if (records.length > 0) {
    // 同じ日に二重で走っても記録は1件（cronの多重起動対策）
    await supabase.from('overtime_threshold_notifications').upsert(records, {
      onConflict: 'user_id,pay_period_start,kind,notify_key',
      ignoreDuplicates: true,
    })
  }
  for (const m of mails) {
    await supabase.functions.invoke('send-email', { body: m })
    await new Promise(r => setTimeout(r, 80))
  }

  return new Response(JSON.stringify({
    ok: true, period, over: over.length,
    notified: notifications.length, mailed: mails.length,
  }), { headers: { 'Content-Type': 'application/json' } })
})
