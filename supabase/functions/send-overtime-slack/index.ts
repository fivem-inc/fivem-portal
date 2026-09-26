// 残業・時間管理のSlack通知
//
// サイト通知（ベル）・プッシュ・メールは別の場所で送っている。
// SlackだけはWebhook URLがサーバー側の秘密のため、この関数を経由する。
//
// 🚨 呼び出し元が5箇所（申請・自己受理・事前受理・受理・取消・管理者取消）あるので、
//    本文の材料を引数で配らず report_id だけ受け取ってサーバー側で組み立てる。
//    引数で配ると、あとから項目を足したとき必ずどこかで渡し忘れる（このリポジトリの定番事故）。
//
// 【まとめて1通】（2026-09-25）
//   残業の「表でまとめて入力」は1回で1か月ぶん送れるので、1件ずつ呼ぶとチャンネルに最大31通流れる。
//   report_ids（配列）を渡すと、同じ種類（event_key）のものを1通にまとめ、1日1行の一覧で送る（ユーザー確定・案A）。
//   🚨 report_id（1件）の呼び方も今までどおり使える。ほかの5箇所は触っていない。
//   🚨 まとめて呼べるのは本人の申請だけ（service_role からの呼び出しを除く）。
//      他人の申請IDを並べて、好きなだけ Slack に流せないようにするため。
//   打刻ズレを除いて1件しか残らないときは、今までの1件の形で送る（1件フォームと同じ見た目）。
//
// 送信先チャンネルと ON/OFF は管理画面「通知設定」の overtime:* / slack から読む。
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { checkCaller } from '../_shared/callerGate.ts'

const ALLOWED_ORIGINS = ['https://fivem-portal.vercel.app', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175']

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') || ''
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
}

// チャンネルごとのWebhook URL（Supabase Edge Function Secretsに設定）
const SLACK_WEBHOOK_KEYS: Record<string, string> = {
  leader:     'SLACK_WEBHOOK_LEADER',
  manager:    'SLACK_WEBHOOK_MANAGER',
  accounting: 'SLACK_WEBHOOK_ACCOUNTING',
  president:  'SLACK_WEBHOOK_PRESIDENT',
  overtime:   'SLACK_WEBHOOK_OVERTIME',
}

// 種別ラベル。gcal-sync の OVERTIME_TYPES と同じ表記に揃える（2箇所管理・片方だけ直さないこと）
const TYPE_LABEL: Record<string, string> = {
  holiday_work:    '休日出勤',
  overtime:        '残業',
  early_start:     '早出',
  late_start_adj:  '遅出(調整)',
  early_end_adj:   '早退(調整)',
  location_change: '勤務地変更',
  tardiness:       '遅刻',
  early_leave:     '早退',
  chosei_off:      '時間外調整休',
  furikae_off:     '振替休日',
  absence:         '欠勤',
  clock_only:      '打刻ズレ',
}

// 終日種別（時間帯を持たない）
const FULL_DAY_TYPES = ['chosei_off', 'furikae_off', 'absence']

const HEAD_BY_EVENT: Record<string, string> = {
  'overtime:new_request':       '🕐 *残業・時間｜申請*',
  'overtime:request_confirmed': '🕐 *残業・時間｜事前受理*',
  'overtime:confirmed':         '🕐 *残業・時間｜受理*',
  'overtime:cancelled':         '🕐 *残業・時間｜取消*',
  'overtime:admin_cancelled':   '🕐 *残業・時間｜取消（管理者）*',
}

// まとめて送れる件数の上限（表は1か月ぶん＝最大31日。余裕を見て2か月ぶん）
const MAX_IDS = 62
// Slack の section ブロックは1つ3,000文字まで。超えそうなら枠を分ける
const SECTION_LIMIT = 2900

