import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://fivem-portal.vercel.app',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const { email, name } = await req.json();
    const displayName = name || email || '不明';

    const { data: admins } = await supabase
      .from('profiles')
      .select('id')
      .eq('role_title', '管理者');

    if (admins && admins.length > 0) {
      const notifications = admins.map((a: { id: string }) => ({
        user_id: a.id,
        message: `新規登録：${displayName}さんが承認待ちです`,
        body: email || '',
        type: 'signup_pending',
        is_read: false,
      }));
      await supabase.from('notifications').insert(notifications);
    }

    const webhookUrl = Deno.env.get('SLACK_WEBHOOK_ACCOUNTING') || '';
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `🆕 *【新規登録】*\n*名前：* ${displayName}\n*メール：* ${email || '不明'}\n管理画面のユーザー管理から承認してください。`,
        }),
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('new-signup-notify error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
