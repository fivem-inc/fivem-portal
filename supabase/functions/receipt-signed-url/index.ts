import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const ALLOWED_ORIGINS = ['https://fivem-portal.vercel.app', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'];
// 🚨 役職名の配列（旧 VIEW_ROLES / QUOTE_VIEW_ROLES）は持たない（2026-09-10 段4）。
//    レシートの閲覧・ダウンロード＝経理（立場 accounting）／
//    見積書の閲覧のみ＝リーダー以上（属性 is_leader_plus。経費精算レシートより機微度が低く、承認者が判断のために見る）
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
    const { path, download } = await req.json();
    if (!path || typeof path !== 'string') {
      return new Response(JSON.stringify({ error: 'path は必須です' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // パス規約は {user_id}/{request_id}/{timestamp}_receipt.jpg（見積書は {user_id}/{request_id}-{item}-{quote}/{timestamp}_quote.ext）。
    // 閲覧（download=false）は本人または管理者、ダウンロード保存は本人であっても管理者のみ許可する
    // ただし見積書ファイルの閲覧のみ、承認者ロール（リーダー/マネージャー/社長）にも開放する
    const ownerId = path.split('/')[0];
    const isOwner = ownerId === user.id;
    const isQuoteFile = path.includes('_quote.');

    const needsRoleCheck = download ? true : !isOwner;
    if (needsRoleCheck) {
      const allowed = (!download && isQuoteFile)
        ? (await supabaseUser.rpc('role_is_leader_plus', { p_uid: user.id })).data === true
        : (await supabaseUser.rpc('role_acts_as', { p_uid: user.id })).data === 'accounting';
      if (!allowed) {
        return new Response(JSON.stringify({ error: download ? 'Forbidden: ダウンロードは管理者のみ可能です' : 'Forbidden: 閲覧権限がありません' }), {
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
      .createSignedUrl(path, SIGNED_URL_EXPIRES_SECONDS, download ? { download: true } : undefined);

    if (error || !data) {
      return new Response(JSON.stringify({ error: error?.message ?? 'URL発行に失敗しました' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let logError: string | null = null;
    if (download) {
      // パス規約 {user_id}/{request_id}/{timestamp}_receipt.jpg から申請IDを取り出して記録する
      const requestId = path.split('/')[1] ?? null;
      const { error: insertError } = await supabaseAdmin.from('receipt_download_log').insert({
        purchase_request_id: requestId,
        storage_path: path,
        downloaded_by: user.id,
      });
      if (insertError) {
        console.error('receipt_download_log insert failed:', insertError.message, { path, requestId, userId: user.id });
        logError = insertError.message;
      }
    }

    return new Response(JSON.stringify({ signedUrl: data.signedUrl, logError }), {
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
