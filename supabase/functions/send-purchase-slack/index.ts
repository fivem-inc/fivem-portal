import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const ALLOWED_ORIGINS = ['https://fivem-portal.vercel.app', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

// チャンネルごとのWebhook URL（Supabase Edge Function Secretsに設定、既存の休暇申請用と共通のものを流用）
const WEBHOOKS: Record<string, string> = {
  leader:     Deno.env.get('SLACK_WEBHOOK_LEADER') || '',
  manager:    Deno.env.get('SLACK_WEBHOOK_MANAGER') || '',
  accounting: Deno.env.get('SLACK_WEBHOOK_ACCOUNTING') || '',
  president:  Deno.env.get('SLACK_WEBHOOK_PRESIDENT') || '',
}

type PurchaseSlackEvent = 'submitted' | 'approved' | 'returned' | 'board_all_approved';
type Route = 'leader' | 'manager' | 'board' | 'self_judgment';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) })
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401, headers: getCorsHeaders(req) });
  }

  try {
    const { event, route, channels, applicantName, itemName, amount, returnedReason } = await req.json() as {
      event: PurchaseSlackEvent;
      route?: Route;
      channels: string[];
      applicantName: string;
      itemName: string;
      amount: number;
      returnedReason?: string;
    };

    const webhookUrls = (channels ?? [])
      .map(ch => WEBHOOKS[ch])
      .filter((url): url is string => !!url);

    if (webhookUrls.length === 0) {
      return new Response(JSON.stringify({ error: 'no valid channels' }), {
        status: 400,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      })
    }

    const amountText = typeof amount === 'number' ? amount.toLocaleString() : String(amount ?? '');
    let text = ''

    if (event === 'submitted') {
      text = `🔔 *【備品購入申請 / 新規】*\n*申請者：* ${applicantName}\n*品目：* ${itemName}（¥${amountText}）`
    } else if (event === 'approved') {
      text = `✅ *【備品購入申請 / 承認】*\n*申請者：* ${applicantName}\n*品目：* ${itemName}（¥${amountText}）が承認されました`
    } else if (event === 'board_all_approved') {
      text = `✅ *【備品購入申請 / 全員承認】*\n*申請者：* ${applicantName}\n*品目：* ${itemName}（¥${amountText}）が全員承認され、確定しました`
    } else if (event === 'returned') {
      text = `🔴 *【備品購入申請 / 差し戻し】*\n*申請者：* ${applicantName}\n*品目：* ${itemName}（¥${amountText}）${returnedReason ? `\n*理由：* ${returnedReason}` : ''}`
    }

    const blocks: unknown[] = [
      { type: 'section', text: { type: 'mrkdwn', text } },
    ]

    const payload = { text, blocks }

    const results = await Promise.all(webhookUrls.map(async webhookUrl => {
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!response.ok) {
          const errText = await response.text()
          console.error(`Slack送信失敗: ${response.status} - ${errText}`)
          return false
        }
        return true
      } catch (e) {
        console.error('Slack送信失敗:', e)
        return false
      }
    }))

    if (!results.some(Boolean)) {
      throw new Error('すべてのSlack送信に失敗しました')
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('send-purchase-slack error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    })
  }
})
