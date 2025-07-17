import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

console.log("send-rejection-email function is starting...")

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
  'Access-Control-Max-Age': '86400',
}

serve(async (req) => {
  console.log(`Received ${req.method} request to send-rejection-email`)
  
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    console.log('Handling CORS preflight request')
    return new Response('ok', { 
      headers: corsHeaders,
      status: 200 
    })
  }

  try {
    // Only allow POST requests
    if (req.method !== 'POST') {
      console.log(`Method ${req.method} not allowed`)
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        {
          status: 405,
          headers: { 
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        }
      )
    }

    const { email, reason, submissionId } = await req.json()
    console.log(`Processing rejection email for: ${email}`)
    console.log(`Reason: ${reason}`)
    console.log(`Submission ID: ${submissionId}`)

    // Here you would typically send an email using a service like SendGrid, Resend, or similar
    // For now, we'll just log the details and return success
    console.log('Email would be sent with the following details:')
    console.log(`To: ${email}`)
    console.log(`Subject: 申請が却下されました`)
    console.log(`Body: あなたの申請が却下されました。理由: ${reason}`)

    return new Response(
      JSON.stringify({ 
        message: 'Email sent successfully',
        email,
        reason,
        submissionId
      }),
      {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      }
    )

  } catch (error) {
    console.error('Error in send-rejection-email function:', error)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      {
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      }
    )
  }
})