import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// 残業「受理まち」リマインド（日次）— 確認者（申請先）あて。
//
// 【背景】
// 残業の事前申請は、申請したときに1回だけ確認者へ通知が飛ぶ。
// その通知を見落とすと、そのあと催促が一度も来ないため、
// 「申請したのに受理されないまま勤務日が過ぎる」ことが起きていた。
// 本人あての「実績未報告」リマインド（remind-overtime-unreported）と対になる仕組み。
//
// 【2種類の催促を出す】
//  ① 勤務日を過ぎた未受理 … 毎日（event_key: overtime:pending_review）
//     放置の解消が目的。受理されれば翌日から出なくなる。
//  ② 勤務日より前の未受理 … 申請から24時間たったら1回だけ（event_key: overtime:pending_review_advance）
//     事前申請の本来の目的（勤務日の前に上長が把握する）を果たすため。
//     毎日送ると多すぎるので1回だけにし、送った記録を overtime_reports.advance_remind_sent_at に残す。
//
// 🚨 ②を「通知が既にあるか」で判定しない。ベル通知は既読30日で消えるうえ、
//    ①の pile-up 掃除でも消えるため、「無い＝まだ送っていない」と誤判定して何度も送ってしまう。
// 🚨 ①と②で event_key を分ける。同じにすると①の掃除で②まで消えてしまう。
// 🚨 pile-up防止（①のみ）：毎回まず未処理(dismissed=false)の①を全削除し、
//    いま受理まちの確認者にだけ付け直す。
// 🚨 文言に board 誤判定語（リマインド／お知らせ／メッセージが届き）を入れない。
//    App.tsx が本文で連絡板の通知かどうかを判定しているため、入れるとタップで /board に飛ぶ。

const applyVars = (text: string, vars: Record<string, string>) =>
  text.replace(/\{\{(.+?)\}\}/g, (_, k) => vars[k.trim()] ?? `{{${k.trim()}}}`);
const mdLabel = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

type Row = {
  id: string;
  applicant_id: string;
  reviewer_id: string | null;
  work_date: string;
  created_at: string;
  advance_remind_sent_at: string | null;
};
type Prof = { id: string; name: string | null; email: string | null; is_active: boolean };

