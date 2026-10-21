// 有休奨励日の休みを Google カレンダーに出す（2026-10-19・計画 docs/計画-有休奨励日のカレンダー.md）
// ・設定 app_settings 'gcal_encouragement'：mode（off／summary＝まとめて1件／each＝1人ずつ）・types（有休・調整休・その他）・names
// ・その日を「今の記録」から作り直す（差分だけ）。まとめの予定は中身を直す（PATCH）だけで、消して作り直さない
// ・その日の 'leave' の予定のうち、もとの休暇の行が無い・受理の途中でも受理済みでもない（取消・差し戻しなど）・その日を含まないもの（取り残し）も消す
// 🚨 予定を消すときは、作ったときのカレンダー（gcal_events.calendar_id）から消す
// 🚨 dry_run のときは Google も DB も書かない（ops に「作る・直す・消す」を積むだけ）

// deno-lint-ignore no-explicit-any
type Sb = any

export const ENC_REASON = '【有給奨励日】'
export const ENC_TITLE = '有休奨励日'
/**
 * まとめの予定の名前（2026-10-21 ユーザー確定 案A）。もとからある「休館日、有給奨励日」の予定と見分けるため、
 * 「取得一覧」と、休む人／送った人（対象）の人数を入れる。対象が読めないときは休む人の数だけ
 */
export function encSummaryTitle(total: number, targets: number | null): string {
  return targets != null && targets > 0 ? `${ENC_TITLE} 取得一覧（${total}/${targets}名）` : `${ENC_TITLE} 取得一覧（${total}名）`
}
const ENC_COLOR = '4' // ふだんの有休と同じ Flamingo（ピンク）
const ALL_TYPES = ['有休', '調整休', 'その他'] as const
type EncType = typeof ALL_TYPES[number]

export interface EncSetting { mode: 'off' | 'summary' | 'each'; types: EncType[]; names: boolean }
export const ENC_DEFAULT: EncSetting = { mode: 'summary', types: [...ALL_TYPES], names: true }

export interface EncCtx {
  supabase: Sb
  token: string
  calendarId: string
  dryRun: boolean
  ops: string[]
  setting: EncSetting
  createEvent: (token: string, calendarId: string, summary: string, date: string, colorId: string, description?: string) => Promise<string>
  /** 404/410（Google 側で人が消した）なら false */
  patchEvent: (token: string, calendarId: string, eventId: string, fields: Record<string, unknown>) => Promise<boolean>
  deleteEvent: (token: string, calendarId: string, eventId: string) => Promise<void>
  leaveLabel: (leaveType: string) => string
}

export interface EncCount { created: number; updated: number; deleted: number }

export function encTypeOf(leaveType: string): EncType {
  if (leaveType === '有給休暇' || leaveType === 'バースデー休暇（有給）') return '有休'
  if (leaveType === '調整休') return '調整休'
  return 'その他'
}

export async function readEncSetting(supabase: Sb): Promise<EncSetting> {
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'gcal_encouragement').maybeSingle()
    const v = (data?.value ?? null) as Partial<EncSetting> | null
    if (!v) return ENC_DEFAULT
    const mode = v.mode === 'off' || v.mode === 'each' || v.mode === 'summary' ? v.mode : ENC_DEFAULT.mode
    const types = Array.isArray(v.types) ? ALL_TYPES.filter(t => (v.types as string[]).includes(t)) : [...ALL_TYPES]
    return { mode, types, names: v.names !== false }
  } catch {
    return ENC_DEFAULT
  }
}

/** 日本時間の今日（YYYY-MM-DD） */
export function jstToday(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
}

const normName = (s: unknown) => String(s ?? '').replace(/　/g, ' ').trim()

/**
 * カレンダーに出ている休暇の状態（受理の途中も含む）。🚨 1人目の受理（manager_approved）の時点で予定を作るので、
 * 'approved' だけを見ると、まだ2人目を待っている休暇の予定を「取り残し」と間違えて消してしまう（2026-10-19 dry_run で見つけた）。
 * 同じ並びが client/src/pages/CalendarPage.tsx にもある
 */
export const LEAVE_LIVE_STATUSES = ['manager_approved', 'admin_approved', 'approved']

/** 休暇の日付（leave_dates は JSON の文字列）。🚨 読めないときは null＝「取り残し」と決めつけない（消さない側に倒す） */
export function parseLeaveDates(v: unknown): string[] | null {
  if (v == null) return []
  if (Array.isArray(v)) return v.map(String)
  try {
    const x = JSON.parse(String(v))
    return Array.isArray(x) ? x.map(String) : null
  } catch {
    return null
  }
}

