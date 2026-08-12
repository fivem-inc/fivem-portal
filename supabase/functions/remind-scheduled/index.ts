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
  const month = jstNow.getUTCMonth() + 1; // 1〜12
  const dayOfMonth = jstNow.getUTCDate();
  const dayOfWeek = jstNow.getUTCDay(); // 0=日〜6=土
  const hour = jstNow.getUTCHours();
  const minute = jstNow.getUTCMinutes();
  // その月の最終日かどうか（「月末日」設定の判定に使う。翌日のUTC日付が1日になれば今日が月末）
  const isLastDayOfMonth = new Date(jstNow.getTime() + 24 * 60 * 60 * 1000).getUTCDate() === 1;

  const { data: candidates, error } = await supabase
    .from("board_scheduled_reminders")
    .select("id, channel_id, user_ids, title, body, frequency, days, months")
    .eq("send_hour", hour)
    .eq("send_minute", minute)
    .eq("is_active", true);

  const reminders = (candidates || []).filter((r: { frequency: string; days: number[]; months: number[] | null }) => {
    // months は「送る月」。未設定・空は全月に送る（＝これまでどおり）。
    // 🚨 静かに送信が止まる事故を避けるため、判断がつかないときは送る側に倒す
    const monthMatches = !r.months || r.months.length === 0 || r.months.includes(month);
    if (!monthMatches) return false;
    return r.frequency === "weekly"
      ? r.days.includes(dayOfWeek)
      : r.days.includes(dayOfMonth) || (isLastDayOfMonth && r.days.includes(MONTH_END_DAY));
  });

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

    // 🚨 退職者を除く。上の3つの分岐のうち「全ユーザー」だけが is_active を見ており、
    //    個別選択（user_ids）と連絡板グループ（channel_id）は在籍確認をしていなかったため、
    //    退職者にリマインドのメールが飛んでいた。分岐ごとに書くと同じ漏れが再発するので、
    //    宛先が確定したここで一度だけまとめて絞る。
    const { data: activeRows, error: activeErr } = await supabase
      .from("profiles").select("id").in("id", userIds).eq("is_active", true);
    if (activeErr) {
      console.error("[remind-scheduled] 在籍確認に失敗:", activeErr.message);
      continue; // 誰が在籍中か分からないまま送ると退職者に届くので、この回は送らない
    }
    userIds = (activeRows ?? []).map((p: { id: string }) => p.id);
    if (userIds.length === 0) continue;

    // 🚨 対応記録（ホームのバナー・管理画面の対応状況の元）を、通知より「先」に作る。
    //    ここで対象者全員分の行を作ることで「何人に配ったか」が確定する。
    //    順序が逆だと、記録の作成に失敗したときベルだけ鳴ってバナーが出ず、
    //    管理画面の分母も欠けるのに誰も気づけない。
    //    cronは5分おきに走るので、同じ日の二重配信は unique 制約で弾く（on conflict do nothing）。
    const deliveredOn = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10); // JSTの今日
    const { error: respErr } = await supabase
      .from("scheduled_reminder_responses")
      .upsert(
        userIds.map((uid: string) => ({
          reminder_id: reminder.id, delivered_on: deliveredOn, user_id: uid, status: 'pending',
        })),
        { onConflict: 'reminder_id,delivered_on,user_id', ignoreDuplicates: true },
      );
    if (respErr) {
      console.error("[remind-scheduled] 対応記録の作成に失敗:", respErr.message);
      continue; // バナーが出ない・集計が欠けるので、この回は通知も送らない
    }

    // プッシュ通知はベル通知のINSERT→push_queueトリガー→push-dispatchワーカー経由で送られる
    // （管理者の自由文はプッシュに載せず、ワーカーが固定の安全文面を使う）

    // reference_id は付けない：reminder.id は board_scheduled_reminders のIDであり、
    // board_messages のIDではないため、連絡板の詳細画面へのリンクとしては使えない。
    // 🚨 ここに入れると classifyNotif の isBoard 判定（本文に「リマインド」を含むと連絡板とみなす）に
    //    吸い込まれ、タップで連絡板の空ページに着地する
    const { error: notifErr } = await supabase.from("notifications").insert(
      userIds.map((uid: string) => ({ user_id: uid, message: reminder.title, sub_message: reminder.body, event_key: 'reminder:scheduled' }))
    );
    // 🚨 失敗をログに書くだけだと、ログは普段誰も見ないので実質気づけない。
    //    管理画面を開けば分かるように、下で last_error に残す
    const problems: string[] = [];
    if (notifErr) {
      console.error("[remind-scheduled] ベル通知の作成に失敗:", notifErr.message);
      problems.push("ベル通知を作れませんでした（プッシュも届いていません）");
    }

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
      if (emailFailed > 0) {
        console.error(`[remind-scheduled] ${emailFailed}/${emails.length}件のメール送信に失敗`);
        problems.push(`メール${emailFailed}件が届きませんでした`);
      }
    }

    // 配信の結果を残す（管理画面の設定カードに出る）。成功なら last_error は null に戻す
    const { error: logErr } = await supabase.from("board_scheduled_reminders").update({
      last_sent_at: new Date().toISOString(),
      last_sent_count: userIds.length,
      last_error: problems.length > 0 ? problems.join(" ／ ") : null,
    }).eq("id", reminder.id);
    if (logErr) console.error("[remind-scheduled] 配信結果の記録に失敗:", logErr.message);

    totalSent += userIds.length;
  }

  return new Response(JSON.stringify({ sent: totalSent }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
