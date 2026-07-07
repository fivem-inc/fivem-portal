import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const ALLOWED_ORIGINS = ['https://fivem-portal.vercel.app', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'];
const VIEW_ROLES = ['管理者', '社長', 'マネージャー'];
const SIGNED_URL_EXPIRES_SECONDS = 300; // 5分。表示のたびに都度発行する使い切りURL（ダウンロード保存目的ではない）

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
    return new Response('ok', { headers: getCorsHeaders(req) });
  }

  const corsHeaders = getCorsHeaders(req);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUser = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
  if (userError || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const { path } = await req.json();
    if (!path || typeof path !== 'string') {
      return new Response(JSON.stringify({ error: 'path は必須です' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // パス規約は {user_id}/{request_id}/{timestamp}_receipt.jpg。
    // 本人の写真ならStorage RLS（select_own）で見られるため、ここでは
    // 「本人以外が見たい場合はマネージャー以上のロールが必要」という追加チェックのみ行う
    const ownerId = path.split('/')[0];
    const isOwner = ownerId === user.id;

    if (!isOwner) {
      const { data: profile } = await supabaseUser
        .from('profiles')
        .select('role_title')
        .eq('id', user.id)
        .single();

      if (!profile || !VIEW_ROLES.includes(profile.role_title)) {
        return new Response(JSON.stringify({ error: 'Forbidden: 閲覧権限がありません' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const { data, error } = await supabaseAdmin.storage
      .from('purchase-receipts')
      .createSignedUrl(path, SIGNED_URL_EXPIRES_SECONDS);

    if (error || !data) {
      return new Response(JSON.stringify({ error: error?.message ?? 'URL発行に失敗しました' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ signedUrl: data.signedUrl }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: '予期せぬエラー: ' + String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
})