/**
 * まとめの予定の本文（案2）。
 * 2026-10-21 ユーザー確定：合計の下に「対象 ◯名・回答 ◯名・未回答 ◯名」を1行足す（counts が読めたときだけ）
 */
export function encDescription(groups: Record<EncType, string[]>, types: EncType[], names: boolean, counts?: { targets: number; responded: number } | null): { text: string; total: number } {
  const lines: string[] = []
  let total = 0
  for (const t of ALL_TYPES) {
    if (!types.includes(t)) continue
    const list = groups[t] ?? []
    if (list.length === 0) continue
    total += list.length
    lines.push(`【${t} ${list.length}人】`)
    if (names) lines.push(list.join('、'))
  }
  if (total === 0) return { text: '', total: 0 }
  lines.push('')
  lines.push(`合計 ${total}人`)
  if (counts) lines.push(`対象 ${counts.targets}名・回答 ${counts.responded}名・未回答 ${Math.max(0, counts.targets - counts.responded)}名`)
  return { text: lines.join('\n'), total }
}

async function delRow(ctx: EncCtx, row: { id: string; event_id: string; calendar_id: string | null; source_type: string; source_id: string }, why: string, cnt: EncCount) {
  ctx.ops.push(`消す：${row.source_type} ${row.source_id}（${why}）`)
  cnt.deleted++
  if (ctx.dryRun) return
  await ctx.deleteEvent(ctx.token, row.calendar_id || ctx.calendarId, row.event_id)
  await ctx.supabase.from('gcal_events').delete().eq('id', row.id)
}

/**
 * その日の奨励日の予定を、今の記録と設定どおりにそろえる（差分だけ）。
 * dayId が null（奨励日が無い・消された）のときは、その日のまとめの予定と、奨励日の休暇の予定を消すだけ
 */
