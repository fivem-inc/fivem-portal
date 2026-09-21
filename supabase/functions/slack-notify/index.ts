import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { checkCaller } from '../_shared/callerGate.ts'

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

  // 🚨 呼ぶ人の門（2026-09-22・3段目）。判定は DB の my_access_state() 1本。
  //    以前は Bearer が付いているかを見るだけだったので、ログインできる人なら誰でも
  //    受け取った本文の名前をそのまま Slack に流せた。
  //    🚨 呼び出し元は交通費の申請画面1か所だけ（実測）。退職者も交通費は出せるので retiree_grace も通す
  const gate = await checkCaller(req);
  if (!gate.ok) {
    return new Response(JSON.stringify({ error: gate.reason }), {
      status: gate.status,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });
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
    // 🚨 catch で受けたものは Error とは限らないので、そのまま .message を読まない
    //    Error 以外が投げられると .message は undefined になり、JSON から欄ごと消えて
    //    **理由が分からなくなる**（null や undefined が投げられたときは、この行自体で落ちる）。
    const detail = error instanceof Error ? error.message : String(error)
    console.error('Slack通知エラー:', error) // 🚨 log には元のまま渡す（スタックが残る）
    return new Response(JSON.stringify({ error: detail }), {
      status: 500,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" }
    })
  }
})