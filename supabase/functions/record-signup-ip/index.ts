import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// 🚨 本番URLだけを許可していたため、ローカル（開発サーバー）から新規登録すると
//    ブラウザにブロックされてIP・国が記録されなかった。他のEdge Functionと同じ方式に揃える。
const ALLOWED_ORIGINS = ['https://fivem-portal.vercel.app', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : 'null';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const { user_id } = await req.json();
    if (!user_id) {
      return new Response(JSON.stringify({ error: 'user_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // x-forwarded-for は「クライアント, プロキシ1, プロキシ2, ...」の順で並ぶため先頭が接続元IP
    const forwardedFor = req.headers.get('x-forwarded-for') || '';
    const ip = forwardedFor.split(',')[0].trim() || null;

    let country: string | null = null;
    let city: string | null = null;
    if (ip) {
      try {
        const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,city`);
        const geo = await geoRes.json();
        if (geo.status === 'success') {
          country = geo.country || null;
          city = geo.city || null;
        }
      } catch (geoError) {
        console.error('record-signup-ip geo lookup error:', geoError);
      }
    }

    await supabase
      .from('profiles')
      .update({ signup_ip: ip, signup_country: country, signup_city: city })
      .eq('id', user_id);

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('record-signup-ip error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
