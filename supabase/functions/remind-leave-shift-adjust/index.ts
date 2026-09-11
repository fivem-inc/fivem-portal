import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// 受理済みなのに「シフト調整がまだ」の休暇を、上長に知らせる。
//
// 設定はすべて管理画面から変えられる（2026-09-09 ユーザー指示）：
//   ・送るかどうか／時期（何ヶ月前）／送る時刻 … leave_shift_alert_settings
//   ・宛先（役職・同じチームに絞るか）     … notification_settings の leave:shift_adjust_due
//
// 🚨 cron は15分おきに呼ぶ。「送る時刻を過ぎた最初の回」で送り、あとは送った印で止まる。
//    時刻ちょうどの1回だけにすると、設定で時刻を変えられないうえ、
//    cron がその回だけ止まるとその日は送られない。
//
// 🚨「◯ヶ月前ちょうど」を等号で判定しない。cron が止まった日の分が永遠に送られなくなる。
//    「その日以内に入った かつ まだ送っていない」で判定し、送った印を列に残す。
//
// 🚨 上長1人に何十件も届かないよう、その人が受け持つぶんを1本にまとめる。
//
// 🚨 過ぎた休暇日は対象にしない。今さらシフトを組み直しても意味がなく、
//    導入直後に過去分がまとめて飛ぶ事故になる（2026-09-09 時点で未調整67件のうち59件が過去分だった）。

const jstNow = () => new Date(Date.now() + 9 * 60 * 60 * 1000)
const jstToday = () => jstNow().toISOString().slice(0, 10)

/** JSTの今日から n ヶ月後の日付 "YYYY-MM-DD" */
function addMonths(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + n, d)).toISOString().slice(0, 10)
}

/** その休暇の「いちばん早い休暇日」。旧申請は leave_dates が無いので start_date で補う */
function firstLeaveDate(row: { leave_dates: string | null; start_date: string }): string {
  if (row.leave_dates) {
    try {
      const arr = JSON.parse(row.leave_dates)
      if (Array.isArray(arr)) {
        const sorted = arr.filter((x): x is string => typeof x === 'string').sort()
        if (sorted.length > 0) return sorted[0]
      }
    } catch { /* 壊れていたら start_date を使う */ }
  }
  return row.start_date
}

