import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const ALLOWED_ORIGINS = ['https://fivem-portal.vercel.app', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'];

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
  overtime:   Deno.env.get('SLACK_WEBHOOK_OVERTIME') || '',
}

// 管理画面の通知設定（notification_settings）のイベントキー
// ※ accounting_approved は notification_settings に行が無い（社長へ固定のまま）
const EVENT_KEY_MAP: Record<string, string> = {
  new_request: 'leave:new_request',
  leader_approved: 'leave:leader_approved',
  manager_approved: 'leave:manager_approved',
  rejected: 'leave:rejected',
  cancelled: 'leave:cancelled',
}

// 見出し。「確認①②③」は社内フローを覚えていないと読めないので、誰が受理したかで書く。
// 他の通知（勤怠📅・勤務変更⏰・残業🕐）と同じ「カテゴリ｜状態」の形に揃える
const HEAD_BY_EVENT: Record<string, string> = {
  new_request: '🌿 *休暇｜申請*',
  leader_approved: '🌿 *休暇｜リーダー受理*',
  manager_approved: '🌿 *休暇｜マネージャー受理*',
  accounting_approved: '🌿 *休暇｜経理受理*',
  rejected: '🌿 *休暇｜差し戻し*',
  cancelled: '🌿 *休暇｜取消*',
}

// 管理画面で追加指定されたチャンネルを読む。
// 🚨 失敗しても既定の送信は止めない（DBが読めないだけで休暇の通知が消えてはいけない）
async function fetchExtraChannels(event: string): Promise<string[]> {
  const eventKey = EVENT_KEY_MAP[event]
  if (!eventKey) return []
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )
    const { data } = await supabase
      .from('notification_settings')
      .select('recipient')
      .eq('event_key', eventKey)
      .eq('channel', 'slack')
      .maybeSingle()
    const raw = (data as { recipient: string | null } | null)?.recipient
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.channels)) return []
    // 旧形式（"#休暇申請" のような未知の値）は無視する。今も送れていないので挙動は変わらない
    return (parsed.channels as string[]).filter(ch => WEBHOOKS[ch as keyof typeof WEBHOOKS] !== undefined)
  } catch {
    return []
  }
}

// ステップに応じた「既定の送信先チャンネル」を返す（承認フローの流れで自動的に決まる分）。
// 管理画面で選ばれたチャンネルは、これに「追加で」足す形にする（既存の飛び先は変えない）。
// event:
//   'new_request'       → 新規申請（申請先がリーダー or マネージャー）
//   'leader_approved'   → リーダー/一人目受理 → マネージャーへ
//   'manager_approved'  → マネージャー受理 → 経理へ
//   'accounting_approved' → 経理（管理者）受理 → 社長へ
function getFixedChannel(event: string, approverRole: string, targetChannel?: string): string | null {
  if (event === 'new_request') return approverRole === 'マネージャー' ? 'manager' : 'leader';
  if (event === 'leader_approved') return 'manager';
  if (event === 'manager_approved') return 'accounting';
  if (event === 'accounting_approved') return 'president';
  // 取消は今まで送っていなかったので、既定の飛び先を持たない。
  // ＝管理画面でチャンネルを選んだときだけ送られる（選ばなければ何も起きない）
  if (event === 'cancelled') return null;
  if (event === 'rejected') {
    // 差し戻しだけは以前から管理画面の選択を使っていた。
    // 旧形式（JSON文字列など既知のキー以外）が入っていたときは、従来どおり leader に落とす
    const ch = targetChannel as keyof typeof WEBHOOKS;
    return (ch && WEBHOOKS[ch] !== undefined) ? ch : 'leader';
  }
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
    // applicantName / leaveTypeName / dateSummary は受理済み（確定した休暇）のときだけ本文に出す
    const {
      event, approverName, approverRole, nextApproverName, nextApproverRole, targetChannel,
      applicantName, leaveTypeName, dateSummary,
    } = await req.json()

    if (!HEAD_BY_EVENT[event]) {
      return new Response(JSON.stringify({ error: 'invalid event' }), {
        status: 400,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      })
    }
    // 既定の飛び先 ＋ 管理画面で選ばれたチャンネル（重複は除く）。
    // 取消は既定の飛び先が無いので、チャンネルを選んでいなければ何も送らない
    const fixedChannel = getFixedChannel(event, approverRole || '', targetChannel)
    const extraChannels = await fetchExtraChannels(event)
    const targetChannels = [...new Set([fixedChannel, ...extraChannels].filter(Boolean) as string[])]
    if (targetChannels.length === 0) {
      return new Response(JSON.stringify({ ok: true, skipped: 'チャンネル未選択' }), {
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      })
    }

    const appUrl = 'https://fivem-portal.vercel.app/leave-approvals'
    // 受理済み（＝休暇が確定した段階）だけ、誰のいつの休暇かを載せる。
    // 受理待ちの段階は今までどおり中身を増やさない（ユーザー判断・2026-08-25）。
    // 🚨 載せるのは Googleカレンダー相当（氏名・種別・日付）まで。事由・理由は載せない
    // 取消は「受理まで進んだ休暇が無くなった」お知らせなので、誰のいつの分かを必ず出す
    const showDetail = event === 'manager_approved' || event === 'accounting_approved' || event === 'cancelled'
    const addButton = event === 'manager_approved' || event === 'accounting_approved'

    const lines: string[] = [HEAD_BY_EVENT[event] ?? '🌿 *休暇*', '']
    if (showDetail) {
      if (applicantName) lines.push(`*対象者：* ${applicantName}`)
      if (leaveTypeName) lines.push(`*種別：* ${leaveTypeName}`)
      if (dateSummary) lines.push(`*日付：* ${dateSummary}`)
    }
    if (event === 'new_request') {
      lines.push(`*申請先：* ${approverName}（${approverRole}）`)
    } else if (event === 'leader_approved') {
      lines.push(nextApproverName ? `*確認先：* ${nextApproverName}（${nextApproverRole || 'マネージャー'}）` : '*確認先：* マネージャー')
      lines.push(`*受理者：* ${approverName}（${approverRole}）`)
    } else if (event === 'manager_approved') {
      lines.push(`*受理者：* ${approverName}（${approverRole}）`)
    } else if (event === 'accounting_approved') {
      lines.push('*受理者：* 経理')
    } else if (event === 'rejected') {
      lines.push(`*差し戻し：* ${approverName}（${approverRole}）`)
    } else if (event === 'cancelled') {
      // 取消の理由は本人へのベル通知・メールで伝える。公開チャンネルには載せない
      lines.push(`*取消：* ${approverName}（${approverRole}）`)
    }
    const text = lines.join('\n')

    const blocks: unknown[] = [
      { type: 'section', text: { type: 'mrkdwn', text } },
    ]
    if (addButton) {
      blocks.push({
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: '申請を確認する' },
          url: appUrl,
          style: 'primary',
        }],
      })
    }

    const payload = { text, blocks }

    // 1つでも送れたら成功扱い（Webhook未登録のチャンネルは黙って飛ばす）
    let sent = 0
    let lastError = ''
    for (const ch of targetChannels) {
      const url = WEBHOOKS[ch as keyof typeof WEBHOOKS]
      if (!url) continue
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (response.ok) sent++
      else {
        lastError = `${ch}: ${response.status} - ${await response.text()}`
        console.error('[send-leave-slack] Slack送信失敗', lastError)
      }
    }
    if (sent === 0 && lastError) {
      throw new Error(`Slack送信失敗: ${lastError}`)
    }

    return new Response(JSON.stringify({ success: true, sent }), {
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
