import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const ALLOWED_ORIGINS = ['https://fivem-portal.vercel.app', 'http://localhost:5173', 'http://localhost:5174'];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

// チャンネルごとのWebhook URL（Supabase Edge Function Secretsに設定）
const WEBHOOKS = {
  leader:     Deno.env.get('SLACK_WEBHOOK_LEADER') || '',
  manager:    Deno.env.get('SLACK_WEBHOOK_MANAGER') || '',
  accounting: Deno.env.get('SLACK_WEBHOOK_ACCOUNTING') || '',
  president:  Deno.env.get('SLACK_WEBHOOK_PRESIDENT') || '',
}

// ステップに応じた送信先を返す
// event:
//   'new_request'       → 新規申請（申請先がリーダー or マネージャー）
//   'leader_approved'   → リーダー/一人目受理 → マネージャーへ
//   'manager_approved'  → マネージャー受理 → 経理へ
//   'accounting_approved' → 経理（管理者）受理 → 社長へ
function getWebhookUrl(event: string, approverRole: string): string | null {
  if (event === 'new_request') {
    if (approverRole === 'マネージャー') return WEBHOOKS.manager;
    return WEBHOOKS.leader; // リーダーまたはその他
  }
  if (event === 'leader_approved') return WEBHOOKS.manager;
  if (event === 'manager_approved') return WEBHOOKS.accounting;
  if (event === 'accounting_approved') return WEBHOOKS.president;
  return null;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) })
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401, headers: getCorsHeaders(req) });
  }

  try {
    const { event, approverName, approverRole, nextApproverName, nextApproverRole } = await req.json()

    const webhookUrl = getWebhookUrl(event, approverRole || '')
    if (!webhookUrl) {
      return new Response(JSON.stringify({ error: 'invalid event' }), {
        status: 400,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      })
    }

    let text = ''

    const appUrl = 'https://fivem-portal.vercel.app/leave-approvals'
    let addButton = false

    if (event === 'new_request') {
      text = `🔔 *【休暇申請 / 新規】*\n*申請先：* ${approverName}（${approverRole}）`
    } else if (event === 'leader_approved') {
      const nextLine = nextApproverName ? `*確認先：* ${nextApproverName}（${nextApproverRole || 'マネージャー'}）` : '*確認先：* マネージャー'
      text = `✅ *【休暇申請 / 確認①】*\n${nextLine}\n*受理者：* ${approverName}（${approverRole}）`
    } else if (event === 'manager_approved') {
      text = `✅ *【休暇申請 / 確認②】*\n*受理者：* ${approverName}（${approverRole}）`
      addButton = true
    } else if (event === 'accounting_approved') {
      text = `✅ *【休暇申請 / 確認③】*\n*受理者：* 経理`
      addButton = true
    }

    const blocks: unknown[] = [
      { type: 'section', text: { type: 'mrkdwn', text } },
    ]
    if (addButton) {
      blocks.push({
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: '申請を確認・承認' },
          url: appUrl,
          style: 'primary',
        }],
      })
    }

    const payload = { text, blocks }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Slack送信失敗: ${response.status} - ${errText}`)
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('send-leave-slack error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    })
  }
})
