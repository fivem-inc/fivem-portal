import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const applyVars = (text: string, vars: Record<string, string>) =>
  text.replace(/\{\{(.+?)\}\}/g, (_, k) => vars[k.trim()] ?? `{{${k.trim()}}}`);

const MONTH_END_DAY = 32; // 管理画面の「月末日」ボタンが表す特別値

serve(async () => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // cronは5分おきに呼ばれる。今この瞬間(JST)が送信時刻のリマインダーのうち、
  // frequency/daysが今日(JST)に一致するものだけを対象にする（1件ごとに別の時刻を持てる）
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const dayOfMonth = jstNow.getUTCDate();
  const dayOfWeek = jstNow.getUTCDay(); // 0=日〜6=土
  const hour = jstNow.getUTCHours();
  const minute = jstNow.getUTCMinutes();
  // その月の最終日かどうか（「月末日」設定の判定に使う。翌日のUTC日付が1日になれば今日が月末）
  const isLastDayOfMonth = new Date(jstNow.getTime() + 24 * 60 * 60 * 1000).getUTCDate() === 1;

  const { data: candidates, error } = await supabase
    .from("board_scheduled_reminders")
    .select("id, channel_id, user_ids, title, body, frequency, days")
    .eq("send_hour", hour)
    .eq("send_minute", minute)
    .eq("is_active", true);

  const reminders = (candidates || []).filter((r: { frequency: string; days: number[] }) =>
    r.frequency === "weekly"
      ? r.days.includes(dayOfWeek)
      : r.days.includes(dayOfMonth) || (isLastDayOfMonth && r.days.includes(MONTH_END_DAY))
  );

  if (error || reminders.length === 0) {
    return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
  }

  const { data: emailSetting } = await supabase
    .from("notification_settings")
    .select("enabled, subject, template")
    .eq("event_key", "reminder:scheduled")
    .eq("channel", "email")
    .maybeSingle();

  let totalSent = 0;

  for (const reminder of reminders) {
    let userIds: string[] = [];

    if (reminder.user_ids && reminder.user_ids.length > 0) {
      // 個別選択されたスタッフに送る
      userIds = reminder.user_ids;
    } else if (reminder.channel_id) {
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

    // プッシュ通知はベル通知のINSERT→push_queueトリガー→push-dispatchワーカー経由で送られる
    // （管理者の自由文はプッシュに載せず、ワーカーが固定の安全文面を使う）

    // reference_id は付けない：reminder.id は board_scheduled_reminders のIDであり、
    // board_messages のIDではないため、連絡板の詳細画面へのリンクとしては使えない
    await supabase.from("notifications").insert(
      userIds.map((uid: string) => ({ user_id: uid, message: reminder.title, sub_message: reminder.body, event_key: 'reminder:scheduled' }))
    );

    if (emailSetting?.enabled && emailSetting.template) {
      const vars = { "タイトル": reminder.title, "本文": reminder.body };
      const subject = applyVars(emailSetting.subject || "", vars);
      const text = applyVars(emailSetting.template, vars);
      const { data: profiles } = await supabase.from("profiles").select("email").in("id", userIds);
      const emails = (profiles ?? []).map((p: { email: string | null }) => p.email).filter(Boolean) as string[];
      let emailFailed = 0;
      for (const to of emails) {
        const { error: emailError } = await supabase.functions.invoke("send-email", { body: { to, subject, text } });
        if (emailError) { emailFailed++; console.error("[remind-scheduled] send-email error:", emailError); }
        await new Promise((r) => setTimeout(r, 80));
      }
      if (emailFailed > 0) console.error(`[remind-scheduled] ${emailFailed}/${emails.length}件のメール送信に失敗`);
    }

    totalSent += userIds.length;
  }

  return new Response(JSON.stringify({ sent: totalSent }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
