import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// 残業「実績未報告」リマインド（日次）。
// pg_cron から1日1回叩かれ、各人の「申請済み(requested/request_confirmed)・勤務日超過・終日以外」の件数を集計して、
// 本人へベル通知を1件だけ作る（＋push はパイプライン、メールは設定に従う）。
// pile-up防止：毎回まず未処理(dismissed=false)の当リマインドを全削除し、現在未報告の人に付け直す。
// 文言は board 誤判定語（リマインド／お知らせ／メッセージが届き）を含めない（App.tsx が本文で board 判定するため）。

const FULL_DAY_TYPES = ["chosei_off", "furikae_off", "absence"];
const isFullDay = (types: string[] | null | undefined) => (types ?? []).some((t) => FULL_DAY_TYPES.includes(t));
const applyVars = (text: string, vars: Record<string, string>) =>
  text.replace(/\{\{(.+?)\}\}/g, (_, k) => vars[k.trim()] ?? `{{${k.trim()}}}`);
const mdLabel = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

serve(async () => {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // JST 今日（announcement-remind と同方式）
  const todayJst = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // 申請済み(requested/request_confirmed)を取得し、勤務日超過＆終日以外＝実績未報告 を人別に集計。
  // 🚨 requested（上長がまだ受理していない分）も対象にする（2026-08-25）。
  //    受理されないと実績報告できない作りだったため、上長が受理を忘れると本人にも何も出ず放置されていた。
  const { data: rows } = await supabase
    .from("overtime_reports")
    .select("applicant_id, work_date, application_types")
    .in("status", ["requested", "request_confirmed"]);

  const byUser = new Map<string, string[]>();
  for (const r of ((rows ?? []) as { applicant_id: string; work_date: string; application_types: string[] | null }[])) {
    if (r.work_date < todayJst && !isFullDay(r.application_types)) {
      const arr = byUser.get(r.applicant_id) ?? [];
      arr.push(r.work_date);
      byUser.set(r.applicant_id, arr);
    }
  }

  // 設定（site/email の ON/OFF・メール文面）
  const { data: settings } = await supabase
    .from("notification_settings")
    .select("channel, enabled, subject, template")
    .eq("event_key", "overtime:unreported");
  const site = (settings ?? []).find((s: { channel: string }) => s.channel === "site");
  const email = (settings ?? []).find((s: { channel: string }) => s.channel === "email");
  const siteEnabled = site?.enabled ?? true;
  const emailEnabled = !!(email?.enabled && email.template);

  // pile-up防止：未処理(dismissed=false)の当リマインドを一旦全消去 → 現在未報告の人だけ付け直す（解決済みは消える）
  await supabase.from("notifications").delete().eq("event_key", "overtime:unreported").eq("dismissed", false);

  let sent = 0;
  for (const [uid, dates] of byUser) {
    const sorted = [...dates].sort();
    const count = sorted.length;
    const message = `⏰ 実績の報告が必要な残業が${count}件あります`;
    const subMessage = sorted.map(mdLabel).join("・");

    if (siteEnabled) {
      // source_type でタップ遷移、event_key で push_queue → push-dispatch。reference_id=当日で日次pushを許可。
      await supabase.from("notifications").insert({
        user_id: uid, message, sub_message: subMessage,
        source_type: "overtime:unreported", event_key: "overtime:unreported", reference_id: todayJst,
      });
    }
    if (emailEnabled) {
      const { data: prof } = await supabase.from("profiles").select("email").eq("id", uid).maybeSingle();
      const to = (prof as { email: string | null } | null)?.email;
      if (to) {
        const vars = { "件数": String(count), "日付": subMessage, "リンク": "https://fivem-portal.vercel.app/overtime" };
        const subject = applyVars(email!.subject || "残業の実績報告のお願い", vars);
        const text = applyVars(email!.template!, vars);
        await supabase.functions.invoke("send-email", { body: { to, subject, text } });
        await new Promise((r) => setTimeout(r, 80));
      }
    }
    sent++;
  }

  return new Response(JSON.stringify({ ok: true, users: sent }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
