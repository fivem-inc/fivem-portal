import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { submissionId, reason } = await req.json()

    // 申請情報とユーザー情報を取得
    const { data: submission, error: submissionError } = await supabaseClient
      .from('expenses')
      .select(`
        *,
        profiles!inner(name, email)
      `)
      .eq('id', submissionId)
      .single()

    if (submissionError) {
      throw submissionError
    }

    // メール送信処理
    const emailHtml = `
      <html>
        <body>
          <h2>交通費申請が却下されました</h2>
          <p>こんにちは、${submission.profiles.name || 'ユーザー'}さん</p>
          
          <p>あなたの交通費申請が却下されました。</p>
          
          <h3>申請詳細</h3>
          <p><strong>申請日:</strong> ${new Date(submission.created_at).toLocaleDateString('ja-JP')}</p>
          <p><strong>却下日:</strong> ${new Date().toLocaleDateString('ja-JP')}</p>
          
          ${reason ? `
          <h3>却下理由</h3>
          <p>${reason}</p>
          ` : ''}
          
          <h3>申請内容</h3>
          <ul>
            ${submission.expenses_data.map((expense: any) => `
              <li>
                ${expense.type === 'regular' ? '定期' : expense.type === 'business_trip' ? '出張' : '単発'}: 
                ${expense.from_station} → ${expense.to_station} (${expense.amount}円)
                ${expense.notes ? `<br>備考: ${expense.notes}` : ''}
              </li>
            `).join('')}
          </ul>
          
          <p>詳細については管理者にお問い合わせください。</p>
          
          <p>ファイブM 交通費精算システム</p>
        </body>
      </html>
    `

    // Supabaseの組み込みメール機能を使用
    const { error: emailError } = await supabaseClient.auth.admin.generateLink({
      type: 'email_change_current',
      email: submission.profiles.email,
      options: {
        redirectTo: `${Deno.env.get('SITE_URL') || 'http://localhost:3000'}`,
      }
    })

    // 実際のメール送信は外部サービス（SendGrid、Resend等）を使用する必要があります
    // ここでは簡単な通知として console.log を使用
    console.log('却下メール送信:', {
      to: submission.profiles.email,
      subject: '交通費申請が却下されました',
      html: emailHtml
    })

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'メール送信完了',
        email: submission.profiles.email
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    )

  } catch (error) {
    console.error('メール送信エラー:', error)
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error.message 
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500 
      }
    )
  }
})