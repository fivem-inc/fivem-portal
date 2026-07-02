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

  // scheduled_at <= now かつ status='scheduled' のメッセージを取得しつつ同時に status='sent' へ更新（1クエリでatomicに行う）
  // → cronが多重起動しても、2回目以降のUPDATEはWHERE条件に一致する行が無くなっているため二重通知されない
  const { data: messages, error } = await supabase
    .from('board_messages')
    .update({ status: 'sent', sent_at: now })
    .eq('status', 'scheduled')
    .lte('scheduled_at', now)
    .select('id, user_id, subject, body');

  if (error || !messages || messages.length === 0) {
    return new Response(JSON.stringify({ processed: 0 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // メール通知設定（お知らせ受信時・email）を一度だけ取得
  const { data: emailSetting } = await supabase
    .from('notification_settings')
    .select('enabled, subject, template')
    .eq('event_key', 'board:notice')
    .eq('channel', 'email')
    .maybeSingle();

  const applyVars = (text: string, vars: Record<string, string>) =>
    text.replace(/\{\{(.+?)\}\}/g, (_, k) => vars[k.trim()] ?? `{{${k.trim()}}}`);

  let processed = 0;
  for (const msg of messages) {
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
    // notificationsテーブルの実列名は user_id/message/sub_message/source_type/reference_id/read
    // （以前は body/type/is_read という存在しない列名で insert していたため、通知が一件も作成されていなかった）
    const notifications = recipients.map((r: { user_id: string }) => ({
      user_id: r.user_id,
      message: `${senderName}からお知らせが届きました`,
      sub_message: preview,
      reference_id: msg.id,
    }));
    const { error: notifyError } = await supabase.from('notifications').insert(notifications);
    if (notifyError) console.error('notification insert error:', notifyError);

    // メール通知（管理画面の通知設定でON時のみ送信）
    if (emailSetting?.enabled && emailSetting.template) {
      const link = `https://fivem-portal.vercel.app/board?openInboxId=${msg.id}`;
      const vars = { '送信者名': senderName, '件名': msg.subject || '', 'リンク': link };
      const subject = applyVars(emailSetting.subject || '', vars);
      const text = applyVars(emailSetting.template, vars);
      const { data: recipientProfiles } = await supabase
        .from('profiles')
        .select('email')
        .in('id', recipients.map((r: { user_id: string }) => r.user_id));
      const emails = (recipientProfiles ?? []).map((p: { email: string | null }) => p.email).filter(Boolean) as string[];
      if (emails.length > 0) {
        const { error: emailError } = await supabase.functions.invoke('send-email', { body: { to: emails, subject, text } });
        if (emailError) console.error('send-email error:', emailError);
      }
    }

    processed++;
  }

  return new Response(JSON.stringify({ processed }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
