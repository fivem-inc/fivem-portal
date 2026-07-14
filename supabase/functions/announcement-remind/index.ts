// 社内お知らせのリマインド送信（日次cronから呼ばれる）。
//
// 終了日（ends_at）が近づいた「表示中」のお知らせを拾い、ONにされたチャンネルで念押しする。
//   remind_push  … 全アクティブユーザーの notifications にINSERT
//                    → トリガーが push_queue に積む → push-dispatch がプッシュ送信
//                    （event_key='announcement:remind' は push-dispatch の EVENT_MAP に登録済み）
//   remind_email … 全アクティブユーザーへ send-email（件名=タイトル / 本文=本文）。
//                    通知OFFの人にも確実に届けるための経路。
//
// 二重送信防止:
//   - notifications に reference_id=お知らせID（push_queueトリガーが user×event×reference で重複排除）
//   - announcements.remind_last_sent_on（JST日付）で同日二重送信を防ぐ
//   - remind_frequency='once' は一度送ったら以後スキップ、'daily' は日毎に送る
//
// タイムゾーン: 国内運用なので判定は全てJST（UTC+9）の「日付」で行う。
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, "0");

const jstDayNumber = (t: number): number => {
  const j = new Date(t + JST_OFFSET_MS);
  return Math.floor(Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate()) / 86400000);
};

interface AnnRow {
  id: string;
  title: string;
  body: string;
  starts_at: string | null;
  ends_at: string | null;
  remind_push: boolean;
  remind_email: boolean;
  remind_days_before: number;
  remind_frequency: string;
  remind_last_sent_on: string | null;
}

serve(async () => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const nowMs = Date.now();
  const jstNow = new Date(nowMs + JST_OFFSET_MS);
  const todayStr = `${jstNow.getUTCFullYear()}-${pad(jstNow.getUTCMonth() + 1)}-${pad(jstNow.getUTCDate())}`;
  const todayNum = jstDayNumber(nowMs);

  // リマインド対象候補（表示中・終了日あり・プッシュ or メールがON）
  const { data: candidates, error } = await supabase
    .from("announcements")
    .select("id, title, body, starts_at, ends_at, remind_push, remind_email, remind_days_before, remind_frequency, remind_last_sent_on")
    .eq("active", true)
    .not("ends_at", "is", null)
    .or("remind_push.eq.true,remind_email.eq.true");

  if (error) {
    console.error("[announcement-remind] query error:", error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  const due = ((candidates ?? []) as AnnRow[]).filter((a) => {
    if (!a.ends_at) return false;
    if (a.starts_at && new Date(a.starts_at).getTime() > nowMs) return false; // 開始前
    const endNum = jstDayNumber(new Date(a.ends_at).getTime());
    const inWindow = todayNum >= endNum - a.remind_days_before && todayNum <= endNum;
    if (!inWindow) return false;
    if (a.remind_frequency === "daily") return a.remind_last_sent_on !== todayStr;
    return a.remind_last_sent_on == null; // 'once'（既定）: 一度送ったら以後スキップ
  });

  if (due.length === 0) {
    return new Response(JSON.stringify({ push: 0, email: 0, announcements: 0 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  // 送信先＝アクティブな全ユーザー（id と email）
  const { data: profiles } = await supabase.from("profiles").select("id, email").eq("is_active", true);
  const rows = (profiles ?? []) as { id: string; email: string | null }[];
  const userIds = rows.map((p) => p.id);
  const emails = rows.map((p) => p.email).filter((e): e is string => !!e);

  let pushCount = 0;
  let emailCount = 0;
  let sentAnnouncements = 0;

  for (const a of due) {
    let anySent = false;

    // プッシュ（ベル通知INSERT→push_queue→push-dispatch）
    if (a.remind_push && userIds.length > 0) {
      const { error: insErr } = await supabase.from("notifications").insert(
        userIds.map((uid) => ({
          user_id: uid,
          message: a.title,
          sub_message: a.body,
          event_key: "announcement:remind",
          reference_id: a.id,
        }))
      );
      if (insErr) console.error(`[announcement-remind] notif insert failed ${a.id}:`, insErr);
      else { pushCount += userIds.length; anySent = true; }
    }

    // メール（全員へ send-email）
    if (a.remind_email && emails.length > 0) {
      let ok = 0;
      for (const to of emails) {
        const { error: mailErr } = await supabase.functions.invoke("send-email", {
          body: { to, subject: `【お知らせ】${a.title}`, text: a.body },
        });
        if (mailErr) console.error(`[announcement-remind] email failed ${a.id} → ${to}:`, mailErr);
        else ok++;
        await new Promise((r) => setTimeout(r, 80));
      }
      if (ok > 0) { emailCount += ok; anySent = true; }
    }

    // どれか送れたら送信済みマーク（全失敗なら翌日以降のcronで再試行）
    if (anySent) {
      await supabase.from("announcements").update({ remind_last_sent_on: todayStr }).eq("id", a.id);
      sentAnnouncements++;
    }
  }

  console.log(`[announcement-remind] announcements=${sentAnnouncements} push=${pushCount} email=${emailCount}`);
  return new Response(JSON.stringify({ push: pushCount, email: emailCount, announcements: sentAnnouncements }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
