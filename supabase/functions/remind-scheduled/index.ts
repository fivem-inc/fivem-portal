import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async () => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const today = new Date();
  const dayOfMonth = today.getDate();

  // 今日が送信日の有効なリマインダーを取得
  const { data: reminders, error } = await supabase
    .from("board_scheduled_reminders")
    .select("id, channel_id, title, body")
    .eq("day_of_month", dayOfMonth)
    .eq("is_active", true);

  if (error || !reminders || reminders.length === 0) {
    return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
  }

  let totalSent = 0;

  for (const reminder of reminders) {
    let userIds: string[] = [];

    if (reminder.channel_id) {
      // チャンネルメンバーに送る
      const { data: members } = await supabase
        .from("board_channel_members")
        .select("user_id")
        .eq("channel_id", reminder.channel_id);
      userIds = (members || []).map((m: { user_id: string }) => m.user_id);
    } else {
      // 全ユーザーに送る
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id")
        .eq("is_active", true);
      userIds = (profiles || []).map((p: { id: string }) => p.id);
    }

    if (userIds.length === 0) continue;

    await supabase.functions.invoke("send-push", {
      body: {
        user_ids: userIds,
        title: reminder.title,
        body: reminder.body,
        url: "/board",
        tag: `scheduled-${reminder.id}`,
      },
    });

    totalSent += userIds.length;
  }

  return new Response(JSON.stringify({ sent: totalSent }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
