import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

// Slack Webhook URL
const SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/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"

const ALLOWED_ORIGINS = ['https://fivem-portal.vercel.app', 'http://localhost:5173', 'http://localhost:5174'];

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
    
    // 申請項目の詳細を作成
    const expenseDetails = expense.items.map((item: any, index: number) => {
      const typeText = item.type === 'regular' ? '⭐定期⭐' : item.type === 'business_trip' ? '出張' : '単発'
      const dateText = item.type === 'regular' 
        ? `${item.start_date || '未設定'} ~ ${item.end_date || '未設定'}`
        : `${item.start_date || '未設定'}`
      
      return `${index + 1}. *${typeText}* (${dateText})\n   ${item.from_station} → ${item.to_station}: *${item.amount}円*${item.notes ? `\n   備考: ${item.notes}` : ''}`
    }).join('\n\n')
    
    // Slackに送るメッセージを作成
    const message = {
      text: `💰 新しい交通費申請がありました！`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "💰 新しい交通費申請"
          }
        },
        {
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `*申請者:*\n${expense.user_name}`
            },
            {
              type: "mrkdwn",
              text: `*申請日:*\n${expense.date}`
            },
            {
              type: "mrkdwn",
              text: `*合計金額:*\n¥${expense.total_amount.toLocaleString()}`
            },
            {
              type: "mrkdwn",
              text: `*項目数:*\n${expense.items_count}件`
            }
          ]
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*申請内容:*\n${expenseDetails}`
          }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "📋 申請を確認・承認"
              },
              url: `${Deno.env.get('APP_URL') || 'http://localhost:5173'}/`,
              style: "primary"
            }
          ]
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "交通費精算システムからの自動通知"
            }
          ]
        }
      ]
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