import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const applyVars = (text: string, vars: Record<string, string>) =>
  text.replace(/\{\{(.+?)\}\}/g, (_, k) => vars[k.trim()] ?? `{{${k.trim()}}}`);

serve(async () => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: daysSetting } = await supabase
    .from("reminder_days_settings")
    .select("days_before, send_hour, send_minute")
    .eq("event_key", "remind_unread")
    .maybeSingle();
  const daysBefore: number[] = daysSetting?.days_before ?? [1, 0];

  // 設定された送信時刻(JST)でなければ何もしない（cronは5分おきに呼ばれる）
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const sendHour = daysSetting?.send_hour ?? 9;
  const sendMinute = daysSetting?.send_minute ?? 0;
  if (jstNow.getUTCHours() !== sendHour || jstNow.getUTCMinutes() !== sendMinute) {
    return new Response(JSON.stringify({ checked: 0, skipped: "not send time" }), { status: 200 });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const targetDates = daysBefore.map((n) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  });

  // 締切が対象日（今日+N日）の投稿を取得（親投稿のみ）
  const { data: messages, error } = await supabase
    .from("board_messages")
    .select("id, channel_id, body, deadline")
    .in("deadline", targetDates)
    .is("parent_id", null);

  if (error || !messages || messages.length === 0) {
    return new Response(JSON.stringify({ checked: 0 }), { status: 200 });
  }

  const { data: emailSetting } = await supabase
    .from("notification_settings")
    .select("enabled, subject, template")
    .eq("event_key", "reminder:unread")
    .eq("channel", "email")
    .maybeSingle();

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

    const deadlineDate = new Date(msg.deadline + "T00:00:00Z");
    const diffDays = Math.round((deadlineDate.getTime() - today.getTime()) / 86400000);
    const title = diffDays === 0
      ? "⏰ 本日期限の連絡があります"
      : diffDays === 1
        ? "📅 明日期限の連絡があります"
        : `📅 ${diffDays}日後期限の連絡があります`;
    const body = msg.body.length > 50 ? msg.body.slice(0, 50) + "…" : msg.body;

    // プッシュ通知はベル通知のINSERT→push_queueトリガー→push-dispatchワーカー経由で送られる
    // （event_keyの期限区分でワーカーが「本日期限 n件」等の安全文面を組み立てる）
    const pushEventKey = diffDays === 0
      ? "reminder:unread:today"
      : diffDays === 1
        ? "reminder:unread:tomorrow"
        : "reminder:unread:later";
    await supabase.from("notifications").insert(
      unreadUserIds.map((uid: string) => ({ user_id: uid, message: title, sub_message: body, reference_id: msg.id, event_key: pushEventKey }))
    );

    if (emailSetting?.enabled && emailSetting.template) {
      const link = `https://fivem-portal.vercel.app/board`;
      const vars = { "件名": title, "リンク": link };
      const subject = applyVars(emailSetting.subject || "", vars);
      const text = applyVars(emailSetting.template, vars);
      const { data: profiles } = await supabase.from("profiles").select("email").in("id", unreadUserIds);
      const emails = (profiles ?? []).map((p: { email: string | null }) => p.email).filter(Boolean) as string[];
      let emailFailed = 0;
      for (const to of emails) {
        const { error: emailError } = await supabase.functions.invoke("send-email", { body: { to, subject, text } });
        if (emailError) { emailFailed++; console.error("[remind-unread] send-email error:", emailError); }
        await new Promise((r) => setTimeout(r, 80));
      }
      if (emailFailed > 0) console.error(`[remind-unread] ${emailFailed}/${emails.length}件のメール送信に失敗`);
    }

    totalSent += unreadUserIds.length;
  }

  return new Response(JSON.stringify({ checked: messages.length, sent: totalSent }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
