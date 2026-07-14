// 社内お知らせの「作成時通知」を全員へ配信する（管理者が作成した直後にクライアントから呼ぶ）。
//   notify_on_create_push  … 全アクティブユーザーの notifications にINSERT
//                             → トリガーが push_queue に積む → push-dispatch がプッシュ送信
//                             （event_key='announcement:new' は push-dispatch の EVENT_MAP に登録済み）
//   notify_on_create_email … 全アクティブユーザーへ send-email（件名=タイトル / 本文=本文）
//
// 二重送信防止: notifications に reference_id=お知らせID（push_queueトリガーが重複排除）。
// 認証: 管理者のみ実行可（create-user と同じパターン）。
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) });
  const corsHeaders = getCorsHeaders(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);

  const supabaseUser = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
  if (userError || !user) return json({ error: 'Unauthorized' }, 401);

  const { data: profile } = await supabaseUser.from('profiles').select('role_title').eq('id', user.id).single();
  if (!profile || !['admin', '管理者'].includes(profile.role_title)) {
    return json({ error: 'Forbidden: 管理者のみ実行可能です' }, 403);
  }

  try {
    const { id } = await req.json();
    if (!id) return json({ error: 'id は必須です' }, 400);

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const { data: ann, error: annErr } = await supabaseAdmin
      .from('announcements')
      .select('id, title, body, notify_on_create_push, notify_on_create_email')
      .eq('id', id)
      .single();
    if (annErr || !ann) return json({ error: 'お知らせが見つかりません' }, 404);
    if (!ann.notify_on_create_push && !ann.notify_on_create_email) return json({ push: 0, email: 0 });

    const { data: profiles } = await supabaseAdmin.from('profiles').select('id, email').eq('is_active', true);
    const rows = (profiles ?? []) as { id: string; email: string | null }[];

    let pushCount = 0;
    let emailCount = 0;

    if (ann.notify_on_create_push && rows.length > 0) {
      const { error: insErr } = await supabaseAdmin.from('notifications').insert(
        rows.map((p) => ({
          user_id: p.id,
          message: ann.title,
          sub_message: ann.body,
          event_key: 'announcement:new',
          reference_id: ann.id,
        }))
      );
      if (insErr) console.error('[announcement-notify] notif insert failed:', insErr);
      else pushCount = rows.length;
    }

    if (ann.notify_on_create_email) {
      const emails = rows.map((p) => p.email).filter((e): e is string => !!e);
      for (const to of emails) {
        const { error: mailErr } = await supabaseAdmin.functions.invoke('send-email', {
          body: { to, subject: `【お知らせ】${ann.title}`, text: ann.body },
        });
        if (mailErr) console.error(`[announcement-notify] email failed → ${to}:`, mailErr);
        else emailCount++;
        await new Promise((r) => setTimeout(r, 80));
      }
    }

    console.log(`[announcement-notify] ${ann.id} push=${pushCount} email=${emailCount}`);
    return json({ push: pushCount, email: emailCount });
  } catch (err) {
    console.error('[announcement-notify] error:', err);
    return json({ error: String(err) }, 500);
  }
});
