import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const ALLOWED_ORIGINS = ['https://fivem-portal.vercel.app', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'];

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

  // 🚨 システム管理者（app_metadata.role = 'admin'）だけ（2026-09-09 ユーザー決定 Q5=B）。
  //    以前は役職名「管理者」でも許していたが、ユーザーの作成・削除は役職ではなくシステムの管理権限の話
  if ((user.app_metadata as { role?: string } | null)?.role !== 'admin') {
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

    // 0. 作る直前に控えに書く（handle_new_user がこれを見て、経理への「新規登録」の通知を止める・2026-10-04）
    //    🚨 app_metadata の印だけでは止まらない（作った瞬間にはまだ入っていない）
    const markEmail = String(email).trim().toLowerCase();
    const { error: markErr } = await supabaseAdmin.from('admin_provisioning_emails').upsert({ email: markEmail });
    if (markErr) {
      return new Response(JSON.stringify({ error: '準備に失敗しました: ' + markErr.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 1. Supabase Auth にユーザー作成
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      // 🚨 管理者が作った印は app_metadata（2026-10-04）。handle_new_user が見て、経理への「新規登録」の通知を飛ばさない。
      //    user_metadata は本人が signUp で書けるので、そこには置かない。name は handle_new_user が読む名前
      app_metadata: { provisioned_by_admin: true },
      user_metadata: { full_name: name, name },
    });

    if (authError) {
      await supabaseAdmin.from('admin_provisioning_emails').delete().eq('email', markEmail);
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
      .not('sort_order', 'is', null)
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
        // 🚨 明示する（書かないとトリガーが入れた 'pending' が残る・2026-10-04）
        approval_status: 'approved',
        // 管理者が決めた初期パスワードなので、初回ログインで変更をお願いする（ホームにバナー・2026-10-04 ユーザー確定）
        must_change_password: true,
        pw_change_reason: 'initial',
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
