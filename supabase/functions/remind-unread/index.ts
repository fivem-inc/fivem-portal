import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async () => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const todayStr = today.toISOString().slice(0, 10);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  // 期限が今日または明日の投稿を取得（親投稿のみ）
  const { data: messages, error } = await supabase
    .from("board_messages")
    .select("id, channel_id, body, deadline")
    .in("deadline", [todayStr, tomorrowStr])
    .is("parent_id", null);

  if (error || !messages || messages.length === 0) {
    return new Response(JSON.stringify({ checked: 0 }), { status: 200 });
  }

  let totalSent = 0;

  for (const msg of messages) {
    // チャンネルメンバーを取得
    const { data: members } = await supabase
      .from("board_channel_members")
      .select("user_id")
      .eq("channel_id", msg.channel_id);

    if (!members || members.length === 0) continue;

    // 既読者を取得
    const { data: reads } = await supabase
      .from("board_reads")
      .select("user_id")
      .eq("message_id", msg.id);

    const readUserIds = new Set((reads || []).map((r: { user_id: string }) => r.user_id));

    // 未読者だけ抽出
    const unreadUserIds = members
      .map((m: { user_id: string }) => m.user_id)
      .filter((id: string) => !readUserIds.has(id));

    if (unreadUserIds.length === 0) continue;

    const isToday = msg.deadline === todayStr;
    const title = isToday ? "⏰ 本日期限の連絡があります" : "📅 明日期限の連絡があります";
    const body = msg.body.length > 50 ? msg.body.slice(0, 50) + "…" : msg.body;

    await supabase.functions.invoke("send-push", {
      body: {
        user_ids: unreadUserIds,
        title,
        body,
        url: "/board",
        tag: `remind-${msg.id}`,
      },
    });

    totalSent += unreadUserIds.length;
  }

  return new Response(JSON.stringify({ checked: messages.length, sent: totalSent }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
