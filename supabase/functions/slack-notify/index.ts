import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

// Slack Webhook URL（Supabase Secretsから取得）
const SLACK_WEBHOOK_URL = Deno.env.get('SLACK_WEBHOOK_EXPENSE') || ''

const ALLOWED_ORIGINS = ['https://fivem-portal.vercel.app', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
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
    // 申請データを受け取る
    const { expense } = await req.json()

    // 申請内容（種別リスト）を作成
    const typeList = expense.items.map((item: any) => {
      if (item.type === 'regular') return '⭐定期⭐'
      if (item.type === 'business_trip') return '出張'
      return '単発'
    }).join('、')

    const message = {
      text: `🆕【新しい交通費申請】${expense.user_name}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🆕 *【新しい交通費申請】*\n\n*申請者:* ${expense.user_name}\n*申請日:* ${expense.date}\n*申請内容:* ${typeList}\n*項目数:* ${expense.items_count}件`
          }
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '申請を確認・承認' },
              url: 'https://fivem-portal.vercel.app',
              style: 'primary'
            }
          ]
        }
      ]
    }
    
    if (!SLACK_WEBHOOK_URL) {
      console.warn('SLACK_WEBHOOK_EXPENSE が設定されていません');
      return new Response(JSON.stringify({ success: true, skipped: true }), {
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
        status: 200
      });
    }

    // Slackに送信
    const response = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message)
    })
    
    if (response.ok) {
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
        status: 200
      })
    } else {
      const errorText = await response.text()
      throw new Error(`Slack送信失敗: ${response.status} - ${errorText}`)
    }
    
  } catch (error) {
    console.error('Slack通知エラー:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" }
    })
  }
})