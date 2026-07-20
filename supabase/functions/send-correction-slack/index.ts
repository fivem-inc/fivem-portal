import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

// 修正依頼のSlack通知。管理者チャンネル（＝休暇通知の経理/管理者と同じ想定）へ1通投げる。
// Secretsは既存のものを再利用：SLACK_WEBHOOK_ACCOUNTING（無ければ LEADER にフォールバック）。
const WEBHOOK_URL =
  Deno.env.get('SLACK_WEBHOOK_ACCOUNTING') ||
  Deno.env.get('SLACK_WEBHOOK_LEADER') || ''

const ALLOWED_ORIGINS = ['https://fivem-portal.vercel.app', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

const TYPE_LABEL: Record<string, string> = { leave: '休暇', shift: '勤務変更', overtime: '残業' };

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) })
  }
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401, headers: getCorsHeaders(req) });
  }

  try {
    const { targetType, requesterName, targetLabel, message, changesText } = await req.json()

    if (!WEBHOOK_URL) {
      return new Response(JSON.stringify({ success: true, skipped: true }), {
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" }, status: 200,
      });
    }

    const head = `📩 *【修正依頼 / ${TYPE_LABEL[targetType] ?? targetType}】*`
    const lines = [
      head,
      `*申請者：* ${requesterName ?? 'スタッフ'}`,
      targetLabel ? `*対象：* ${targetLabel}` : '',
      changesText ? `*希望：* ${changesText}` : '',
      message ? `*補足：* ${message}` : '',
    ].filter(Boolean)

    const payload = {
      text: `📩【修正依頼】${requesterName ?? 'スタッフ'}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
        { type: 'actions', elements: [
          { type: 'button', text: { type: 'plain_text', text: '修正依頼を確認' },
            url: 'https://fivem-portal.vercel.app', style: 'primary' },
        ] },
      ],
    }

    const response = await fetch(WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    if (!response.ok) {
      const t = await response.text()
      throw new Error(`Slack送信失敗: ${response.status} - ${t}`)
    }
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" }, status: 200,
    })
  } catch (error) {
    console.error('修正依頼Slack通知エラー:', error)
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    })
  }
})
