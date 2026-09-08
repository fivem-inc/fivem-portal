import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// 受理済みなのに「シフト調整がまだ」の休暇を、上長に知らせる（毎朝1回）。
//
// ・休暇日の3ヶ月前と1ヶ月前の2回（2026-09-09 ユーザー確定）
// ・宛先は「同じチームのマネージャー以上」。解決は DB の resolve_role_recipients に任せる
//   （同じ処理を書き写した4か所目を作らないため。group_names をそのまま使うと
//    配信用グループが混ざって全員に飛ぶ事故がある）
//
// 🚨「3ヶ月前ちょうど」を等号で判定しない。cron が1日でも止まると、その日の分が
//    永遠に送られなくなる。「その日以内に入った かつ まだ送っていない」で判定し、
//    送った印（shift_alert_3m_sent_at / _1m_sent_at）を残す。
//
// 🚨 上長1人に何十件も届かないよう、その人が受け持つぶんを **1日1本** にまとめる
//    （remind-overtime-threshold と同じ形）。
//
// 🚨 過ぎた休暇日は対象にしない。今さらシフトを組み直しても意味がなく、
//    導入直後に過去分がまとめて飛ぶ事故になる（2026-09-09 時点で未調整67件）。

const jstToday = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)

/** JSTの今日から n ヶ月後の日付 "YYYY-MM-DD" */
function addMonths(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1 + n, d))
  return dt.toISOString().slice(0, 10)
}

/** その休暇の「いちばん早い休暇日」。旧申請は leave_dates が無いので start_date で補う */
function firstLeaveDate(row: { leave_dates: string | null; start_date: string }): string {
  if (row.leave_dates) {
    try {
      const arr = JSON.parse(row.leave_dates)
      if (Array.isArray(arr) && arr.length > 0) {
        const sorted = [...arr].filter(x => typeof x === 'string').sort()
        if (sorted.length > 0) return sorted[0]
      }
    } catch { /* 壊れていたら start_date を使う */ }
  }
  return row.start_date
}

const mdLabel = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  )

  const today = jstToday()
  const in3m = addMonths(today, 3)
  const in1m = addMonths(today, 1)

  // 対象：受理済み（マネージャー受理以降）で、シフト調整が「未」のもの。
  // 🚨 画面のチップ・絞り込みと同じ状態の集合にすること（片方だけ変えると食い違う）。
  const { data: rows, error } = await supabase
    .from('leave_requests')
    .select('id, user_id, leave_type, leave_dates, start_date, status, shift_alert_3m_sent_at, shift_alert_1m_sent_at')
    .eq('shift_adjust_status', 'pending')
    .in('status', ['manager_approved', 'admin_approved', 'approved'])
    .gte('start_date', today)      // 🚨 過ぎた休暇は対象外
    .lte('start_date', in3m)       // 3ヶ月より先はまだ知らせない

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 })
  }

  // 送る対象を決める（3ヶ月前・1ヶ月前のどちらか。両方の条件に当たったら1本だけ送り、印は両方立てる）
  const targets: { id: string; user_id: string; leaveDate: string; kind: '3m' | '1m'; mark3m: boolean; mark1m: boolean }[] = []
  for (const r of (rows ?? []) as { id: string; user_id: string; leave_dates: string | null; start_date: string; shift_alert_3m_sent_at: string | null; shift_alert_1m_sent_at: string | null }[]) {
    const d = firstLeaveDate(r)
    if (d < today || d > in3m) continue
    const due1m = d <= in1m && !r.shift_alert_1m_sent_at
    const due3m = d <= in3m && !r.shift_alert_3m_sent_at
    if (!due1m && !due3m) continue
    // 🚨 3ヶ月より近い時期に受理された休暇は、初回で両方の条件に当たる。
    //    1本だけ送り、印は両方立てる（翌日にもう1本届かないように）
    targets.push({
      id: r.id, user_id: r.user_id, leaveDate: d,
      kind: due1m ? '1m' : '3m',
      mark3m: due3m, mark1m: due1m,
    })
  }

  if (targets.length === 0) {
    return new Response(JSON.stringify({ ok: true, today, targets: 0, notified: 0 }),
      { headers: { 'Content-Type': 'application/json' } })
  }

  // 申請者の名前
  const applicantIds = [...new Set(targets.map(t => t.user_id))]
  const { data: profs } = await supabase.from('profiles').select('id, name').in('id', applicantIds)
  const nameOf = new Map(((profs ?? []) as { id: string; name: string }[]).map(p => [p.id, p.name]))

  // 通知設定（宛先の指定）。設定行が無いときは既定の宛先で送る
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
  let recipientJson: Record<string, unknown> = { roles: ['マネージャー', '社長'], groupFilter: 'same', orgWideRoles: ['社長', '管理者'] }
  try { if (siteSetting?.recipient) recipientJson = JSON.parse(siteSetting.recipient) } catch { /* 既定を使う */ }

  // 「上長 → その人が受け持つ休暇」に組み替える（1人1本にまとめるため）
  const byManager = new Map<string, { name: string; date: string }[]>()
  for (const t of targets) {
    // 🚨 宛先の解決は DB の関数に任せる（同じ処理を書き写さない）
    const { data: ids, error: rerr } = await supabase.rpc('resolve_role_recipients', {
      p_applicant: t.user_id,
      p_recipient: recipientJson,
    })
    if (rerr) continue
    for (const row of ((ids ?? []) as ({ resolve_role_recipients: string } | string)[])) {
      const uid = typeof row === 'string' ? row : row.resolve_role_recipients
      if (!uid) continue
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
      message: `シフト調整がまだの休暇が${sorted.length}件あります`,
      sub_message: `${detail}${sorted.length > 5 ? ` 他${sorted.length - 5}件` : ''}`,
      source_type: 'leave:shift_adjust_due',
      event_key: 'leave:shift_adjust_due',
      // 押すと勤怠カレンダーのその日に飛ぶ（受理FYIと同じ着地）
      reference_id: sorted[0].date,
    })
  }

  if (notifications.length > 0) {
    await supabase.from('notifications').insert(notifications)
  }

  // 🚨 送った印は必ず立てる。立て忘れると翌朝も同じ通知が飛ぶ
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
    ok: true, today, targets: targets.length, managers: byManager.size, notified: notifications.length,
  }), { headers: { 'Content-Type': 'application/json' } })
})