export async function syncEncouragementDay(ctx: EncCtx, date: string, dayId: string | null): Promise<EncCount> {
  const cnt: EncCount = { created: 0, updated: 0, deleted: 0 }
  const sb = ctx.supabase

  // その日の奨励日の休暇（受理済み）と名前
  const { data: leaves, error: lvErr } = await sb.from('leave_requests')
    .select('id, user_id, leave_type, status, leave_dates')
    .eq('reason', ENC_REASON).eq('status', 'approved').eq('start_date', date)
  if (lvErr) throw new Error('奨励日の休暇を読めませんでした: ' + lvErr.message)
  const lvList = (leaves ?? []) as { id: string; user_id: string; leave_type: string }[]
  const userIds = [...new Set(lvList.map(l => l.user_id))]
  const nameOf = new Map<string, string>()
  if (userIds.length > 0) {
    const { data: profs } = await sb.from('profiles').select('id, name').in('id', userIds)
    for (const p of (profs ?? []) as { id: string; name: string }[]) nameOf.set(p.id, normName(p.name))
  }
  const mode = dayId ? ctx.setting.mode : 'off'
  const include = mode === 'off' ? [] : lvList.filter(l => ctx.setting.types.includes(encTypeOf(l.leave_type)))

  // その日の予定の記録（まとめ・1人ずつ）
  const { data: rows, error: rowErr } = await sb.from('gcal_events')
    .select('id, source_type, source_id, event_id, calendar_id, date').eq('date', date).in('source_type', ['leave', 'encouragement'])
  if (rowErr) throw new Error('予定の記録を読めませんでした: ' + rowErr.message)
  const evRows = (rows ?? []) as { id: string; source_type: string; source_id: string; event_id: string; calendar_id: string | null }[]

  // 'leave' の予定のもとの休暇（奨励日のものか・取り残しか）
  const leaveRowIds = evRows.filter(r => r.source_type === 'leave').map(r => r.source_id)
  const srcById = new Map<string, { reason: string | null; status: string; leave_dates: string | null }>()
  if (leaveRowIds.length > 0) {
    const { data: srcs } = await sb.from('leave_requests').select('id, reason, status, leave_dates').in('id', leaveRowIds)
    for (const s of (srcs ?? []) as { id: string; reason: string | null; status: string; leave_dates: string | null }[]) srcById.set(s.id, s)
  }
  const wantEach = new Set(mode === 'each' ? include.map(l => l.id) : [])

  // 1人ずつの予定：奨励日の休暇のもの・取り残しを、設定どおりに残す／消す
  for (const r of evRows.filter(x => x.source_type === 'leave')) {
    const src = srcById.get(r.source_id)
    const dates = src ? parseLeaveDates(src.leave_dates) : []
    const orphan = !src || !LEAVE_LIVE_STATUSES.includes(src.status) || (dates !== null && !dates.includes(date))
    const isEnc = !!src && src.reason === ENC_REASON
    if (orphan) { await delRow(ctx, r, 'もとの休暇の行が無い・受理の途中でも受理済みでもない', cnt); continue }
    if (!isEnc) continue // ふだんの休暇は触らない
    const keep = wantEach.has(r.source_id) && (r.calendar_id || ctx.calendarId) === ctx.calendarId
    if (keep) wantEach.delete(r.source_id)
    else await delRow(ctx, r, mode === 'each' ? '出す休みに入っていない・連携先が変わった' : '1人ずつでない設定', cnt)
  }
  // 足りない1人ずつの予定を作る
  for (const l of include.filter(x => wantEach.has(x.id))) {
    const title = `${nameOf.get(l.user_id) ?? ''}｜${ctx.leaveLabel(l.leave_type)}`
    ctx.ops.push(`作る：1人ずつ ${title}`)
    cnt.created++
    if (ctx.dryRun) continue
    const eventId = await ctx.createEvent(ctx.token, ctx.calendarId, title, date, ENC_COLOR)
    const { error } = await sb.from('gcal_events').insert({ source_type: 'leave', source_id: l.id, calendar_id: ctx.calendarId, event_id: eventId, date })
    // 何人も同時に作り直したとき：ほかの呼び出しが先に作っていたら、こちらで作った予定を消す
    if (error) await ctx.deleteEvent(ctx.token, ctx.calendarId, eventId)
  }

  // まとめの予定
  const sumRows = evRows.filter(x => x.source_type === 'encouragement')
  const groups: Record<EncType, string[]> = { '有休': [], '調整休': [], 'その他': [] }
  for (const l of include) groups[encTypeOf(l.leave_type)].push(nameOf.get(l.user_id) ?? '')
  for (const t of ALL_TYPES) groups[t].sort((a, b) => a.localeCompare(b, 'ja'))
  // 送った人（対象）と回答した人の数。読めなければ名前と説明欄に出さない（予定は今までどおり作る）
  let counts: { targets: number; responded: number } | null = null
  if (dayId) {
    const [tRes, rRes] = await Promise.all([
      sb.from('paid_leave_encouragement_targets').select('id', { count: 'exact', head: true }).eq('encouragement_day_id', dayId),
      sb.from('paid_leave_encouragement_responses').select('id', { count: 'exact', head: true }).eq('encouragement_day_id', dayId),
    ])
    if (!tRes.error && !rRes.error && typeof tRes.count === 'number' && typeof rRes.count === 'number') counts = { targets: tRes.count, responded: rRes.count }
  }
  const desc = encDescription(groups, ctx.setting.types, ctx.setting.names, counts)
  const title = encSummaryTitle(desc.total, counts ? counts.targets : null)
  const wantSummary = mode === 'summary' && desc.total > 0 && !!dayId

  let kept: typeof sumRows[number] | null = null
  for (const r of sumRows) {
    if (wantSummary && !kept && r.source_id === dayId && (r.calendar_id || ctx.calendarId) === ctx.calendarId) { kept = r; continue }
    await delRow(ctx, r, wantSummary ? '重なり・連携先が変わった' : 'まとめて1件でない・休む人がいない', cnt)
  }
  if (wantSummary) {
    const fields = { summary: title, description: desc.text, colorId: ENC_COLOR }
    if (kept) {
      ctx.ops.push(`直す：まとめ（${desc.total}人）\n${desc.text}`)
      cnt.updated++
      if (!ctx.dryRun) {
        const ok = await ctx.patchEvent(ctx.token, kept.calendar_id || ctx.calendarId, kept.event_id, fields)
        if (!ok) {
          // Google 側で人が消していた：記録を消して作り直す
          await sb.from('gcal_events').delete().eq('id', kept.id)
          const eventId = await ctx.createEvent(ctx.token, ctx.calendarId, title, date, ENC_COLOR, desc.text)
          await sb.from('gcal_events').insert({ source_type: 'encouragement', source_id: dayId, calendar_id: ctx.calendarId, event_id: eventId, date })
        }
      }
    } else {
      ctx.ops.push(`作る：まとめ（${desc.total}人）\n${desc.text}`)
      cnt.created++
      if (!ctx.dryRun) {
        const eventId = await ctx.createEvent(ctx.token, ctx.calendarId, title, date, ENC_COLOR, desc.text)
        const { error } = await sb.from('gcal_events').insert({ source_type: 'encouragement', source_id: dayId, calendar_id: ctx.calendarId, event_id: eventId, date })
        if (error) {
          // ほかの呼び出しが先に作っていた（一意の重なり）：こちらの予定を消し、先にできた予定の中身を直す
          await ctx.deleteEvent(ctx.token, ctx.calendarId, eventId)
          const { data: other } = await sb.from('gcal_events').select('event_id, calendar_id')
            .eq('source_type', 'encouragement').eq('source_id', dayId).eq('date', date).maybeSingle()
          if (other) await ctx.patchEvent(ctx.token, other.calendar_id || ctx.calendarId, other.event_id, fields)
        }
      }
    }
  }
  return cnt
}

