import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import JSZip from "https://esm.sh/jszip@3.10.1"

const ALLOWED_ORIGINS = ['https://fivem-portal.vercel.app', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'];
const MAX_PATHS = 100; // 一度に大量処理しないための上限

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

  // 一括ダウンロードは閲覧個別ダウンロード（receipt-signed-url）と同様に管理者のみ許可する
  const { data: profile } = await supabaseUser.from('profiles').select('role_title').eq('id', user.id).single();
  if (!profile || profile.role_title !== '管理者') {
    return new Response(JSON.stringify({ error: 'Forbidden: ダウンロードは管理者のみ可能です' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const { paths } = await req.json();
    if (!Array.isArray(paths) || paths.length === 0) {
      return new Response(JSON.stringify({ error: 'paths は必須です' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (paths.length > MAX_PATHS) {
      return new Response(JSON.stringify({ error: `一度にダウンロードできるのは${MAX_PATHS}件までです` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const zip = new JSZip();
    const downloadLogRows: { purchase_request_id: string | null; storage_path: string; downloaded_by: string }[] = [];
    let failedCount = 0;

    for (let i = 0; i < paths.length; i++) {
      const path: unknown = paths[i];
      if (typeof path !== 'string') { failedCount++; continue; }

      const { data: blob, error: downloadError } = await supabaseAdmin.storage.from('purchase-receipts').download(path);
      if (downloadError || !blob) { failedCount++; continue; }

      const originalName = path.split('/').pop() ?? `receipt_${i + 1}.jpg`;
      // 同名ファイル衝突を避けるため連番を先頭に付与する
      zip.file(`${String(i + 1).padStart(3, '0')}_${originalName}`, await blob.arrayBuffer());

      const requestId = path.split('/')[1] ?? null;
      downloadLogRows.push({ purchase_request_id: requestId, storage_path: path, downloaded_by: user.id });
    }

    if (downloadLogRows.length === 0) {
      return new Response(JSON.stringify({ error: '対象の画像を取得できませんでした' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (downloadLogRows.length > 0) {
      await supabaseAdmin.from('receipt_download_log').insert(downloadLogRows);
    }

    const zipBytes: Uint8Array = await zip.generateAsync({ type: 'uint8array' });

    return new Response(zipBytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="receipts.zip"',
        'X-Failed-Count': String(failedCount),
      },
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: '予期せぬエラー: ' + String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
})
