import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// 🚨 本番URLだけを許可していたため、ローカル（開発サーバー）から新規登録すると
//    ブラウザにブロックされてIP・国が記録されなかった。他のEdge Functionと同じ方式に揃える。
const ALLOWED_ORIGINS = ['https://fivem-portal.vercel.app', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'];

// 地域の判定は MaxMind GeoLite2 の問い合わせ窓口を使う（2026-09-21 差し替え）。
// 🚨 以前は ip-api.com を使っていたが、あちらの無料枠は「非商用のみ」で、
//    このシステムは商用なので使ってはいけなかった。
// 🚨 GeoLite2 は無料・商用可だが **1日1,000件まで**。新規登録は年に数件なので十分足りる。
// 🚨 鍵は Supabase の Secrets に置く（コードにもリポジトリにも書かない）。
//    MAXMIND_ACCOUNT_ID … アカウントの番号（利用者名にあたる）
//    MAXMIND_LICENSE_KEY … ライセンスキー（パスワードにあたる）
async function lookupGeo(ip: string): Promise<{ country: string | null; city: string | null }> {
  const accountId = Deno.env.get('MAXMIND_ACCOUNT_ID');
  const licenseKey = Deno.env.get('MAXMIND_LICENSE_KEY');
  // 🚨 鍵が無いときは黙って「不明」にせず、記録に残す（気づけないまま国が空になるのを防ぐ）
  if (!accountId || !licenseKey) {
    console.error('record-signup-ip: MaxMind の鍵（MAXMIND_ACCOUNT_ID / MAXMIND_LICENSE_KEY）が設定されていません');
    return { country: null, city: null };
  }
  const res = await fetch(`https://geolite.info/geoip/v2.1/city/${encodeURIComponent(ip)}`, {
    headers: {
      Authorization: `Basic ${btoa(`${accountId}:${licenseKey}`)}`,
      Accept: 'application/json',
    },
    // 新規登録の途中で呼ぶので、応答が無いときに待ち続けない
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    // 🚨 理由をそのまま残す（IP_ADDRESS_RESERVED＝社内IPなど／AUTHORIZATION_INVALID＝鍵違い／
    //    OUT_OF_QUERIES＝1日の上限。原因が分からないと直しようがない）。鍵の値は出さない
    console.error('record-signup-ip geo lookup failed:', res.status, (await res.text()).slice(0, 200));
    return { country: null, city: null };
  }
  const geo = await res.json();
  // 🚨 英語の名前を使う。既存の記録が Japan / Kyoto と英語で入っているので、混ぜない
  return {
    country: geo?.country?.names?.en ?? null,
    city: geo?.city?.names?.en ?? null,
  };
}

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
        // 🚨 地域が引けなくても、IPの記録は必ず残す（ここで失敗しても先へ進む）
        ({ country, city } = await lookupGeo(ip));
      } catch (geoError) {
        console.error('record-signup-ip geo lookup error:', geoError);
      }
    }

    await supabase
      .from('profiles')
      .update({ signup_ip: ip, signup_country: country, signup_city: city })
      .eq('id', user_id);

    // 🚨 geo は「地域が引けたか」。鍵が間違っていても IP の記録自体は成功するので、
    //    これが無いと「ずっと国が空のまま」に誰も気づけない（呼び出し側は使っていないが、
    //    動いているかを確かめる唯一の手がかりになる）
    return new Response(JSON.stringify({ success: true, geo: country ? 'ok' : 'unknown' }), {
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
