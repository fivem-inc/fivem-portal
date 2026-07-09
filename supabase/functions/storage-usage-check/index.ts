import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Supabase Freeプランのストレージ上限は1GB（=1024MB）。
// 閾値を超えたら経理Slack＋管理者へのサイト内通知でアラートする（pg_cronから毎月1回呼び出される想定）
const FREE_TIER_LIMIT_MB = 1024;
const ALERT_THRESHOLD_MB = 819; // 残り2割（無料枠の8割）を切ったら警告。管理画面のバッジ表示と閾値を統一

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
    const { data, error } = await supabase.rpc('get_storage_usage_mb');
    if (error) throw error;
    const totalMb: number = typeof data === 'number' ? data : Number(data);

    if (totalMb >= ALERT_THRESHOLD_MB) {
      const { data: admins } = await supabase.from('profiles').select('id').eq('role_title', '管理者');
      if (admins && admins.length > 0) {
        const notifications = admins.map((a: { id: string }) => ({
          user_id: a.id,
          message: `⚠️ ストレージ容量が${totalMb}MBに達しました（無料枠${FREE_TIER_LIMIT_MB}MB中）`,
          sub_message: '不要ファイルの整理、または有料プランへの切り替えを検討してください',
        }));
        await supabase.from('notifications').insert(notifications);
      }

      const text = `⚠️ *【ストレージ容量警告】*\n現在の使用量：${totalMb}MB / ${FREE_TIER_LIMIT_MB}MB（無料枠）\n管理画面から不要ファイルの整理、または有料プランへの切り替えを検討してください。`;
      const webhookUrls = [Deno.env.get('SLACK_WEBHOOK_ACCOUNTING'), Deno.env.get('SLACK_WEBHOOK_PRESIDENT')]
        .filter((url): url is string => !!url);
      await Promise.all(webhookUrls.map(url =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        })
      ));
    }

    return new Response(JSON.stringify({ success: true, totalMb, alerted: totalMb >= ALERT_THRESHOLD_MB }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('storage-usage-check error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
