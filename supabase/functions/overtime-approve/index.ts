// 残業・時間管理の 受理／差し戻し／取消 をサーバー側で一括実行する。
// ステータス更新・通知・GCal同期（gcal-sync action:'sync'）を直列で行い、
// GCal同期の失敗を握りつぶさずクライアントへ返す（同期漏れの静かな発生を防ぐ）。
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkCaller } from '../_shared/callerGate.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const DOW = ['日', '月', '火', '水', '木', '金', '土']
function dowLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return DOW[new Date(y, m - 1, d).getDay()]
}

function formatSignedMin(min: number): string {
  const sign = min > 0 ? '+' : min < 0 ? '-' : '±'
  const abs = Math.abs(min)
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`
}

// 管理画面「通知設定」(notification_settings) の1行。
// ⚠️ 行が無いときは「送る」(fail-open)。差し戻し等の通知が欠落すると業務が止まる（本人が再提出しない）ため、
//    seed漏れやRLS失敗で静かに無通知になるより送る側に倒す。クライアント側 shouldSend() は fail-closed なので挙動が違う点に注意。
type NotifSetting = { enabled: boolean; recipient: string | null; subject: string | null; template: string | null }

function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(.+?)\}\}/g, (_, key) => vars[String(key).trim()] ?? `{{${String(key).trim()}}}`)
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  // 🚨 呼ぶ人の門（2026-09-22）。本人の特定は下でもしているが、こちらは「在籍か期限内の退職者か」を見る
  const gate = await checkCaller(req)
  if (!gate.ok) return json({ success: false, error: gate.reason }, gate.status)

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

    // 呼び出し元ユーザーの特定（JWT検証）
    const authHeader = req.headers.get('Authorization') ?? ''
    const jwt = authHeader.replace(/^Bearer\s+/i, '')
    const authClient = createClient(supabaseUrl, anonKey)
    const { data: userData, error: userErr } = await authClient.auth.getUser(jwt)
    if (userErr || !userData?.user) return json({ success: false, error: '認証に失敗しました' }, 401)
    const caller = userData.user
    const isAdmin = (caller.app_metadata?.role ?? '') === 'admin'

    // shift_not_needed：終日（時間外調整休・振替休日・欠勤）を受理するときの「シフト調整：調整不要」（2026-10-13）
    // on_behalf：経理（管理者）が申請先の上長に代わって受理する（2026-10-14 ユーザー確定）。
    //   受理は今までどおり。足すのは ①履歴に「経理が代わりに受理」 ②元の申請先へベル（スマホなし・読めば済む）
    // shift_needed：遅出・早退・勤務地変更を事前申請の受理で「シフト調整：必要」にする（2026-10-20・docs/計画-遅出早退勤務地変更のシフト調整.md）。
    //   🚨 送られてこない（undefined）なら何もしない＝古い画面でも壊れない。true で条件に合わないときは黙って捨てずにエラーにする
    // change_location：振替休日の休む日を出勤に変えるとき、いつもと違う場所（在宅など）。空ならいつもどおり（2026-10-26 段6）
    // change_plan：休む日の時間や場所が違うとき（2026-10-27）。入力だけ（segments [{start,end}] 分・location・late_choice・early_choice）。
    //   休憩・労働・差分・種別は DB の furikae_change_eval が計算する（送られた計算の値は使わない）
    // plan_seen：受理する人の画面が、休む日の時間の変更（change_plan）を出してから受理したか。古い画面（端末の写し）は送らない＝受理させない
    const { report_id, action, comment, shift_not_needed, on_behalf, shift_needed, change_location, change_plan, plan_seen } = await req.json()
    // not_worked：振替休日の振替元の日に勤務しなかった（本人が［この日は勤務しませんでした］・2026-10-26 段5）
    // furikae_change：振替休日の休む日を出勤に変える依頼（振替元の休日出勤は残す・2026-10-26 段6）
    if (!report_id || !['approve', 'return', 'cancel', 'not_worked', 'furikae_change'].includes(action)) {
      return json({ success: false, error: '不正なリクエストです' }, 400)
    }
    if (action === 'return' && !String(comment ?? '').trim()) {
      return json({ success: false, error: '差し戻しの理由を入力してください' }, 400)
    }

    // x-actor-id：サーバーの鍵で書くと DB では「だれが」が分からないので、変更の記録（application_change_log）に
    // した人を渡す（2026-10-26）。🚨 入れるのは上で確かめた JWT の人だけ（画面から送られた値は使わない）
    const db = createClient(supabaseUrl, serviceKey, { global: { headers: { 'x-actor-id': caller.id } } })
    const { data: r, error: loadErr } = await db
      .from('overtime_reports')
      .select('id, applicant_id, reviewer_id, work_date, status, entry_type, diff_minutes, application_types, pay_period_start, is_post_hoc, from_trip_date, furikae_report_needed, furikae_origin_date, furikae_not_worked_at, request_confirmed_at, furikae_change_requested_at, furikae_change_reason, furikae_change_location, furikae_change_plan, normal_shift, replaces_leave_id')
      .eq('id', report_id)
      .maybeSingle()
    if (loadErr || !r) return json({ success: false, error: '対象の申請が見つかりません' }, 404)
    if (r.entry_type !== 'manual') return json({ success: false, error: '自動計上分は操作できません' }, 400)

    // 終日種別（調整休・振替休日・欠勤）：実績報告の概念がないため受理で confirmed 直行
    const FULL_DAY = ['chosei_off', 'furikae_off', 'absence']
    const types: string[] = r.application_types ?? []
    const isFullDay = types.some(t => FULL_DAY.includes(t))
    const FULL_DAY_LABEL: Record<string, string> = { chosei_off: '時間外調整休', furikae_off: '振替休日', absence: '欠勤' }
    const fullDayLabel = types.map(t => FULL_DAY_LABEL[t]).filter(Boolean).join('・')
    // 🚨 2026-10-26：振替元の日がまだ来ていなかった振替休日は、ふつうの事前申請と同じ（事前受理 → 振替元の実績を報告 → 確定）。
    //    印（furikae_report_needed）は DB のトリガーが決める（切り替え app_settings 'furikae_report_on' がオフなら立たない）
    const isFurikaeReport = r.furikae_report_needed === true
    const originDate = String(r.furikae_origin_date ?? '')

    // 申請者名（通知・GCalタイトル用）
    const { data: prof } = await db.from('profiles').select('name').eq('id', r.applicant_id).maybeSingle()
    const applicantName = prof?.name ?? ''

    let notification: Record<string, unknown> | null = null
    // Slackに流すイベント。🚨 notification とは切り離して持つ。
    // 取消は「確認者が自分自身（自己受理した申請）」だと notification が作られないため、
    // notification にぶら下げると取消がSlackに出なくなる
    let slackEventKey: string | null = null

    // 🚨 休職中は、ほかの人の申請の受理・差し戻しをしない（自分の休職前の日の確定は今までどおり・2026-10-20 ユーザー確定）。
    //    判定は DB の staff_on_leave（休職の記録は本人・マネージャー以上・管理者しか読めないため service で聞く）
    const onLeaveBlocked = async (): Promise<boolean> => {
      if (isAdmin || caller.id === r.applicant_id) return false
      const { data: ol, error: olErr } = await db.rpc('staff_on_leave', { p_user: caller.id })
      if (olErr) { console.error('[overtime-approve] 休職の確認に失敗:', olErr.message); return false }
      return ol === true
    }

    // 振替休日が取り消されたことを、受理のお知らせ（leave:approved_fyi）の相手へベルで知らせる（スマホなし）。失敗しても処理は成功のまま
    const notifyFurikaeCancelledFyi = async (): Promise<void> => {
      try {
        const { data: st } = await db.from('notification_settings').select('enabled, recipient')
          .eq('event_key', 'leave:approved_fyi').eq('channel', 'site').maybeSingle()
        if ((st as { enabled?: boolean } | null)?.enabled !== true) return
        let rcp: unknown = {}
        try { rcp = JSON.parse(String((st as { recipient?: string }).recipient || '{}')) } catch { rcp = {} }
        const { data: ids, error: rErr } = await db.rpc('resolve_role_recipients', { p_applicant: r.applicant_id, p_recipient: rcp })
        if (rErr) throw rErr
        const [, fm, fd] = String(r.work_date).split('-').map(Number)
        const rows = ((ids ?? []) as (string | { resolve_role_recipients: string })[])
          .map(x => typeof x === 'string' ? x : x.resolve_role_recipients)
          .filter(uid => uid && uid !== r.applicant_id)
          .map(uid => ({
            user_id: uid,
            message: `🕐 振替休日が取り消されました「${applicantName}（${fm}/${fd}（${dowLabel(r.work_date)}））」`,
            sub_message: null,
            source_type: 'overtime:fullday_fyi',
            event_key: null,
            reference_id: String(r.work_date),
          }))
        if (rows.length) {
          const { error: fErr } = await db.from('notifications').insert(rows)
          if (fErr) throw fErr
        }
      } catch (e) {
        console.error('[overtime-approve] 振替休日の取消のお知らせに失敗:', e instanceof Error ? e.message : String(e))
      }
    }
    // 「シフト調整の記録」の権限（leave_shift_adjust）を持つ人か管理者か（休暇の受理と同じ）
    const canShiftAdjust = async (): Promise<boolean> => {
      if (isAdmin) return true
      const { data: me } = await db.from('profiles').select('role_id').eq('id', caller.id).maybeSingle()
      if (!me?.role_id) return false
      const { data: fp } = await db.from('feature_permissions').select('enabled')
        .eq('role_id', me.role_id).eq('feature_key', 'leave_shift_adjust').maybeSingle()
      return fp?.enabled === true
    }
    // 休む日の申請の中身の1行（お知らせ用）。種別の名前は lib/overtimeTypes の typeLabelFor と同じ
    const TYPE_LABEL: Record<string, string> = { overtime: '残業', early_start: '早出', tardiness: '遅刻', early_leave: '早退',
      location_change: '勤務地変更', late_start_adj: '調整遅出', early_end_adj: '調整早退' }
    const SITUATION: Record<string, string> = { short_term: '短期・イベントなど', match: '練習・試合・遠征など', event: '会議・大掃除など', telework: '出張・在宅など' }
    const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
    const planLine = (ev: Record<string, unknown>): string => {
      const ts = ((ev.types as string[]) ?? []).map(t =>
        t === 'late_start_adj' && SITUATION[String(ev.late_situation)] ? `遅出(${SITUATION[String(ev.late_situation)]})`
        : t === 'early_end_adj' && SITUATION[String(ev.early_situation)] ? `早退(${SITUATION[String(ev.early_situation)]})`
        : (TYPE_LABEL[t] ?? t)).join('・')
      const segs = ((ev.segs as number[][]) ?? []).map(([a, b]) => `${hm(a)}〜${hm(b)}`).join('／')
      return `${ts} ${segs}（${String(ev.location ?? '')}）`
    }
    // あとで Google カレンダーに同期し直す申請（変更で新しくできた休日出勤・勤務地変更）
    const extraSyncIds: string[] = []
    // 振替休日の変更を当てる（DB の furikae_change_apply が 取消→休日出勤→休む日の申請 を1回で行う）
    // shiftNeeded：休む日の申請をシフト調整「必要」で作る（2026-10-27・呼ぶ前に権限を確かめる）
    const applyFurikaeChange = async (shiftNeeded = false): Promise<string | null> => {
      const { data: res, error: aErr } = await db.rpc('furikae_change_apply', { p_id: r.id, p_actor: caller.id, p_shift_needed: shiftNeeded })
      if (aErr) {
        const m = String(aErr.message ?? '')
        return m.includes('FURIKAE_CHANGE|') ? m.slice(m.indexOf('FURIKAE_CHANGE|') + 'FURIKAE_CHANGE|'.length) : '変更できませんでした: ' + m
      }
      const out = (res ?? {}) as { holiday_id?: string | null; location_id?: string | null }
      if (out.holiday_id) extraSyncIds.push(out.holiday_id)
      if (out.location_id) extraSyncIds.push(out.location_id)
      await notifyFurikaeCancelledFyi()
      return null
    }
    const md = (d: string) => `${String(d).slice(5).replace('-', '/')}（${dowLabel(String(d))}）`
    // 給与の締め（2026-10-26 レビュー 穴A・B）：期間＝16日〜翌15日・給与計算は支給月の17日から。取消（cancel）と同じ日付の決まり
    const payClose = (): { afterCutoff: boolean; afterPeriodEnd: boolean } => {
      const [ppy, ppm] = String(r.pay_period_start ?? '').split('-').map(Number)
      if (!ppy || !ppm) return { afterCutoff: false, afterPeriodEnd: false }
      const payY = ppm === 12 ? ppy + 1 : ppy, payM = ppm === 12 ? 1 : ppm + 1
      const mm = String(payM).padStart(2, '0')
      const jstToday = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
      return { afterCutoff: jstToday > `${payY}-${mm}-17`, afterPeriodEnd: jstToday > `${payY}-${mm}-15` }
    }
    // 期間の終わり（15日）を過ぎてから締め（17日）までに変更が当たったら、社長・経理へ知らせる（取消の「締め後アラート」と同じ・通知設定の対象外）
    const alertChangeAfterClose = async (): Promise<void> => {
      const pc = payClose()
      if (!pc.afterPeriodEnd || pc.afterCutoff) return
      try {
        const { data: adminIds } = await db.rpc('profile_ids_for_roles', { p_spec: ['org_wide'], p_exclude: caller.id })
        const rows = ((adminIds ?? []) as ({ profile_ids_for_roles: string } | string)[])
          .map(x => (typeof x === 'string' ? x : x.profile_ids_for_roles))
          .map(uid => ({
            user_id: uid,
            message: `⚠️ ${applicantName}さんの振替休日を、給与締め後に出勤へ変えました（休む日 ${String(r.work_date).slice(5).replace('-', '/')}・振替元 ${originDate.slice(5).replace('-', '/')} は休日出勤）`,
            sub_message: null, source_type: null, reference_id: null, read: false,
          }))
        if (rows.length) { const { error: aErr } = await db.from('notifications').insert(rows); if (aErr) throw aErr }
      } catch (e) {
        console.error('[overtime-approve] 振替休日の変更の締め後アラートに失敗:', e instanceof Error ? e.message : String(e))
      }
    }

    if (action === 'furikae_change') {
      // 🚨 本人だけ。振替休日（取消・却下・差し戻しでない）・勤務しなかった連絡や別の変更の依頼が無いこと・理由が要る
      if (caller.id !== r.applicant_id) return json({ success: false, error: '権限がありません' }, 403)
      if (!types.includes('furikae_off') || !originDate) return json({ success: false, error: '振替休日の申請ではありません' }, 409)
      if (!['requested', 'request_confirmed', 'reported', 'confirmed'].includes(r.status)) return json({ success: false, error: 'この状態では変えられません' }, 409)
      if (r.furikae_not_worked_at) return json({ success: false, error: '振替元の日に勤務しなかった連絡がある申請です' }, 409)
      if (r.furikae_change_requested_at) return json({ success: false, error: 'すでに変更を依頼しています' }, 409)
      const why = String(comment ?? '').trim()
      if (!why) return json({ success: false, error: '理由を入力してください' }, 400)
      if (why.length > 200) return json({ success: false, error: '理由は200字までにしてください' }, 400)
      let loc = String(change_location ?? '').trim().slice(0, 100)
      // 時間や場所が違うとき（2026-10-27）：入力だけを受け取り、DB で計算できるか先に確かめる（できなければ印を付けずに止める）
      let plan: Record<string, unknown> | null = null
      let planEv: Record<string, unknown> | null = null
      if (change_plan != null) {
        const p = change_plan as { segments?: unknown; location?: unknown; late_choice?: unknown; early_choice?: unknown }
        const segs = Array.isArray(p.segments) ? p.segments.slice(0, 3).map(x => ({
          start: Number((x as { start?: unknown })?.start), end: Number((x as { end?: unknown })?.end) })) : []
        if (segs.length === 0 || segs.some(x => !Number.isInteger(x.start) || !Number.isInteger(x.end))) {
          return json({ success: false, error: '勤務時間の入力を確認してください' }, 400)
        }
        const ch = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 20) : null)
        plan = { segments: segs, location: String(p.location ?? '').trim().slice(0, 100), late_choice: ch(p.late_choice), early_choice: ch(p.early_choice) }
        const { data: ev, error: evErr } = await db.rpc('furikae_change_eval', { p_normal: r.normal_shift, p_plan: plan })
        if (evErr) {
          const m = String(evErr.message ?? '')
          return json({ success: false, error: m.includes('FURIKAE_CHANGE|') ? m.slice(m.indexOf('FURIKAE_CHANGE|') + 'FURIKAE_CHANGE|'.length) : '内容を確かめられませんでした: ' + m }, 400)
        }
        planEv = (ev ?? {}) as Record<string, unknown>
        // 場所の列は今までどおり「いつもと違う場所のときだけ」（お知らせ・古い画面の表示に使う）
        loc = ((planEv.types as string[]) ?? []).includes('location_change') ? String(planEv.location ?? '') : ''
      }
      const selfReviewReq = !r.reviewer_id || r.reviewer_id === r.applicant_id
      // 自己受理の方の「シフト調整：必要」（受理と同じく、シフト調整の権限がある方だけ）
      if (shift_needed === true && (!selfReviewReq || !(await canShiftAdjust()))) {
        return json({ success: false, error: 'シフト調整の「必要」を選べるのは、シフト調整の権限がある方だけです' }, 403)
      }
      // 給与の締め（17日）を過ぎたら本人からは変えられない（取消と同じ）
      if (!isAdmin) {
        const [ppy, ppm] = String(r.pay_period_start ?? '').split('-').map(Number)
        if (ppy && ppm) {
          const payY = ppm === 12 ? ppy + 1 : ppy, payM = ppm === 12 ? 1 : ppm + 1
          const cutoff17 = `${payY}-${String(payM).padStart(2, '0')}-17`
          const jstToday = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
          if (jstToday > cutoff17) return json({ success: false, error: '給与計算が始まっているため（毎月17日以降）変えられません。管理者に依頼してください' }, 403)
        }
      }
      const { data: marked, error: mErr } = await db.from('overtime_reports')
        .update({ furikae_change_requested_at: new Date().toISOString(), furikae_change_requested_by: caller.id,
          furikae_change_reason: why, furikae_change_location: loc || null, furikae_change_plan: plan })
        .eq('id', r.id).eq('status', r.status).is('furikae_change_requested_at', null).select('id')
      if (mErr) return json({ success: false, error: '更新に失敗しました: ' + mErr.message }, 500)
      if (!marked || marked.length === 0) return json({ success: false, error: 'この申請の状態が変わっています。画面を更新してからやり直してください' }, 409)
      if (selfReviewReq) {
        // 自己受理の方は押した時点で変える
        const err = await applyFurikaeChange(shift_needed === true)
        if (!err) await alertChangeAfterClose()
        if (err) {
          await db.from('overtime_reports').update({ furikae_change_requested_at: null, furikae_change_requested_by: null, furikae_change_reason: null, furikae_change_location: null, furikae_change_plan: null }).eq('id', r.id)
          return json({ success: false, error: err }, 409)
        }
        slackEventKey = 'overtime:cancelled'
      } else {
        // 申請先へ（🚨 新しい通知の種類は作らない＝実績報告が届いたときと同じ種類）
        notification = {
          user_id: r.reviewer_id,
          message: `🕐 ${applicantName}さんから振替休日の変更（休む日 ${md(r.work_date)} を出勤に）が届きました`,
          sub_message: `振替元 ${md(originDate)} は休日出勤のまま${planEv ? `・休む日：${planLine(planEv)}` : loc ? `・休む日の勤務地：${loc}` : ''}`,
          source_type: 'overtime_request:pending_approval',
          reference_id: r.id,
          event_key: 'overtime:new_request',
          read: false,
        }
      }
    } else if (action === 'approve' && r.furikae_change_requested_at) {
      // 振替休日の変更の受理（2026-10-26 段6）
      if (!(isAdmin || caller.id === r.reviewer_id)) return json({ success: false, error: '権限がありません' }, 403)
      if (await onLeaveBlocked()) return json({ success: false, error: '現在、受理はできません。' }, 403)
      if (on_behalf === true && !isAdmin) return json({ success: false, error: '代わりに受理できるのは経理（管理者）だけです' }, 403)
      // 🚨 給与計算が始まった期間（支給月の17日以降）は、上長の受理で給与の数字を変えない＝管理者だけ（2026-10-26 レビュー 穴A）
      if (!isAdmin && payClose().afterCutoff) {
        return json({ success: false, error: '給与計算が始まっているため（毎月17日以降）、変更の受理は管理者が行います' }, 403)
      }
      // 🚨 休む日の時間の変更がある依頼は、それを出す新しい画面からだけ受理する（古い画面は「出勤（勤務地）」としか出さない・2026-10-27）
      if (r.furikae_change_plan && plan_seen !== true) {
        return json({ success: false, error: '画面が古いため受理できません。画面を更新してから、もう一度受理してください' }, 409)
      }
      if (shift_needed === true && !(await canShiftAdjust())) {
        return json({ success: false, error: 'シフト調整の「必要」を選べるのは、シフト調整の権限がある方だけです' }, 403)
      }
      const err = await applyFurikaeChange(shift_needed === true)
      if (err) return json({ success: false, error: err }, 409)
      await alertChangeAfterClose()
      notification = {
        user_id: r.applicant_id,
        message: '🕐 振替休日の変更が受理されました',
        sub_message: `休む日 ${md(r.work_date)} は出勤・振替元 ${md(originDate)} は休日出勤になりました`,
        source_type: 'overtime_request',
        reference_id: r.id,
        event_key: 'overtime:confirmed',
        read: false,
      }
      slackEventKey = 'overtime:cancelled'
      // 経理が代わりに受理したとき（2026-10-29・ふつうの受理と同じ：履歴に1行・元の申請先へベルだけ＝スマホに乗らない）
      if (on_behalf === true && r.reviewer_id && r.reviewer_id !== caller.id) {
        const { data: rv } = await db.from('profiles').select('name').eq('id', r.reviewer_id).maybeSingle()
        const reviewerName = (rv as { name?: string } | null)?.name ?? ''
        const { error: hErr } = await db.from('overtime_report_history').insert({
          report_id: r.id, changed_by: caller.id, change_kind: 'approved',
          change_summary: `経理が代わりに受理（振替休日の変更・申請先：${reviewerName || '不明'}）`, snapshot: r,
        })
        if (hErr) console.error('[overtime-approve] 代わりに受理の履歴の記録に失敗:', hErr.message)
        if (r.reviewer_id !== r.applicant_id) {
          const { error: fErr } = await db.from('notifications').insert({
            user_id: r.reviewer_id,
            message: '経理が代わりに受理しました',
            sub_message: `${applicantName}さん 振替休日の変更（休む日 ${md(r.work_date)} は出勤・振替元 ${md(originDate)} は休日出勤）`,
            source_type: 'overtime_request:proxy_fyi',
            reference_id: r.id,
            read: false,
          })
          if (fErr) console.error('[overtime-approve] 元の申請先へのお知らせに失敗:', fErr.message)
        }
      }
    } else if (action === 'approve') {
      if (!(isAdmin || caller.id === r.reviewer_id)) return json({ success: false, error: '権限がありません' }, 403)
      if (await onLeaveBlocked()) return json({ success: false, error: '現在、受理はできません。' }, 403)
      if (on_behalf === true && !isAdmin) return json({ success: false, error: '代わりに受理できるのは経理（管理者）だけです' }, 403)
      // 欠勤の自己受理はマネージャー以上のみ（2026-08-21 に開放。リーダー以下は他の人の受理が必要）
      // 🚨 同じ判定が overtime_reports の RLS（overtime_insert_own）にもある。
      //    自己受理は受理ボタンを通らず直接 INSERT されるため、あちらが本来の砦。片方だけ直さないこと。
      if (types.includes('absence') && caller.id === r.applicant_id && !isAdmin) {
        // 🚨 役職名では判定しない（2026-09-10 段4）。マネージャー以上＝roles.is_manager_plus（DB の role_is_manager_plus）
        const { data: mp } = await db.rpc('role_is_manager_plus', { p_uid: caller.id })
        if (mp !== true) {
          return json({ success: false, error: '欠勤の自己受理はマネージャー以上のみです' }, 403)
        }
      }
      if (!['requested', 'reported'].includes(r.status)) return json({ success: false, error: 'この状態では受理できません' }, 409)
      // 有休からの変更（2026-10-27 段2a）：受理と同じ取引で有休を取り消す（DB の apply_leave_replacement）。
      // 🚨 給与計算が始まった期間（支給月の17日以降）は、上長の受理で給与の数字を変えない＝管理者だけ（振替休日の変更と同じ）
      if (r.replaces_leave_id && !isAdmin && payClose().afterCutoff) {
        return json({ success: false, error: '給与計算が始まっているため（毎月17日以降）、変更の受理は管理者が行います' }, 403)
      }
      // 振替元の日に勤務しなかった連絡がある振替休日は受理しない（受理すると働いた時間として確定してしまう・段5で取消か切り替えを選ぶ）
      if (r.furikae_not_worked_at) {
        return json({ success: false, error: '振替元の日に勤務しなかったと連絡がある申請です。受理ではなく、取り消すか休みの種類を切り替えてください' }, 409)
      }
      const isAdvance = r.status === 'requested'
      // 終日は実績報告が無いため、事前申請の受理でも confirmed 直行（振替元の日がまだ来ていなかった振替休日を除く）
      // 事前受理は日時も残す。残さないと status が reported に進んだ時点で
      // 「事前に受理したのか、受理を飛ばして報告されたのか」が分からなくなる（2026-08-25）
      const toRequestConfirmed = isAdvance && (!isFullDay || isFurikaeReport)
      const next: Record<string, unknown> = toRequestConfirmed
        ? { status: 'request_confirmed', request_confirmed_at: new Date().toISOString() }
        : { status: 'confirmed', confirmed_by: caller.id, confirmed_at: new Date().toISOString() }
      // 遅出・早退・勤務地変更の事前申請を受理するときの「シフト調整：必要」（2026-10-20）。受理と同じ1回の保存で書く。
      // 🚨 条件（DB の見張り enforce_overtime_shift_needed と同じ）：事前申請の受理・終日を含まない・遅出などを含む・事後報告でない・出張報告からでない・今日以降
      if (shift_needed === true) {
        const PARTIAL = ['location_change', 'late_start_adj', 'tardiness', 'early_end_adj', 'early_leave']
        const todayJst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
        const okCase = isAdvance && !isFullDay && types.some(t => PARTIAL.includes(t))
          && r.is_post_hoc !== true && !r.from_trip_date && String(r.work_date) >= todayJst
        if (!okCase) return json({ success: false, error: 'この申請では、シフト調整を選べません（遅出・早退・勤務地変更を含む、今日以降の事前申請だけです）' }, 400)
        if (!(await canShiftAdjust())) return json({ success: false, error: 'シフト調整の「必要」を選べるのは、シフト調整の権限がある方だけです' }, 403)
        next.shift_adjust_needed = true
        next.shift_adjusted_by = caller.id
        next.shift_adjusted_at = new Date().toISOString()
      }
      // 終日の受理で「調整不要」を選んだとき（2026-10-13）。受理と同じ1回の保存で書く（別々だと受理だけ通ることがある）。
      // 🚨 選べるのは「シフト調整の記録」の権限（leave_shift_adjust）を持つ人か管理者だけ（休暇の受理と同じ）
      // 🚨 振替休日の実績の確定（reported → confirmed）では書かない（事前受理のときに選んだ値を上書きしないため・2026-10-26）
      if (isFullDay && isAdvance && shift_not_needed === true) {
        const canShift = await canShiftAdjust()
        if (canShift) {
          next.shift_adjust_not_needed = true
          next.shift_adjusted_by = caller.id
          next.shift_adjusted_at = new Date().toISOString()
        }
      }
      // 🚨 楽観ロックは .eq('status') だけでは足りない。update は0件でもエラーにならないので、
      //    件数を見ないと「実際は何も更新していないのに受理の通知だけ飛ぶ」ことが起きる。
      //    未受理のまま本人が実績報告できるようにした（2026-08-25）ことで、
      //    上長の受理と本人の報告が同時に起きうるようになったため必ず件数を確認する
      const { data: updated, error } = await db.from('overtime_reports')
        .update(next).eq('id', r.id).eq('status', r.status).select('id')
      if (error) return json({ success: false, error: '更新に失敗しました: ' + error.message }, 500)
      if (!updated || updated.length === 0) {
        return json({ success: false, error: 'この申請の状態が変わっています。画面を更新してからやり直してください' }, 409)
      }
      // 振替休日の実績（振替元の勤務）の確定は、その旨と振替元の日を出す
      const furikaeActual = isFurikaeReport && !isAdvance && !!originDate
      notification = {
        user_id: r.applicant_id,
        message: furikaeActual ? '🕐 振替元の勤務（実績）が確認されました'
          : isFullDay ? `🕐 ${fullDayLabel}の申請が受理されました` : (isAdvance ? '🕐 事前申請が受理されました' : '🕐 残業・時間調整の実績が確認されました'),
        sub_message: furikaeActual
          ? `振替元 ${originDate}（${dowLabel(originDate)}）　休む日 ${r.work_date}（${dowLabel(r.work_date)}）`
          : `${r.work_date}（${dowLabel(r.work_date)}）${isFullDay ? `　${fullDayLabel}` : `　${formatSignedMin(r.diff_minutes ?? 0)}`}`,
        source_type: 'overtime_request',
        reference_id: r.id,
        event_key: toRequestConfirmed ? 'overtime:request_confirmed' : 'overtime:confirmed',
        read: false,
      }
      slackEventKey = toRequestConfirmed ? 'overtime:request_confirmed' : 'overtime:confirmed'

      // 経理が代わりに受理したとき（申請先が別の人のときだけ）
      if (on_behalf === true && r.reviewer_id && r.reviewer_id !== caller.id) {
        const { data: rv } = await db.from('profiles').select('name').eq('id', r.reviewer_id).maybeSingle()
        const reviewerName = (rv as { name?: string } | null)?.name ?? ''
        const { error: hErr } = await db.from('overtime_report_history').insert({
          report_id: r.id, changed_by: caller.id, change_kind: 'approved',
          change_summary: `経理が代わりに受理（申請先：${reviewerName || '不明'}）`,
          snapshot: r,  // 🚨 snapshot は空にできない（not null）。受理する前の行（読んだ時点）を残す
        })
        if (hErr) console.error('[overtime-approve] 代わりに受理の履歴の記録に失敗:', hErr.message)
        // 元の申請先へ（ユーザー確定 案1）。🚨 event_key を付けない＝スマホに乗らない（ベルだけ・2026-10-14 ユーザー確定 A）
        if (r.reviewer_id !== r.applicant_id) {
          const TYPE_LABEL: Record<string, string> = {
            overtime: '残業', early_start: '早出', tardiness: '遅刻', early_leave: '早退', holiday_work: '休日出勤',
            location_change: '勤務地変更', late_start_adj: '調整遅出', early_end_adj: '調整早退',
            chosei_off: '時間外調整休', furikae_off: '振替休日', absence: '欠勤', clock_only: '打刻ズレ',
          }
          const kind = types.map(t => TYPE_LABEL[t]).filter(Boolean).join('・') || '残業・時間調整'
          let when = ''
          if (!isFullDay) {
            const phase = r.status === 'reported' ? 'actual' : 'planned'
            const { data: segs } = await db.from('overtime_report_segments').select('seg_no, start_min, end_min')
              .eq('report_id', r.id).eq('phase', phase).order('seg_no')
            const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
            when = ((segs ?? []) as { start_min: number; end_min: number }[]).map(g => `${hm(g.start_min)}〜${hm(g.end_min)}`).join('、')
          }
          const [, mm, dd] = String(r.work_date).split('-').map(Number)
          const { error: fErr } = await db.from('notifications').insert({
            user_id: r.reviewer_id,
            message: '経理が代わりに受理しました',
            sub_message: `${applicantName}さん ${mm}/${dd}（${dowLabel(r.work_date)}）${kind}${when ? ' ' + when : ''}`,
            // 🚨 読めば済むお知らせ。'overtime_request:cancelled_fyi' と同じく、押しても移動しない（App.tsx の classifyNotif）
            source_type: 'overtime_request:proxy_fyi',
            reference_id: r.id,
            read: false,
          })
          if (fErr) console.error('[overtime-approve] 元の申請先へのお知らせに失敗:', fErr.message)
        }
      }
    } else if (action === 'not_worked') {
      // 🚨 本人だけ。振替元の実績を報告する振替休日で、事前受理済み（または実績の差し戻しのあと）・振替元の日が来ていること
      if (caller.id !== r.applicant_id) return json({ success: false, error: '権限がありません' }, 403)
      const jstToday = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
      const okState = r.status === 'request_confirmed' || (r.status === 'returned' && !!r.request_confirmed_at)
      if (!isFurikaeReport || !originDate || !okState) return json({ success: false, error: 'この申請では使えません' }, 409)
      if (originDate > jstToday) return json({ success: false, error: '振替元の日が来てから押してください' }, 409)
      const why = String(comment ?? '').trim()
      if (!why) return json({ success: false, error: '理由を選んでください' }, 400)
      if (why.length > 200) return json({ success: false, error: '理由は200字までにしてください' }, 400)
      const { data: snap } = await db.from('overtime_reports').select('*').eq('id', r.id).maybeSingle()
      const { data: updated, error } = await db.from('overtime_reports')
        .update({ status: 'reported', furikae_not_worked_at: new Date().toISOString(), furikae_not_worked_reason: why,
          change_reason: `振替元の日に勤務しませんでした（${why}）`, return_comment: null })
        .eq('id', r.id).eq('status', r.status).select('id')
      if (error) return json({ success: false, error: '更新に失敗しました: ' + error.message }, 500)
      if (!updated || updated.length === 0) {
        return json({ success: false, error: 'この申請の状態が変わっています。画面を更新してからやり直してください' }, 409)
      }
      await db.from('overtime_report_history').insert({
        report_id: r.id, changed_by: caller.id, change_kind: 'edited',
        change_summary: `振替元の日に勤務しなかった（${why}）`, snapshot: snap ?? r,
      })
      // 申請先（上長）へ。🚨 新しい通知の種類は作らない（設定が無い＝全員に送る作りのため）＝実績報告が届いたときと同じ種類
      if (r.reviewer_id && r.reviewer_id !== r.applicant_id) {
        notification = {
          user_id: r.reviewer_id,
          message: `🕐 ${applicantName}さんから、振替元 ${originDate.slice(5).replace('-', '/')}（${dowLabel(originDate)}）に勤務しなかったと連絡がありました`,
          sub_message: `休む日 ${String(r.work_date).slice(5).replace('-', '/')}（${dowLabel(r.work_date)}）の扱いを選んでください`,
          source_type: 'overtime_request:pending_approval',
          reference_id: r.id,
          event_key: 'overtime:new_request',
          read: false,
        }
      }
    } else if (action === 'return' && r.furikae_change_requested_at) {
      // 振替休日の変更の依頼を差し戻す（振替休日はそのまま・2026-10-26 段6）
      if (!(isAdmin || caller.id === r.reviewer_id)) return json({ success: false, error: '権限がありません' }, 403)
      if (await onLeaveBlocked()) return json({ success: false, error: '現在、差し戻しはできません。' }, 403)
      const { data: back, error: bErr } = await db.from('overtime_reports')
        .update({ furikae_change_requested_at: null, furikae_change_requested_by: null, furikae_change_reason: null, furikae_change_location: null, furikae_change_plan: null })
        .eq('id', r.id).not('furikae_change_requested_at', 'is', null).select('id')
      if (bErr) return json({ success: false, error: '更新に失敗しました: ' + bErr.message }, 500)
      if (!back || back.length === 0) return json({ success: false, error: 'この申請の状態が変わっています。画面を更新してからやり直してください' }, 409)
      notification = {
        user_id: r.applicant_id,
        message: '🕐 振替休日の変更が差し戻されました',
        sub_message: `休む日 ${md(r.work_date)}　理由：${String(comment).trim()}`,
        source_type: 'overtime_request',
        reference_id: r.id,
        event_key: 'overtime:returned',
        read: false,
      }
    } else if (action === 'return') {
      if (!(isAdmin || caller.id === r.reviewer_id)) return json({ success: false, error: '権限がありません' }, 403)
      if (await onLeaveBlocked()) return json({ success: false, error: '現在、差し戻しはできません。' }, 403)
      if (!['requested', 'reported'].includes(r.status)) return json({ success: false, error: 'この状態では差し戻せません' }, 409)
      // 勤務しなかった連絡の差し戻し（押し間違いなど）：事前受理の状態に戻し、印を消す＝本人はもう一度ふつうに報告できる（2026-10-26 段5）
      if (r.furikae_not_worked_at && r.status === 'reported') {
        const { data: back, error: bErr } = await db.from('overtime_reports')
          .update({ status: 'request_confirmed', furikae_not_worked_at: null, furikae_not_worked_reason: null, change_reason: null, return_comment: String(comment).trim() })
          .eq('id', r.id).eq('status', 'reported').select('id')
        if (bErr) return json({ success: false, error: '更新に失敗しました: ' + bErr.message }, 500)
        if (!back || back.length === 0) return json({ success: false, error: 'この申請の状態が変わっています。画面を更新してからやり直してください' }, 409)
        notification = {
          user_id: r.applicant_id,
          message: '🕐 振替元の日に勤務しなかった連絡が差し戻されました',
          sub_message: `振替元 ${originDate}（${dowLabel(originDate)}）　理由：${String(comment).trim()}`,
          source_type: 'overtime_request',
          reference_id: r.id,
          event_key: 'overtime:returned',
          read: false,
        }
      } else {
      // 受理と同じ理由で、差し戻しも件数を見る（0件なら差し戻せていないので通知を出さない）
      const { data: updated, error } = await db.from('overtime_reports')
        .update({ status: 'returned', return_comment: String(comment).trim() })
        .eq('id', r.id).eq('status', r.status).select('id')
      if (error) return json({ success: false, error: '更新に失敗しました: ' + error.message }, 500)
      if (!updated || updated.length === 0) {
        return json({ success: false, error: 'この申請の状態が変わっています。画面を更新してからやり直してください' }, 409)
      }
      notification = {
        user_id: r.applicant_id,
        message: '🕐 残業・時間調整の申請が差し戻されました',
        sub_message: `${r.work_date}（${dowLabel(r.work_date)}）　理由：${String(comment).trim()}`,
        source_type: 'overtime_request:pending_resubmit',
        reference_id: r.id,
        event_key: 'overtime:returned',
        read: false,
      }
      }
    } else {
      // cancel（本人取消）。🚨 振替元の日に勤務しなかった連絡がある振替休日は、申請先（上長・自己受理なら本人）も取り消せる（2026-10-26 段5）
      if (r.furikae_change_requested_at && !isAdmin) return json({ success: false, error: '振替休日の変更を依頼中です。変更をやめるときは申請先の方に差し戻してもらってください' }, 409)
      const notWorkedCancel = !!r.furikae_not_worked_at && r.status === 'reported' && caller.id === r.reviewer_id
      if (caller.id !== r.applicant_id && !isAdmin && !notWorkedCancel) return json({ success: false, error: '権限がありません' }, 403)
      if (!['requested', 'request_confirmed', 'reported', 'returned'].includes(r.status)) {
        return json({ success: false, error: 'この状態では取消できません' }, 409)
      }
      // 本人取消の制限（管理者は対象外）：reported(実績報告済＝実態あり)は不可／支給月17日を過ぎたら不可。
      // 締め後(その期の16〜17日)の本人取消は管理者へアラート。期間＝16日〜翌15日（15締め25支給）。
      // ※新規申請の締めロック（DBトリガー enforce_overtime_submission_window）と同じ17日で統一。
      let notifyAfterClose = false
      if (!isAdmin) {
        if (r.status === 'reported' && !notWorkedCancel) {
          return json({ success: false, error: '実績報告済みのため取り消せません。申請先の担当者に取り下げ（差し戻し）を依頼してください' }, 403)
        }
        // 振替元の日がまだ来ていなかった振替休日：休む日・振替元の日のどちらかが来たら本人は取り消せない（2026-10-26 ユーザー確定）。
        // 🚨 画面（lib/furikaeReport の furikaeSelfCancelLocked）と同じ判定。片方だけ直さないこと
        if (isFurikaeReport && originDate && !notWorkedCancel) {
          const jstToday = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
          const firstDay = String(r.work_date) < originDate ? String(r.work_date) : originDate
          if (jstToday >= firstDay) {
            return json({ success: false, error: '休む日・振替元の日のどちらかが来たため、ご自分では取り消せません。振替元の日に勤務しなかった場合は［この日は勤務しませんでした］、それ以外は管理者に取消を依頼してください' }, 403)
          }
        }
        const [ppy, ppm] = String(r.pay_period_start ?? '').split('-').map(Number)
        if (ppy && ppm) {
          const payY = ppm === 12 ? ppy + 1 : ppy
          const payM = ppm === 12 ? 1 : ppm + 1
          const mm = String(payM).padStart(2, '0')
          const cutoff17 = `${payY}-${mm}-17`, periodEnd = `${payY}-${mm}-15`
          const jst = new Date(Date.now() + 9 * 60 * 60 * 1000)
          const todayStr = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`
          if (todayStr > cutoff17) {
            return json({ success: false, error: '給与計算が始まっているため（毎月17日以降）取り消せません。管理者に依頼してください' }, 403)
          }
          if (todayStr > periodEnd) notifyAfterClose = true
        }
      }
      const { data: snapshot } = await db.from('overtime_reports').select('*').eq('id', r.id).maybeSingle()
      // 楽観ロック：ロード時の status と一致する時だけ取消（別確認者が confirmed 等へ遷移させた確定レコードを踏み潰さない）
      const { data: updated, error } = await db.from('overtime_reports')
        .update({ status: 'cancelled' }).eq('id', r.id).eq('status', r.status).select('id')
      if (error) return json({ success: false, error: '更新に失敗しました: ' + error.message }, 500)
      if (!updated || updated.length === 0) {
        return json({ success: false, error: 'この申請の状態が変わったため取り消せませんでした。画面を更新してください' }, 409)
      }
      await db.from('overtime_report_history').insert({
        report_id: r.id, changed_by: caller.id, change_kind: 'cancelled', change_summary: '取消', snapshot,
      })
      slackEventKey = 'overtime:cancelled'
      // 事前受理で「振替休日が受理されました」を受け取った人（休暇の受理のお知らせと同じ相手）にも取消を知らせる（2026-10-26 ユーザー確定）。
      // 🚨 スマホには出さない（event_key なし）。失敗しても取消は成功のまま
      if (isFurikaeReport && (r.status === 'request_confirmed' || notWorkedCancel)) {
        await notifyFurikaeCancelledFyi()
      }
      // 勤務しなかった連絡を受けて申請先が取り消したときは、本人へ知らせる
      if (notWorkedCancel && caller.id !== r.applicant_id) {
        notification = {
          user_id: r.applicant_id,
          message: `🕐 振替元の日に勤務しなかったため、振替休日が取り消されました（休む日 ${String(r.work_date).slice(5).replace('-', '/')}（${dowLabel(r.work_date)}））`,
          sub_message: '休む日を有休・時間外調整休などにするときは、申請を出し直してください',
          source_type: 'overtime_request:cancelled_fyi',
          reference_id: r.id,
          event_key: 'overtime:cancelled',
          read: false,
        }
      } else if (r.reviewer_id && r.reviewer_id !== caller.id && ['requested', 'request_confirmed', 'reported'].includes(r.status)) {
        notification = {
          user_id: r.reviewer_id,
          message: `${applicantName}さんが残業・時間調整の申請を取り消しました`,
          sub_message: `${r.work_date}（${dowLabel(r.work_date)}）`,
          // 🚨 'overtime_request'（＝本人への結果報告）にすると、確認者がタップしたとき
          //    「自分の履歴」を開いて存在しないIDを探しに行き必ず空振りする。
          //    取消は確認待ち一覧からも消えているので、専用の source_type で
          //    「移動しないお知らせ」として扱う（2026-08-18 修正）
          source_type: 'overtime_request:cancelled_fyi',
          reference_id: r.id,
          event_key: 'overtime:cancelled',
          read: false,
        }
      }
      // 締め後(16〜20日)の本人取消 → 管理者・社長へアラート（情報通知・タップは閉じるのみ）
      if (notifyAfterClose) {
        // 🚨 役職名では引かない（2026-09-10 段4）。経営（属性 is_org_wide＝社長・経理）
        const { data: adminIds } = await db.rpc('profile_ids_for_roles', { p_spec: ['org_wide'], p_exclude: caller.id })
        const rows = ((adminIds ?? []) as ({ profile_ids_for_roles: string } | string)[])
          .map(r => ({ id: typeof r === 'string' ? r : r.profile_ids_for_roles }))
          .map((a: { id: string }) => ({
            user_id: a.id,
            message: `⚠️ ${applicantName}さんが給与締め後に残業申請を取り消しました（${String(r.work_date).slice(5).replace('-', '/')}）`,
            sub_message: null,
            source_type: null,
            reference_id: null,
            read: false,
          }))
        if (rows.length) {
          const { error: aErr } = await db.from('notifications').insert(rows)
          if (aErr) console.error('[overtime-approve] 締め後アラート作成失敗:', aErr.message)
        } else {
          console.warn('[overtime-approve] 締め後アラートの宛先(role_title=管理者/社長)が0件。役職名の実値を確認')
        }
      }
    }

    // 通知（管理画面「通知設定」に従う）。
    // ・サイト通知(site) … ベル。event_key を付けて入れると、DBトリガー経由でプッシュも自動で流れる
    //                      （＝サイト通知OFFにするとプッシュも止まる。管理画面にその旨を注記済み）
    // ・プッシュ(push)  … ここでは何もしない（送ると二重送信になる）
    // ・メール(email)   … 宛先はサイト通知と同じ人（本人 or 確認をお願いする人）
    // ※ 下の「締め後アラート」は給与計算に直結するガバナンス通知のため、この設定の対象外（常時送る）
    if (notification) {
      const eventKey = String(notification.event_key)
      const { data: settingRows } = await db
        .from('notification_settings')
        .select('channel, enabled, recipient, subject, template')
        .eq('event_key', eventKey)
        .in('channel', ['site', 'email'])
      const settings = new Map<string, NotifSetting>()
      for (const s of (settingRows ?? []) as (NotifSetting & { channel: string })[]) {
        settings.set(s.channel, s)
      }
      const siteSetting = settings.get('site')
      const emailSetting = settings.get('email')

      if (siteSetting?.enabled ?? true) {
        const { error: nErr } = await db.from('notifications').insert(notification)
        if (nErr) console.error('[overtime-approve] 通知作成失敗:', nErr.message)
      }

      if (emailSetting?.enabled && emailSetting.template) {
        const targetId = String(notification.user_id)
        const isToApplicant = targetId === r.applicant_id
        const vars: Record<string, string> = {
          申請者名: applicantName,
          日付: `${r.work_date}（${dowLabel(r.work_date)}）`,
          種別: isFullDay ? fullDayLabel : '残業・時間調整',
          時間: isFullDay ? fullDayLabel : formatSignedMin(r.diff_minutes ?? 0),
          差し戻し理由: String(comment ?? '').trim() || '（記載なし）',
          リンク: `https://fivem-portal.vercel.app/overtime${isToApplicant ? '?tab=history' : '?view=confirm'}`,
        }
        const { data: targetProf } = await db.from('profiles').select('email').eq('id', targetId).maybeSingle()
        const to = (targetProf as { email?: string } | null)?.email
        if (to) {
          // メール送信の失敗で受理・差し戻しそのものを失敗扱いにはしない（ログのみ）
          try {
            const res = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                to,
                subject: emailSetting.subject ? applyTemplate(emailSetting.subject, vars) : eventKey,
                text: applyTemplate(emailSetting.template, vars),
              }),
            })
            if (!res.ok) console.error('[overtime-approve] メール送信失敗: status=', res.status)
          } catch (e) {
            console.error('[overtime-approve] メール送信失敗:', e instanceof Error ? e.message : String(e))
          }
        }
      }
    }

    // Slack通知（送信先チャンネルとON/OFFは管理画面の通知設定に従う。本文は send-overtime-slack が組み立てる）
    // 失敗しても受理・取消そのものは成功のままにする（ログのみ）
    if (slackEventKey) {
      try {
        await fetch(`${supabaseUrl}/functions/v1/send-overtime-slack`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ report_id: r.id, event_key: slackEventKey }),
        })
      } catch (e) {
        console.error('[overtime-approve] Slack送信失敗:', e instanceof Error ? e.message : String(e))
      }
    }

    // GCal同期（冪等な再計算）。失敗はエラーにせず結果として返す→クライアントがインライン表示＋再試行。
    let gcalOk = true
    let gcalError = ''
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/gcal-sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync', source_type: 'overtime', source_id: r.id }),
      })
      const data = await res.json()
      if (!res.ok || data?.success === false) { gcalOk = false; gcalError = data?.error ?? `status=${res.status}` }
    } catch (e) {
      gcalOk = false
      gcalError = e instanceof Error ? e.message : String(e)
    }
    if (!gcalOk) console.error('[overtime-approve] GCal同期失敗:', gcalError)
    for (const sid of extraSyncIds) {
      try {
        const res2 = await fetch(`${supabaseUrl}/functions/v1/gcal-sync`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'sync', source_type: 'overtime', source_id: sid }),
        })
        const d2 = await res2.json()
        if (!res2.ok || d2?.success === false) { gcalOk = false; gcalError = d2?.error ?? `status=${res2.status}` }
      } catch (e) {
        gcalOk = false
        gcalError = e instanceof Error ? e.message : String(e)
      }
    }

    // 有休からの変更が受理されたら、有休の予定を直す（2026-10-27 段2a）。取り消し＝消す／1日だけ抜いた＝消してから残りの日で作り直す
    // 🚨 共用の gcal-sync は変えない（delete と upsert を順に呼ぶだけ）。作り直すのはカレンダーに出る段（マネージャーの受理から）だけ
    if (action === 'approve' && r.replaces_leave_id && !r.furikae_change_requested_at) {
      try {
        const { data: lv } = await db.from('leave_requests').select('id, user_id, status, leave_type, leave_dates, leave_locations').eq('id', r.replaces_leave_id).maybeSingle()
        const call = async (body: Record<string, unknown>) => {
          const res3 = await fetch(`${supabaseUrl}/functions/v1/gcal-sync`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          const d3 = await res3.json()
          if (!res3.ok || d3?.success === false) throw new Error(d3?.error ?? `status=${res3.status}`)
        }
        if (lv) {
          await call({ action: 'delete', source_type: 'leave', source_id: lv.id, dates: [String(r.work_date)] })
          const rest = (() => { try { return JSON.parse(String(lv.leave_dates ?? '[]')) as string[] } catch { return [] as string[] } })()
          if (['manager_approved', 'admin_approved', 'approved'].includes(String(lv.status)) && rest.length > 0) {
            let locations: Record<string, string> = {}
            try { locations = JSON.parse(String(lv.leave_locations ?? '{}')) } catch { locations = {} }
            await call({ action: 'upsert', source_type: 'leave', source_id: lv.id, dates: rest, name: applicantName, leave_type: lv.leave_type, locations })
          }
        }
      } catch (e) {
        gcalOk = false
        gcalError = e instanceof Error ? e.message : String(e)
        console.error('[overtime-approve] 有休の予定の直しに失敗:', gcalError)
      }
    }

    return json({ success: true, gcal_ok: gcalOk, gcal_error: gcalOk ? undefined : gcalError })
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
