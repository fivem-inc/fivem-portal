import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// 申請依頼「期限」リマインド（日次・2026-09-11 ユーザー依頼）。
// pg_cron から朝9時（JST）に1回叩かれ、まだ対応していない依頼の**期限が近い／過ぎた**人へ
// ベル通知を1件だけ作る（＋push はパイプライン、メールは設定に従う）。
//
// 【なぜ作ったか】
// 依頼の期限（due_date）は**カードに文字で出すだけで、誰も見ていなかった**。
// 「対応しない」と回答があれば上長には伝わるが、**何も返ってこないまま期限が過ぎる**のが
// いちばん困る、というユーザーの指摘で作った。
//
// 【送るとき】部下本人だけに、次の2回（ユーザー確定）
//   ・期限の**前日**の朝 … due_date が「明日」
//   ・期限の**翌日**の朝 … due_date が「昨日」
// 🚨 **毎日は送らない**。毎日届くものは読まれなくなる（ユーザー確定）。
// 🚨 **期限を入れていない依頼は対象外**。期限を決めていない＝急いでいない、と読める。
//
// 【状態を持たない作りにしてある】
// 🚨 「もう送った」という記録を**持たない**。日付を比べるだけで前日／翌日が決まるため。
//    記録を持つと、CLAUDE.md の決まりで掃除の cron と1日の上限をセットで作る必要が出る。
//    貯まるものが無いので、その心配ごと自体が無い。
//
// 【文面】
// 🚨 個人名・申請の中身は書かない（プッシュはロック画面に出る＝そばにいる人に見える）。
// 🚨 本文に「リマインド」「お知らせ」「メッセージが届き」を入れない。
//    App.tsx が**本文の文字で連絡板の通知かを判定している**ので、入れると連絡板扱いになる。

const applyVars = (text: string, vars: Record<string, string>) =>
  text.replace(/\{\{(.+?)\}\}/g, (_, k) => vars[k.trim()] ?? `{{${k.trim()}}}`);
const mdLabel = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
// JST の日付を1日ずらす（既存のリマインドと同じ「+9時間して切る」方式）
const shiftJstDay = (offsetDays: number) =>
  new Date(Date.now() + 9 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const EVENT_KEY = "application_request:due";

serve(async () => {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const todayJst = shiftJstDay(0);
  const tomorrow = shiftJstDay(1);
  const yesterday = shiftJstDay(-1);

  // 🚨 status='open'＝まだ申請も「対応しない」もしていない依頼だけ。
  //    applied / dismissed / withdrawn に催促を送ると「済んだことを蒸し返す」ことになる。
  const { data: rows, error } = await supabase
    .from("application_requests")
    .select("id, recipient_id, kind, target_dates, due_date")
    .eq("status", "open")
    .in("due_date", [tomorrow, yesterday]);
  // 🚨 読めなかったら**何もせずに終わる**。ここで通知を消して作り直す作りなので、
  //    読めないまま先へ進むと「消しただけ」になる（未対応の依頼が画面から消える）。
  if (error) {
    console.error("[remind-application-request] 依頼を読めませんでした", error.message);
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  type Row = { id: string; recipient_id: string; kind: string; target_dates: string[] | null; due_date: string };
  const byUser = new Map<string, Row[]>();
  for (const r of ((rows ?? []) as Row[])) {
    const arr = byUser.get(r.recipient_id) ?? [];
    arr.push(r);
    byUser.set(r.recipient_id, arr);
  }

  // 設定（site/email の ON/OFF・メール文面）。行が無いときは site は出す・メールは出さない
  const { data: settings } = await supabase
    .from("notification_settings")
    .select("channel, enabled, subject, template")
    .eq("event_key", EVENT_KEY);
  const site = (settings ?? []).find((s: { channel: string }) => s.channel === "site");
  const email = (settings ?? []).find((s: { channel: string }) => s.channel === "email");
  const siteEnabled = site?.enabled ?? true;
  const emailEnabled = !!(email?.enabled && email.template);

  // 溜まらないように、まだ読まれていない前回ぶんを消してから付け直す
  // （既存の remind-overtime-unreported と同じやり方。対応済みの催促は自然に消える）
  await supabase.from("notifications").delete().eq("event_key", EVENT_KEY).eq("dismissed", false);

  let sent = 0;
  for (const [uid, reqs] of byUser) {
    const over = reqs.filter(r => r.due_date === yesterday);
    const soon = reqs.filter(r => r.due_date === tomorrow);

    // 🚨 「申請依頼」という言い方に揃える（画面のカードと同じ言葉）。
    const message = over.length > 0 && soon.length > 0
      ? `📩 申請がまだの依頼が${reqs.length}件あります（期限を過ぎたもの ${over.length}件）`
      : over.length > 0
        ? `📩 申請の期限を過ぎた依頼が${over.length}件あります`
        : `📩 明日までに申請が必要な依頼が${soon.length}件あります`;
    // 副題は「対象日（期限 ◯/◯）」。🚨 依頼の中身（メモ）は入れない
    const subMessage = reqs
      .map(r => `${(r.target_dates ?? []).map(mdLabel).join("・")}${r.kind === "leave" ? " 休暇" : " 残業・勤務変更"}（期限 ${mdLabel(r.due_date)}）`)
      .join(" ／ ");

    if (siteEnabled) {
      // 🚨 reference_id は「依頼が1件だけのとき」はその依頼ID、複数なら今日の日付。
      //    1件なら押したときに該当カードを光らせられる（?focus=<依頼ID>）。
      //    複数だとどれを光らせるか決められないので、日付を入れて一覧に着地させる。
      //    ＝日付を入れるのは「毎日のプッシュを別ものとして扱わせる」ためでもある
      //      （push_queue は user・event_key・reference_id の組で重複を見ている）。
      const referenceId = reqs.length === 1 ? reqs[0].id : todayJst;
      await supabase.from("notifications").insert({
        user_id: uid, message, sub_message: subMessage,
        source_type: EVENT_KEY, event_key: EVENT_KEY, reference_id: referenceId,
      });
    }
    if (emailEnabled) {
      const { data: prof } = await supabase.from("profiles").select("email").eq("id", uid).maybeSingle();
      const to = (prof as { email: string | null } | null)?.email;
      if (to) {
        const vars = {
          "件数": String(reqs.length),
          "内訳": subMessage,
          "リンク": "https://fivem-portal.vercel.app/overtime?tab=history",
        };
        const subject = applyVars(email!.subject || "申請依頼の期限が近づいています", vars);
        const text = applyVars(email!.template!, vars);
        await supabase.functions.invoke("send-email", { body: { to, subject, text } });
        await new Promise((r) => setTimeout(r, 80));
      }
    }
    sent++;
  }

  return new Response(JSON.stringify({ ok: true, users: sent, tomorrow, yesterday }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
