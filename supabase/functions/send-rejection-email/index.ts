import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { 
      headers: corsHeaders,
      status: 200
    })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { submissionId, reason } = await req.json()

    console.log('=== 却下メール送信開始 ===')
    console.log('申請ID:', submissionId)
    console.log('却下理由:', reason)

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
      console.error('申請情報取得エラー:', submissionError)
      throw submissionError
    }

    console.log('申請情報取得成功:', {
      申請者: submission.profiles.name,
      メール: submission.profiles.email,
      申請日: submission.created_at
    })

    // メール内容をコンソールに出力（実際のメール送信の代わり）
    const emailContent = {
      to: submission.profiles.email,
      subject: '交通費申請が却下されました',
      body: `
        こんにちは、${submission.profiles.name || 'ユーザー'}さん
        
        あなたの交通費申請が却下されました。
        
        申請日: ${new Date(submission.created_at).toLocaleDateString('ja-JP')}
        却下日: ${new Date().toLocaleDateString('ja-JP')}
        ${reason ? `却下理由: ${reason}` : ''}
        
        申請内容:
        ${submission.expenses_data.map((expense, i) => 
          `${i + 1}. ${expense.from_station} → ${expense.to_station}: ${expense.amount}円`
        ).join('\n')}
        
        詳細については管理者にお問い合わせください。
        
        ファイブM 交通費精算システム
      `
    }

    console.log('📧 メール内容:', emailContent)

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'メール送信完了（ログ出力）',
        email: submission.profiles.email,
        reason: reason,
        submissionId: submissionId
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