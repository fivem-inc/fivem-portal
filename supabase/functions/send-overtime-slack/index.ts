// 残業・時間管理のSlack通知
//
// サイト通知（ベル）・プッシュ・メールは別の場所で送っている。
// SlackだけはWebhook URLがサーバー側の秘密のため、この関数を経由する。
//
// 🚨 呼び出し元が5箇所（申請・自己受理・事前受理・受理・取消・管理者取消）あるので、
//    本文の材料を引数で配らず report_id だけ受け取ってサーバー側で組み立てる。
//    引数で配ると、あとから項目を足したとき必ずどこかで渡し忘れる（このリポジトリの定番事故）。
//
// 送信先チャンネルと ON/OFF は管理画面「通知設定」の overtime:* / slack から読む。
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

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

/** 分 → "9:05"（先頭0なし。Googleカレンダー・勤怠通知と同じ書式） */
function minToTime(min: number): string {
  const h = Math.floor(min / 60), m = min % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

const DOW = ['日', '月', '火', '水', '木', '金', '土']

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401, headers: getCorsHeaders(req) })
  }

  try {
    const { report_id, event_key } = await req.json()
    if (!report_id || !event_key) {
      return new Response(JSON.stringify({ error: 'missing params' }), {
        status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      })
    }

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
    if (!setting?.enabled) {
      return new Response(JSON.stringify({ ok: true, skipped: 'slack OFF' }), {
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      })
    }

    let channels: string[] = []
    try { channels = JSON.parse(setting.recipient ?? '{}').channels ?? [] } catch { /* 未設定は送信先なし */ }
    if (channels.length === 0) {
      return new Response(JSON.stringify({ ok: true, skipped: 'チャンネル未選択' }), {
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      })
    }

    const { data: reportRow } = await supabase
      .from('overtime_reports')
      .select('id, applicant_id, work_date, application_types, location, segments:overtime_report_segments(phase, seg_no, start_min, end_min)')
      .eq('id', report_id)
      .maybeSingle()
    const report = reportRow as {
      applicant_id: string
      work_date: string
      application_types: string[] | null
      location: string | null
      segments: { phase: string; seg_no: number; start_min: number; end_min: number }[] | null
    } | null
    if (!report) {
      return new Response(JSON.stringify({ ok: true, skipped: 'not found' }), {
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      })
    }

    const types: string[] = report.application_types ?? []
    // 🚨 打刻ズレ（残業ではなく打刻が遅れただけ）はSlackに流さない。
    //    経理の実務に使えないうえ、本人には「見張られている」としか読めない
    if (types.includes('clock_only')) {
      return new Response(JSON.stringify({ ok: true, skipped: 'clock_only' }), {
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      })
    }

    const { data: prof } = await supabase.from('profiles').select('name').eq('id', report.applicant_id).maybeSingle()
    const applicantName = (prof as { name: string } | null)?.name ?? ''

    const typeLabels = types.map(t => TYPE_LABEL[t] ?? t).join('・')
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

    // 🚨 Slackはチーム・役職の絞り込みが効かない（チャンネルに入っている人全員に届く）。
    //    公開チャンネルに流れることもあるので、載せるのは Googleカレンダー相当
    //    （氏名・種別・日付・時間・勤務地）まで。理由（reason）と差分は載せない。
    const lines = [
      HEAD_BY_EVENT[event_key] ?? '🕐 *残業・時間*',
      '',
      `*対象者：* ${applicantName}`,
      `*種別：* ${typeLabels}`,
      `*日付：* ${dateLabel}`,
    ]
    if (timeLine) lines.push(`*時間：* ${timeLine}`)
    if (!isFullDay && report.location) lines.push(`*勤務地：* ${report.location}`)
    const text = lines.join('\n')

    let sent = 0
    for (const ch of channels) {
      const url = Deno.env.get(SLACK_WEBHOOK_KEYS[ch] ?? '')
      if (!url) continue
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }),
      })
      if (res.ok) sent++
      else console.error('[send-overtime-slack] Slack送信失敗', ch, res.status, await res.text())
    }

    return new Response(JSON.stringify({ ok: true, sent }), {
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error('[send-overtime-slack] error:', e)
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    })
  }
})