const mdLabel = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`
/** "HH:MM[:SS]" → その日の何分目か */
const timeToMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  )

  // ---- 設定を読む ----
  const { data: st } = await supabase
    .from('leave_shift_alert_settings')
    .select('enabled, months_before, send_time, window_minutes')
    .eq('id', 1)
    .maybeSingle()

  const enabled = st?.enabled !== false
  // 🚨 設定が読めないときは既定で動かす（止まって気づかないより、既定で動くほうが安全）
  const monthsBefore: number[] = ((st?.months_before as number[] | null) ?? [3, 1])
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => b - a)   // 大きい順（3ヶ月前 → 1ヶ月前）
  const sendTime: string = (st?.send_time as string | null) ?? '09:10'
  const windowMin: number = (st?.window_minutes as number | null) ?? 120

  if (!enabled || monthsBefore.length === 0) {
    return new Response(JSON.stringify({ ok: true, skipped: 'disabled' }),
      { headers: { 'Content-Type': 'application/json' } })
  }

  // ---- いま送ってよい時間帯か ----
  const now = jstNow()
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes()   // jstNow は既に+9時間済み
  const startMin = timeToMin(sendTime)
  if (nowMin < startMin || nowMin >= startMin + windowMin) {
    return new Response(JSON.stringify({ ok: true, skipped: 'out of window', sendTime, windowMin }),
      { headers: { 'Content-Type': 'application/json' } })
  }

  const today = jstToday()
  const widest = addMonths(today, monthsBefore[0])   // いちばん早く知らせる時期

  // 対象：受理済み（マネージャー受理以降）で、シフト調整が「未」のもの。
  // 🚨 画面のチップ・絞り込みと同じ状態の集合にすること（片方だけ変えると食い違う）。
  const { data: rows, error } = await supabase
    .from('leave_requests')
    .select('id, user_id, leave_dates, start_date, shift_alert_3m_sent_at, shift_alert_1m_sent_at')
    .eq('shift_adjust_status', 'pending')
    .in('status', ['manager_approved', 'admin_approved', 'approved'])
    .gte('start_date', today)     // 🚨 過ぎた休暇は対象外
    .lte('start_date', widest)

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 })
  }

  // 送る対象を決める。
  // 🚨 印の列は2つしかない（3ヶ月前ぶん・それより近いぶん）。設定で時期を増やしても
  //    列は増やさず、「いちばん早い時期＝3m の印」「それ以外＝1m の印」で使う。
  //    こうすると、時期を {6,3,1} に変えても二重送信にならない（近い時期は1回だけ送る）。
  const first = monthsBefore[0]
  const targets: { id: string; user_id: string; leaveDate: string; mark3m: boolean; mark1m: boolean }[] = []
  type Row = {
    id: string; user_id: string; leave_dates: string | null; start_date: string
    shift_alert_3m_sent_at: string | null; shift_alert_1m_sent_at: string | null
  }
  for (const r of (rows ?? []) as Row[]) {
    const d = firstLeaveDate(r)
    if (d < today || d > widest) continue
    // いちばん早い時期の通知（まだ送っていなければ）
    const dueFirst = d <= addMonths(today, first) && !r.shift_alert_3m_sent_at
    // それより近い時期の通知（設定に2つ目以降があるときだけ）
    const nearer = monthsBefore.slice(1)
    const dueNear = nearer.some(m => d <= addMonths(today, m)) && !r.shift_alert_1m_sent_at
    if (!dueFirst && !dueNear) continue
    targets.push({ id: r.id, user_id: r.user_id, leaveDate: d, mark3m: dueFirst, mark1m: dueNear })
  }

  if (targets.length === 0) {
    return new Response(JSON.stringify({ ok: true, today, targets: 0, notified: 0 }),
      { headers: { 'Content-Type': 'application/json' } })
  }

  // ---- 申請者の名前 ----
  const applicantIds = [...new Set(targets.map(t => t.user_id))]
  const { data: profs } = await supabase.from('profiles').select('id, name').in('id', applicantIds)
  const nameOf = new Map(((profs ?? []) as { id: string; name: string }[]).map(p => [p.id, p.name]))

  // ---- 宛先の指定（管理画面の通知設定）----
  const { data: settings } = await supabase
    .from('notification_settings')
    .select('channel, enabled, recipient')
    .eq('event_key', 'leave:shift_adjust_due')
  const siteSetting = ((settings ?? []) as { channel: string; enabled: boolean; recipient: string | null }[])
    .find(s => s.channel === 'site')
  if (siteSetting && siteSetting.enabled === false) {
    return new Response(JSON.stringify({ ok: true, today, targets: targets.length, notified: 0, skipped: 'site off' }),
      { headers: { 'Content-Type': 'application/json' } })
  }
  // 🚨 既定値は役職名でなく立場のコード（2026-09-10 段4）。絞り込みの対象外の既定は DB 側の属性「経営」
  let recipientJson: Record<string, unknown> = { roles: ['manager', 'president'], groupFilter: 'same' }
  try { if (siteSetting?.recipient) recipientJson = JSON.parse(siteSetting.recipient) } catch { /* 既定を使う */ }

  // ---- 「上長 → その人が受け持つ休暇」に組み替える（1人1本にまとめる）----
  const byManager = new Map<string, { name: string; date: string }[]>()
  // 🚨 同じ申請者の宛先を何度も引かない（人数ぶん問い合わせると遅くなる）
  const cache = new Map<string, string[]>()
  for (const t of targets) {
    let ids = cache.get(t.user_id)
    if (!ids) {
      // 🚨 宛先の解決は DB の関数に任せる（同じ処理を書き写した4か所目を作らない）
      const { data, error: rerr } = await supabase.rpc('resolve_role_recipients', {
        p_applicant: t.user_id,
        p_recipient: recipientJson,
      })
      if (rerr) { console.error('[remind-leave-shift-adjust] 宛先を解決できません', rerr.message); continue }
      ids = ((data ?? []) as ({ resolve_role_recipients: string } | string)[])
        .map(row => (typeof row === 'string' ? row : row.resolve_role_recipients))
        .filter(Boolean)
      cache.set(t.user_id, ids)
    }
    for (const uid of ids) {
      const list = byManager.get(uid) ?? []
      list.push({ name: nameOf.get(t.user_id) ?? '', date: t.leaveDate })
      byManager.set(uid, list)
    }
  }

  const notifications: Record<string, unknown>[] = []
  for (const [uid, list] of byManager) {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date))
    const detail = sorted.slice(0, 5).map(x => `${mdLabel(x.date)} ${x.name}`).join('／')
    notifications.push({
      user_id: uid,
      message: `🔁 シフト調整がまだの休暇が${sorted.length}件あります`,
      sub_message: `${detail}${sorted.length > 5 ? ` 他${sorted.length - 5}件` : ''}`,
      source_type: 'leave:shift_adjust_due',
      event_key: 'leave:shift_adjust_due',
      // 押すと勤怠カレンダーの「未調整だけ」で絞った状態に着地する（App.tsx classifyNotif）
      reference_id: sorted[0].date,
    })
  }

  if (notifications.length > 0) {
    await supabase.from('notifications').insert(notifications)
  }

  // 🚨 送った印は必ず立てる。立て忘れると次の15分後にまた同じ通知が飛ぶ
  for (const t of targets) {
    const patch: Record<string, string> = {}
    if (t.mark3m) patch.shift_alert_3m_sent_at = new Date().toISOString()
    if (t.mark1m) patch.shift_alert_1m_sent_at = new Date().toISOString()
    if (Object.keys(patch).length === 0) continue
    // 🚨 update は0件でもエラーにならない。件数を見る
    const { data: upd } = await supabase.from('leave_requests').update(patch).eq('id', t.id).select('id')
    if (!upd || upd.length === 0) console.error('[remind-leave-shift-adjust] 印を立てられませんでした', t.id)
  }

  return new Response(JSON.stringify({
    ok: true, today, sendTime, monthsBefore,
    targets: targets.length, managers: byManager.size, notified: notifications.length,
  }), { headers: { 'Content-Type': 'application/json' } })
})
