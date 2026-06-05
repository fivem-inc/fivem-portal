import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const ALLOWED_ORIGIN = 'https://fivem-portal.vercel.app';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
    return new Response('ok', { headers: corsHeaders })
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders });
  }

  try {
    const { event, approverName, approverRole } = await req.json()

    const webhookUrl = getWebhookUrl(event, approverRole || '')
    if (!webhookUrl) {
      return new Response(JSON.stringify({ error: 'invalid event' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    let text = ''
    const appUrl = 'https://fivem-portal.vercel.app/leave-approvals'

    if (event === 'new_request') {
      text = `【休暇申請】新しい申請が届いています\n申請先: ${approverName}（${approverRole}）`
    } else if (event === 'leader_approved') {
      text = `【休暇申請】確認が必要な申請があります\n受理者: ${approverName}（${approverRole}）が受理しました`
    } else if (event === 'manager_approved') {
      text = `【休暇申請】確認が必要な申請があります\n受理者: ${approverName}（${approverRole}）が受理しました\n▶ 承認画面: ${appUrl}`
    } else if (event === 'accounting_approved') {
      text = `【休暇申請】確認が必要な申請があります\n受理者: 経理担当者が受理しました\n▶ 承認画面: ${appUrl}`
    }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Slack送信失敗: ${response.status} - ${errText}`)
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('send-leave-slack error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