serve(async () => {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // JST 今日（remind-overtime-unreported と同方式）
  const todayJst = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // 「申請から24時間たった」の境目
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: rows } = await supabase
    .from("overtime_reports")
    .select("id, applicant_id, reviewer_id, work_date, created_at, advance_remind_sent_at")
    .eq("status", "requested")
    .eq("entry_type", "manual");

  const all = (rows ?? []) as Row[];
  const overdueByReviewer = new Map<string, Row[]>();
  const advanceByReviewer = new Map<string, Row[]>();
  for (const r of all) {
    // 確認者が入っていない行（自己受理で確定済みのものなど）は宛先が決まらないので対象外
    if (!r.reviewer_id) continue;
    if (r.work_date < todayJst) {
      const arr = overdueByReviewer.get(r.reviewer_id) ?? [];
      arr.push(r);
      overdueByReviewer.set(r.reviewer_id, arr);
    } else if (!r.advance_remind_sent_at && r.created_at < cutoff24h) {
      const arr = advanceByReviewer.get(r.reviewer_id) ?? [];
      arr.push(r);
      advanceByReviewer.set(r.reviewer_id, arr);
    }
  }

  // pile-up防止は①（毎日出す分）だけ。②は1回きりなので消さない
  await supabase.from("notifications").delete()
    .eq("event_key", "overtime:pending_review").eq("dismissed", false);

  if (overdueByReviewer.size === 0 && advanceByReviewer.size === 0) {
    return new Response(JSON.stringify({ ok: true, overdue: 0, advance: 0 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  // 宛先（確認者）と申請者の名前をまとめて取得。🚨 退職者（is_active=false）には送らない
  const ids = new Set<string>();
  for (const r of all) { if (r.reviewer_id) ids.add(r.reviewer_id); ids.add(r.applicant_id); }
  const { data: profs } = await supabase
    .from("profiles").select("id, name, email, is_active").in("id", [...ids]);
  const profById = new Map(((profs ?? []) as Prof[]).map((p) => [p.id, p]));

  // 設定（site/email の ON/OFF・メール文面）を2イベントぶん取得
  const { data: settings } = await supabase
    .from("notification_settings")
    .select("event_key, channel, enabled, subject, template")
    .in("event_key", ["overtime:pending_review", "overtime:pending_review_advance"]);
  type Setting = { event_key: string; channel: string; enabled: boolean; subject: string | null; template: string | null };
  const settingOf = (eventKey: string, channel: string) =>
    ((settings ?? []) as Setting[]).find((s) => s.event_key === eventKey && s.channel === channel);

  // 「8/18 林 晃平・8/19 森本 千佳子」。多いときは先頭3件＋残り件数
  const buildSub = (list: Row[]) => {
    const sorted = [...list].sort((a, b) => a.work_date.localeCompare(b.work_date));
    const parts = sorted.slice(0, 3)
      .map((r) => `${mdLabel(r.work_date)} ${profById.get(r.applicant_id)?.name ?? ""}`.trim());
    return parts.join("・") + (sorted.length > 3 ? ` 他${sorted.length - 3}件` : "");
  };

  const sendBatch = async (
    eventKey: string,
    byReviewer: Map<string, Row[]>,
    buildMessage: (count: number) => string,
    fallbackSubject: string,
  ): Promise<{ sent: number; sentRows: string[] }> => {
    const site = settingOf(eventKey, "site");
    const email = settingOf(eventKey, "email");
    const siteEnabled = site?.enabled ?? true;
    const emailEnabled = !!(email?.enabled && email.template);

    let sent = 0;
    const sentRows: string[] = [];
    for (const [reviewerId, list] of byReviewer) {
      const reviewer = profById.get(reviewerId);
      if (!reviewer || reviewer.is_active === false) {
        // 確認者が退職している等で宛先が無いと、その申請は誰にも催促されないまま宙に浮く。
        // 黙って捨てるとどこにも痕跡が残らないのでログには必ず出す
        console.warn(`[pending-review] 宛先なし（退職者/不明）で送信できません event=${eventKey} reviewer_id=${reviewerId} 件数=${list.length}`);
        continue;
      }
      const count = list.length;
      const subMessage = buildSub(list);

      if (siteEnabled) {
        // source_type でタップ遷移（確認者ビュー）、event_key で push_queue → push-dispatch。
        // reference_id=当日 で「1日1通」にする（同じ日に何度も積まれないようにするため）
        await supabase.from("notifications").insert({
          user_id: reviewerId, message: buildMessage(count), sub_message: subMessage,
          source_type: eventKey, event_key: eventKey, reference_id: todayJst,
        });
      }
      if (emailEnabled && reviewer.email) {
        const vars = {
          "件数": String(count),
          "内訳": subMessage,
          "リンク": "https://fivem-portal.vercel.app/overtime?view=confirm",
        };
        await supabase.functions.invoke("send-email", {
          body: {
            to: reviewer.email,
            subject: applyVars(email!.subject || fallbackSubject, vars),
            text: applyVars(email!.template!, vars),
          },
        });
        await new Promise((r) => setTimeout(r, 80));
      }
      // 送れた分だけ「送信済み」にする（宛先なしでスキップした分は次回また対象になる）
      for (const r of list) sentRows.push(r.id);
      sent++;
    }
    return { sent, sentRows };
  };

  // ① 勤務日を過ぎた未受理（毎日）
  const overdue = await sendBatch(
    "overtime:pending_review", overdueByReviewer,
    (n) => `⏰ 受理がまだの残業申請が${n}件あります`,
    "残業申請の受理のお願い",
  );

  // ② 勤務日より前の未受理（1回だけ）
  const advance = await sendBatch(
    "overtime:pending_review_advance", advanceByReviewer,
    (n) => `⏰ 勤務日が近い残業申請が${n}件、受理まちです`,
    "残業申請の受理のお願い（勤務日が近づいています）",
  );
  // 🚨 送った分だけ記録する。ここを忘れると毎日送られる
  if (advance.sentRows.length > 0) {
    await supabase.from("overtime_reports")
      .update({ advance_remind_sent_at: new Date().toISOString() })
      .in("id", advance.sentRows);
  }

  return new Response(JSON.stringify({ ok: true, overdue: overdue.sent, advance: advance.sent }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
