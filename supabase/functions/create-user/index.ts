import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const ALLOWED_ORIGINS = ['https://fivem-portal.vercel.app', 'http://localhost:5173', 'http://localhost:5174'];

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
    return new Response('ok', { headers: getCorsHeaders(req) })
  }

  const corsHeaders = getCorsHeaders(req);

  // Function内で認証チェック（プラットフォームのverify_jwtには頼らない）
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // ユーザーJWTでログイン確認
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

  // 管理者チェック（profiles テーブルの role_title）
  const { data: profile } = await supabaseUser
    .from('profiles')
    .select('role_title')
    .eq('id', user.id)
    .single();

  const adminRoles = ['admin', '管理者'];
  if (!profile || !adminRoles.includes(profile.role_title)) {
    return new Response(JSON.stringify({ error: 'Forbidden: 管理者のみ実行可能です' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const { email, password, name, employment_type, role_title } = await req.json();

    if (!email || !password) {
      return new Response(JSON.stringify({ error: 'email と password は必須です' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // マスターキーを使った管理者クライアント（サーバー側のみ）
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // 1. Supabase Auth にユーザー作成
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authError) {
      return new Response(JSON.stringify({ error: authError.message }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userId = authData.user?.id;
    if (!userId) {
      return new Response(JSON.stringify({ error: 'ユーザーIDの取得に失敗しました' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 2. 現在の最大 sort_order を取得して +1 をセット
    const { data: maxData } = await supabaseAdmin
      .from('profiles')
      .select('sort_order')
      .order('sort_order', { ascending: false })
      .limit(1)
      .single();
    const nextSortOrder = (maxData?.sort_order ?? 0) + 1;

    // 3. profiles テーブルに追加情報を登録
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .upsert({
        id: userId,
        email,
        name: name || '',
        employment_type: employment_type || '正社員',
        role_title: role_title || '一般',
        is_active: true,
        registered_at: new Date().toISOString(),
        sort_order: nextSortOrder,
      });

    if (profileError) {
      // Auth ユーザーは作れたが profiles 登録失敗 → Auth ユーザーも削除してロールバック
      await supabaseAdmin.auth.admin.deleteUser(userId);
      return new Response(JSON.stringify({ error: 'プロフィール登録に失敗しました: ' + profileError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true, userId }), {
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
