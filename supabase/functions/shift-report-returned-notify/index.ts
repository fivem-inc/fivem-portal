// 勤務変更報告「差し戻し時」のSlack通知
//
// サイト通知（ベル）・プッシュ・メールはクライアント側（notifyShiftReportReturned）で送る。
// SlackだけはWebhook URLがサーバー側の秘密のため、この関数を経由する。
// 送信先チャンネルと文面は管理画面「通知設定」の shift_report:returned / slack から読む。
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401, headers: getCorsHeaders(req) })
  }

  try {
    const { applicant_name, type_labels, date_label, reason } = await req.json()

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const { data: settingRow } = await supabase
      .from('notification_settings')
      .select('enabled, recipient, template')
      .eq('event_key', 'shift_report:returned')
      .eq('channel', 'slack')
      .maybeSingle()

    const setting = settingRow as { enabled: boolean; recipient: string | null; template: string | null } | null
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

    const vars: Record<string, string> = {
      '申請者名': applicant_name ?? '',
      '種別': type_labels ?? '',
      '日付': date_label ?? '',
      '差し戻し理由': reason ? String(reason) : '（記載なし）',
      'リンク': 'https://fivem-portal.vercel.app/shift-report?tab=history',
    }
    // 🚨 Slackの本文はコード側で固定する（管理画面のSlack欄に本文の入力UIが無いのに
    //    DBのテンプレートが優先される作りで、文言を直しても画面から追えなかったため）。
    //    見出しは他の通知（勤怠・残業・休暇）と揃えて「カテゴリ｜状態」の形にする。
    //    差し戻しは理由が本体なので理由は残す。
    const textLines = [
      '⏰ *勤務変更｜差し戻し*',
      '',
      `*対象者：* ${vars['申請者名']}`,
      `*種別：* ${vars['種別']}`,
      `*日付：* ${vars['日付']}`,
      `*理由：* ${vars['差し戻し理由']}`,
    ]
    const text = textLines.join('\n')

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
      else console.error('[shift-report-returned-notify] Slack送信失敗', ch, res.status, await res.text())
    }

    return new Response(JSON.stringify({ ok: true, sent }), {
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error('[shift-report-returned-notify] error:', e)
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    })
  }
})