/** これからの奨励日（＋奨励日が消されたのに予定が残っている日）を全部そろえる */
export async function syncEncouragementAll(ctx: EncCtx): Promise<EncCount & { days: number }> {
  const today = jstToday()
  const { data: days } = await ctx.supabase.from('paid_leave_encouragement_days').select('id, target_date').gte('target_date', today)
  const dayByDate = new Map<string, string>()
  for (const d of (days ?? []) as { id: string; target_date: string }[]) dayByDate.set(d.target_date, d.id)
  const { data: left } = await ctx.supabase.from('gcal_events').select('date').eq('source_type', 'encouragement').gte('date', today)
  const dates = new Set<string>([...dayByDate.keys(), ...((left ?? []) as { date: string }[]).map(x => x.date)])
  const sum = { created: 0, updated: 0, deleted: 0, days: 0 }
  for (const date of [...dates].sort()) {
    const c = await syncEncouragementDay(ctx, date, dayByDate.get(date) ?? null)
    sum.created += c.created; sum.updated += c.updated; sum.deleted += c.deleted; sum.days++
  }
  return sum
}

/**
 * 毎晩：これからの日付の 'leave'・'overtime' の予定のうち、もとの行がもう無いもの（取り残し）を消す（2026-10-19 ユーザー確定）。
 * 'leave' は「取消・差し戻しなど（LEAVE_LIVE_STATUSES に無い）・その日を含まない」も取り残し。'overtime' の中身の正しさは sync が受け持つので、行が無いものだけ
 */
export async function cleanupOrphans(ctx: EncCtx): Promise<number> {
  const today = jstToday()
  const { data: rows } = await ctx.supabase.from('gcal_events')
    .select('id, source_type, source_id, event_id, calendar_id, date').gte('date', today).in('source_type', ['leave', 'overtime'])
  const all = (rows ?? []) as { id: string; source_type: string; source_id: string; event_id: string; calendar_id: string | null; date: string }[]
  const cnt: EncCount = { created: 0, updated: 0, deleted: 0 }
  const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n))

  const leaveRows = all.filter(r => r.source_type === 'leave')
  const lv = new Map<string, { status: string; leave_dates: string | null }>()
  for (const ids of chunk([...new Set(leaveRows.map(r => r.source_id))], 100)) {
    const { data, error } = await ctx.supabase.from('leave_requests').select('id, status, leave_dates').in('id', ids)
    if (error) throw new Error('休暇を読めませんでした: ' + error.message)
    for (const x of (data ?? []) as { id: string; status: string; leave_dates: string | null }[]) lv.set(x.id, x)
  }
  for (const r of leaveRows) {
    const src = lv.get(r.source_id)
    const dates = src ? parseLeaveDates(src.leave_dates) : []
    if (!src || !LEAVE_LIVE_STATUSES.includes(src.status) || (dates !== null && !dates.includes(r.date))) await delRow(ctx, r, '取り残し（休暇）', cnt)
  }

  const otRows = all.filter(r => r.source_type === 'overtime')
  const ot = new Set<string>()
  for (const ids of chunk([...new Set(otRows.map(r => r.source_id))], 100)) {
    const { data, error } = await ctx.supabase.from('overtime_reports').select('id').in('id', ids)
    if (error) throw new Error('残業申請を読めませんでした: ' + error.message)
    for (const x of (data ?? []) as { id: string }[]) ot.add(x.id)
  }
  for (const r of otRows) if (!ot.has(r.source_id)) await delRow(ctx, r, '取り残し（残業）', cnt)
  return cnt.deleted
}
