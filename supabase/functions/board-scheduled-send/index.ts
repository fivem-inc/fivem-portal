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

  const now = new Date().toISOString();

  // scheduled_at <= now かつ status='scheduled' のメッセージを取得
  const { data: messages, error } = await supabase
    .from('board_messages')
    .select('id, user_id, subject, body')
    .eq('status', 'scheduled')
    .lte('scheduled_at', now);

  if (error || !messages || messages.length === 0) {
    return new Response(JSON.stringify({ processed: 0 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let processed = 0;
  for (const msg of messages) {
    // status を 'sent' に更新
    await supabase
      .from('board_messages')
      .update({ status: 'sent' })
      .eq('id', msg.id);

    // 受信者を取得
    const { data: recipients } = await supabase
      .from('board_message_recipients')
      .select('user_id')
      .eq('message_id', msg.id);

    if (!recipients || recipients.length === 0) continue;

    // 送信者名を取得
    const { data: senderProfile } = await supabase
      .from('profiles')
      .select('name')
      .eq('id', msg.user_id)
      .single();

    const senderName = senderProfile?.name || '管理者';
    const preview = (msg.subject || msg.body || '').slice(0, 40);

    // 受信者全員に通知
    const notifications = recipients.map((r: { user_id: string }) => ({
      user_id: r.user_id,
      message: `${senderName}からお知らせが届きました`,
      body: preview,
      type: 'board',
      is_read: false,
    }));
    await supabase.from('notifications').insert(notifications);

    processed++;
  }

  return new Response(JSON.stringify({ processed }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