/** 分 → "9:05"（先頭0なし。Googleカレンダー・勤怠通知と同じ書式） */
function minToTime(min: number): string {
  const h = Math.floor(min / 60), m = min % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

const DOW = ['日', '月', '火', '水', '木', '金', '土']

type Report = {
  id: string
  applicant_id: string
  work_date: string
  application_types: string[] | null
  location: string | null
  /** 「開始が遅い／早く終わる理由」で押した事情（adj／event／telework）。表記に使う（2026-09-26） */
  late_situation?: string | null
  early_situation?: string | null
  segments: { phase: string; seg_no: number; start_min: number; end_min: number }[] | null
}

// 押した事情があれば表記を変える。🚨 client/src/lib/overtimeTypes.ts の typeLabelFor・gcal-sync と同じ文字（3か所管理）
const SITUATION_SUFFIX: Record<string, string> = { event: 'イベント・会議など', telework: '出張・在宅など' }
function typeLabelOf(t: string, r: Report): string {
  if (t === 'late_start_adj' && SITUATION_SUFFIX[String(r.late_situation ?? '')]) return `遅出(${SITUATION_SUFFIX[String(r.late_situation)]})`
  if (t === 'early_end_adj' && SITUATION_SUFFIX[String(r.early_situation ?? '')]) return `早退(${SITUATION_SUFFIX[String(r.early_situation)]})`
  return TYPE_LABEL[t] ?? t
}

/**
 * 1件ぶんの中身（種別・日付・時間・勤務地）。1件の形とまとめの形の両方がこれを使う
 * （🚨 同じ組み立てを2か所に書かない）。時間と勤務地は終日種別では空
 */
function describe(report: Report) {
  const types: string[] = report.application_types ?? []
  const typeLabels = types.map(t => typeLabelOf(t, report)).join('・')
  const d = new Date(report.work_date + 'T00:00:00Z')
  const dateLabel = `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${DOW[d.getUTCDay()]}）`

  // 時間帯：実績（actual）があれば実績、無ければ予定（planned）。終日種別は時間を持たない
  const isFullDay = types.some(t => FULL_DAY_TYPES.includes(t))
  let timeLine = ''
  if (!isFullDay) {
    const segs = report.segments ?? []
    const actual = segs.filter(s => s.phase === 'actual').sort((a, b) => a.seg_no - b.seg_no)
    const planned = segs.filter(s => s.phase === 'planned').sort((a, b) => a.seg_no - b.seg_no)
    const use = actual.length > 0 ? actual : planned
    timeLine = use.map(s => `${minToTime(s.start_min)}〜${minToTime(s.end_min)}`).join(' / ')
  }
  const location = !isFullDay && report.location ? report.location : ''
  return { typeLabels, dateLabel, timeLine, location }
}

/** 行を section ブロックに詰める（1つ SECTION_LIMIT 文字まで） */
function toSections(lines: string[]): string[] {
  const out: string[] = []
  let cur = ''
  for (const line of lines) {
    const next = cur ? `${cur}\n${line}` : line
    if (cur && next.length > SECTION_LIMIT) { out.push(cur); cur = line }
    else cur = next
  }
  if (cur) out.push(cur)
  return out
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) })
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })

  // 🚨 呼ぶ人の門（2026-09-22）。以前は Bearer が付いているかを見るだけで、
  //    誰が呼んでいるかを確かめていなかった。判定は DB の my_access_state() 1本
  //    （overtime-approve からは service_role で呼ばれるので、そちらは素通りする）
  const gate = await checkCaller(req)
  if (!gate.ok) return json({ error: gate.reason }, gate.status)

  try {
    const { report_id, report_ids, event_key } = await req.json()
    const isBatch = Array.isArray(report_ids)
    const ids: string[] = isBatch
      ? [...new Set((report_ids as unknown[]).filter((x): x is string => typeof x === 'string' && x !== ''))]
      : (typeof report_id === 'string' && report_id ? [report_id] : [])
    if (ids.length === 0 || !event_key) return json({ error: 'missing params' }, 400)
    if (ids.length > MAX_IDS) return json({ error: `一度に送れるのは${MAX_IDS}件までです` }, 400)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // 🚨 Slackは fail-closed（設定行が無ければ送らない）。
    //    プッシュ（push-dispatch）は「行が無い＝ON扱い」で逆なので混同しないこと。
    const { data: settingRow } = await supabase
      .from('notification_settings')
      .select('enabled, recipient')
      .eq('event_key', event_key)
      .eq('channel', 'slack')
      .maybeSingle()

    const setting = settingRow as { enabled: boolean; recipient: string | null } | null
    if (!setting?.enabled) return json({ ok: true, skipped: 'slack OFF' })

    let channels: string[] = []
    try { channels = JSON.parse(setting.recipient ?? '{}').channels ?? [] } catch { /* 未設定は送信先なし */ }
    if (channels.length === 0) return json({ ok: true, skipped: 'チャンネル未選択' })

    const { data: reportRows, error: readErr } = await supabase
      .from('overtime_reports')
      .select('id, applicant_id, work_date, application_types, location, late_situation, early_situation, segments:overtime_report_segments(phase, seg_no, start_min, end_min)')
      .in('id', ids)
    if (readErr) return json({ error: '申請を読めませんでした：' + readErr.message }, 500)
    const found = (reportRows ?? []) as Report[]
    if (found.length === 0) return json({ ok: true, skipped: 'not found' })

    // 🚨 まとめて呼べるのは本人の申請だけ。1人でも違えば1通も送らない（一部だけ流すと何が起きたか分からない）
    const applicantIds = [...new Set(found.map(r => r.applicant_id))]
    if (isBatch && gate.kind !== 'service' && applicantIds.some(a => a !== gate.userId)) {
      return json({ error: 'ご自身の申請だけをまとめて送れます' }, 403)
    }
    if (isBatch && applicantIds.length > 1) return json({ error: '対象者が1人ではありません' }, 400)

    // 🚨 打刻ズレ（残業ではなく打刻が遅れただけ）はSlackに流さない。
    //    経理の実務に使えないうえ、本人には「見張られている」としか読めない
    const reports = found
      .filter(r => !(r.application_types ?? []).includes('clock_only'))
      .sort((a, b) => a.work_date.localeCompare(b.work_date))
    if (reports.length === 0) return json({ ok: true, skipped: 'clock_only' })

    const { data: prof } = await supabase.from('profiles').select('name').eq('id', reports[0].applicant_id).maybeSingle()
    const applicantName = (prof as { name: string } | null)?.name ?? ''
    const head = HEAD_BY_EVENT[event_key] ?? '🕐 *残業・時間*'

    // 🚨 Slackはチーム・役職の絞り込みが効かない（チャンネルに入っている人全員に届く）。
    //    公開チャンネルに流れることもあるので、載せるのは Googleカレンダー相当
    //    （氏名・種別・日付・時間・勤務地）まで。理由（reason）と差分は載せない。
    let lines: string[]
    if (reports.length === 1) {
      const x = describe(reports[0])
      lines = [head, '', `*対象者：* ${applicantName}`, `*種別：* ${x.typeLabels}`, `*日付：* ${x.dateLabel}`]
      if (x.timeLine) lines.push(`*時間：* ${x.timeLine}`)
      if (x.location) lines.push(`*勤務地：* ${x.location}`)
    } else {
      // まとめの形（案A）：1日1行。項目の区切りは全角スペース
      lines = [`${head}（${reports.length}件）`, '', `*対象者：* ${applicantName}`]
      for (const r of reports) {
        const x = describe(r)
        lines.push('・' + [x.dateLabel, x.typeLabels, x.timeLine, x.location].filter(Boolean).join('　'))
      }
    }
    const text = lines.join('\n')
    const blocks = toSections(lines).map(t => ({ type: 'section', text: { type: 'mrkdwn', text: t } }))

    let sent = 0
    for (const ch of channels) {
      const url = Deno.env.get(SLACK_WEBHOOK_KEYS[ch] ?? '')
      if (!url) continue
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, blocks }),
      })
      if (res.ok) sent++
      else console.error('[send-overtime-slack] Slack送信失敗', ch, res.status, await res.text())
    }

    return json({ ok: true, sent, count: reports.length })
  } catch (e) {
    console.error('[send-overtime-slack] error:', e)
    return json({ error: String(e) }, 500)
  }
})
