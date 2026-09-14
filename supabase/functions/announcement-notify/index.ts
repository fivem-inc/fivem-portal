// 社内お知らせの「作成時通知」を全員へ配信する（お知らせを作成した直後にクライアントから呼ぶ）。
//   notify_on_create_push  … 全アクティブユーザーの notifications にINSERT
//                             → トリガーが push_queue に積む → push-dispatch がプッシュ送信
//                             （event_key='announcement:new' は push-dispatch の EVENT_MAP に登録済み）
//   notify_on_create_email … 全アクティブユーザーへ send-email（件名=タイトル / 本文=本文）
//
// 認証（2026-09-15 変更）：管理者、またはお知らせのタブが開いているマネージャー以上。
//   🚨 判定は DB の can_manage_admin_tab('announcements') を**利用者の JWT のまま**呼ぶ
//      （service_role で呼ぶと auth.uid() が null になり、いつも false）。役職名では判定しない
// 二重送信の歯止め（2026-09-15）：announcements.notified_at が null の行だけ「送る印」を付けてから送る。
//   🚨 印を付けられなかった＝すでに送っている → 409 で断る（id を渡すたびに全員へ送り直していた）
//   🚨 送る相手を読めなかったときだけ印を戻す（何も送っていないので、もう一度押せるように）
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

  const { data: allowed, error: permError } = await supabaseUser.rpc('can_manage_admin_tab', { p_tab: 'announcements' });
  if (permError) {
    console.error('[announcement-notify] permission check failed:', permError);
    return json({ error: '権限を確かめられませんでした' }, 500);
  }
  if (allowed !== true) {
    return json({ error: 'お知らせの通知を送る権限がありません' }, 403);
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

    // 送る印を先に付ける（null の行だけ）。付けられなければ、すでに送っている
    const { data: claimed, error: claimErr } = await supabaseAdmin
      .from('announcements')
      .update({ notified_at: new Date().toISOString() })
      .eq('id', id)
      .is('notified_at', null)
      .select('id');
    if (claimErr) {
      console.error('[announcement-notify] claim failed:', claimErr);
      return json({ error: '送信の準備に失敗しました' }, 500);
    }
    if (!claimed || claimed.length === 0) {
      return json({ error: 'このお知らせの通知はすでに送っています' }, 409);
    }

    const { data: profiles, error: profErr } = await supabaseAdmin.from('profiles').select('id, email').eq('is_active', true);
    if (profErr) {
      console.error('[announcement-notify] profiles read failed:', profErr);
      await supabaseAdmin.from('announcements').update({ notified_at: null }).eq('id', id);
      return json({ error: '送る相手を読み込めませんでした' }, 500);
    }
    const rows = (profiles ?? []) as { id: string; email: string | null }[];

    let pushCount = 0;
    let pushFailed = false;
    let emailCount = 0;
    let emailFailed = 0;

    if (ann.notify_on_create_push && rows.length > 0) {
      const { error: insErr } = await supabaseAdmin.from('notifications').insert(
        rows.map((p) => ({
          user_id: p.id,
          message: `🔔 ${ann.title}`,
          sub_message: ann.body,
          event_key: 'announcement:new',
          reference_id: ann.id,
        }))
      );
      if (insErr) { console.error('[announcement-notify] notif insert failed:', insErr); pushFailed = true; }
      else pushCount = rows.length;
    }

    if (ann.notify_on_create_email) {
      const emails = rows.map((p) => p.email).filter((e): e is string => !!e);
      for (const to of emails) {
        const { error: mailErr } = await supabaseAdmin.functions.invoke('send-email', {
          body: { to, subject: `【お知らせ】${ann.title}`, text: ann.body },
        });
        if (mailErr) { console.error(`[announcement-notify] email failed → ${to}:`, mailErr); emailFailed++; }
        else emailCount++;
        await new Promise((r) => setTimeout(r, 80));
      }
    }

    console.log(`[announcement-notify] ${ann.id} push=${pushCount} email=${emailCount} push_failed=${pushFailed} email_failed=${emailFailed}`);
    return json({ push: pushCount, email: emailCount, push_failed: pushFailed, email_failed: emailFailed });
  } catch (err) {
    console.error('[announcement-notify] error:', err);
    return json({ error: String(err) }, 500);
  }
});
