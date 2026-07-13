// プッシュ通知パイプラインのワーカー
//
// pg_cron（1分毎）から呼ばれ、push_queueの送信待ちを
// 「ユーザー×イベント種別」で集約して固定の安全文面で送信する。
//
// 文面ルール（2026-07-11実機テスト済み・変更禁止）:
//   「状態を表す漢字名詞 + 件数」のみ使用可（新着/本日期限/明日期限/差戻/未承認）。
//   「確認」「依頼」「〜待ち」「〜してください」等の行動を促す語・自由文は
//   Android Chromeが不正な通知と判定して警告表示に置き換えるため使用禁止。
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// イベント種別 → プッシュ文面・タップ先のマッピング（ホワイトリスト）
// ここに無いevent_keyはプッシュしない（ベル通知のみ）
const EVENT_MAP: Record<string, { app: string; word: string; url: string }> = {
  // 休暇申請（承認者の要対応）
  "leave:new_request":       { app: "休暇申請", word: "未承認", url: "/leave-approvals" },
  "leave:leader_approved":   { app: "休暇申請", word: "未承認", url: "/leave-approvals" },
  "leave:manager_approved":  { app: "休暇申請", word: "未承認", url: "/leave-approvals" },
  // 休暇申請（申請者の要対応）
  "leave:rejected":          { app: "休暇申請", word: "差戻", url: "/leave" },
  // 勤務変更申請
  "shift_report:new_request": { app: "勤務変更申請", word: "未承認", url: "/shift-report" },
  "shift_report:returned":    { app: "勤務変更申請", word: "差戻", url: "/shift-report" },
  // 備品精算（購入申請）
  "purchase_request:submitted":             { app: "備品精算", word: "未承認", url: "/purchase" },
  "purchase_request:submitted_manager":     { app: "備品精算", word: "未承認", url: "/purchase" },
  "purchase_request:submitted_board":       { app: "備品精算", word: "未承認", url: "/purchase" },
  "purchase_request:manager_opinions_ready": { app: "備品精算", word: "未承認", url: "/purchase" },
  "purchase_request:returned":              { app: "備品精算", word: "差戻", url: "/purchase" },
  // 交通費申請（経理の要対応）
  "expense:new_request":     { app: "交通費", word: "新着", url: "/admin" },
  // 連絡板
  "board:notice":           { app: "連絡板", word: "新着", url: "/board" },
  "board:group_message":    { app: "連絡板", word: "新着", url: "/board" },
  "board:dm_message":       { app: "連絡板", word: "新着", url: "/board" },
  "board:confirm_request":  { app: "連絡板", word: "新着", url: "/board" },
  // リマインド
  "reminder:unread:today":    { app: "連絡板", word: "本日期限", url: "/board" },
  "reminder:unread:tomorrow": { app: "連絡板", word: "明日期限", url: "/board" },
  "reminder:unread:later":    { app: "連絡板", word: "新着", url: "/board" },
  "reminder:scheduled":       { app: "リマインド", word: "新着", url: "/board" },
  "reminder:encouragement":   { app: "休暇申請", word: "新着", url: "/leave" },
};

// notification_settingsの参照キー（'reminder:unread:today'→'reminder:unread'）
function baseEventKey(eventKey: string): string {
  const parts = eventKey.split(":");
  return parts.slice(0, 2).join(":");
}

serve(async (req) => {
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // サーバー間呼び出し（service_role）のみ許可
    // 鍵そのものの一致か、JWTのroleクレームがservice_roleであることを確認
    // （Vault保存の鍵とFunction環境変数の鍵は形式が異なることがあるため両対応）
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    let isServiceRole = token === SUPABASE_SERVICE_ROLE_KEY;
    if (!isServiceRole) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        isServiceRole = payload.role === "service_role";
      } catch { /* JWTでない場合はfalseのまま */ }
    }
    if (!isServiceRole) {
      return new Response(JSON.stringify({ error: "権限がありません" }), {
        status: 403, headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 送信待ちを取得（古い順・上限500）
    const { data: pending, error: qErr } = await supabase
      .from("push_queue")
      .select("id, user_id, event_key, retry_count")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(500);
    if (qErr) throw qErr;
    if (!pending || pending.length === 0) {
      return new Response(JSON.stringify({ sent: 0, skipped: 0, failed: 0, message: "送信待ちなし" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // イベント別ON/OFF設定（notification_settingsのchannel='push'）を取得
    const { data: settings } = await supabase
      .from("notification_settings")
      .select("event_key, enabled")
      .eq("channel", "push");
    const pushEnabled = new Map<string, boolean>(
      (settings ?? []).map((s: { event_key: string; enabled: boolean }) => [s.event_key, s.enabled])
    );

    // ユーザー×(アプリ名×状態語×URL) で集約
    type Group = { userId: string; app: string; word: string; url: string; ids: string[]; tagKey: string };
    const groups = new Map<string, Group>();
    const skippedIds: string[] = [];

    for (const row of pending) {
      const map = EVENT_MAP[row.event_key];
      const base = baseEventKey(row.event_key);
      // ホワイトリスト外、または管理画面でpush OFFに設定されたイベントはスキップ
      // （設定行が無いイベントはON扱い）
      if (!map || pushEnabled.get(base) === false) {
        skippedIds.push(row.id);
        continue;
      }
      const gKey = `${row.user_id}|${map.app}|${map.word}|${map.url}`;
      const g = groups.get(gKey);
      if (g) {
        g.ids.push(row.id);
      } else {
        groups.set(gKey, { userId: row.user_id, app: map.app, word: map.word, url: map.url, ids: [row.id], tagKey: base });
      }
    }

    if (skippedIds.length > 0) {
      await supabase.from("push_queue").update({ status: "skipped" }).in("id", skippedIds);
    }

    // グループごとに送信（send-push Edge Functionを再利用）
    let sent = 0;
    let failed = 0;
    for (const g of groups.values()) {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          user_ids: [g.userId],
          title: `ファイブM ${g.app}`,
          body: `${g.word} ${g.ids.length}件`,
          url: g.url,
          tag: g.tagKey,
        }),
      });
      const result = await res.json().catch(() => null);
      if (res.ok && result && result.failed === 0) {
        await supabase.from("push_queue")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .in("id", g.ids);
        sent += g.ids.length;
      } else {
        const errText = result ? JSON.stringify(result).slice(0, 300) : `HTTP ${res.status}`;
        // 3回失敗したら諦める（failed）、それまではpendingのまま次回リトライ
        const giveUp = pending.find(p => g.ids.includes(p.id) && p.retry_count >= 2);
        await supabase.from("push_queue")
          .update(giveUp
            ? { status: "failed", error: errText }
            : { error: errText, retry_count: (pending.find(p => p.id === g.ids[0])?.retry_count ?? 0) + 1 })
          .in("id", g.ids);
        failed += g.ids.length;
      }
    }

    // 7日より古い処理済み行を掃除
    await supabase.from("push_queue")
      .delete()
      .in("status", ["sent", "skipped"])
      .lt("created_at", new Date(Date.now() - 7 * 86400000).toISOString());

    console.log(`[push-dispatch] sent=${sent} skipped=${skippedIds.length} failed=${failed}`);
    return new Response(JSON.stringify({ sent, skipped: skippedIds.length, failed }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[push-dispatch] error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
