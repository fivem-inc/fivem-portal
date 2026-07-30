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
  // ⚠️ タブ指定を省くと既定タブ（報告の入力）に着地して「何を見ればいいか分からない」になる
  "shift_report:new_request": { app: "勤務変更報告", word: "未承認", url: "/shift-report?view=confirm" },
  "shift_report:returned":    { app: "勤務変更報告", word: "差戻", url: "/shift-report?tab=history" },
  // 備品精算（購入申請）
  // ⚠️ /purchase の既定タブは「💰 精算」なので、タブを指定しないと必ず精算入力に着地する
  "purchase_request:submitted":             { app: "備品精算", word: "未承認", url: "/purchase?tab=approvals" },
  "purchase_request:submitted_manager":     { app: "備品精算", word: "未承認", url: "/purchase?tab=approvals" },
  "purchase_request:submitted_board":       { app: "備品精算", word: "未承認", url: "/purchase?tab=approvals" },
  "purchase_request:manager_opinions_ready": { app: "備品精算", word: "未承認", url: "/purchase?tab=approvals" },
  "purchase_request:returned":              { app: "備品精算", word: "差戻", url: "/purchase?tab=history" },
  // 結果報告系（申請者・共有先へ）＝自分の申請の状況を見る画面へ
  "purchase_request:leader_approved":       { app: "備品精算", word: "承認", url: "/purchase?tab=history" },
  "purchase_request:manager_approved":      { app: "備品精算", word: "承認", url: "/purchase?tab=history" },
  "purchase_request:board_all_approved":    { app: "備品精算", word: "承認", url: "/purchase?tab=history" },
  "purchase_request:self_judgment_shared":  { app: "備品精算", word: "新着", url: "/purchase?tab=history" },
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
  // 社内お知らせ（作成時の連絡・終了日が近づいたリマインド）
  // word は安全語ホワイトリスト（新着）のみ。自由文は Android で警告表示に化けるため不可。
  "announcement:new":         { app: "お知らせ", word: "新着", url: "/" },
  "announcement:remind":      { app: "お知らせ", word: "新着", url: "/" },
  // 残業調整の提案（相手＝受信／提案者＝回答通知）。安全語「新着」のみ・催促しない。
  "overtime_proposal:received":  { app: "残業調整", word: "新着", url: "/overtime" },
  "overtime_proposal:responded": { app: "残業調整", word: "新着", url: "/overtime" },
  // 残業の実績未報告リマインド（本人へ日次・安全語「新着」）
  "overtime:unreported":         { app: "残業", word: "新着", url: "/overtime" },
  // 残業・時間管理の承認フロー系。
  // word は実機テスト済みの安全語のみ（未承認／差戻／新着）。「承認」「受理」は未検証のため使わない。
  // 受理・取消・修正の結果報告は区別せず「新着」に寄せる（詳細はベル・画面で見る前提）。
  "overtime:new_request":        { app: "残業", word: "未承認", url: "/overtime?view=confirm" },
  "overtime:request_confirmed":  { app: "残業", word: "新着",   url: "/overtime?tab=history" },
  "overtime:confirmed":          { app: "残業", word: "新着",   url: "/overtime?tab=history" },
  "overtime:returned":           { app: "残業", word: "差戻",   url: "/overtime?tab=history" },
  "overtime:cancelled":          { app: "残業", word: "新着",   url: "/overtime?view=confirm" },
  "overtime:admin_cancelled":    { app: "残業", word: "新着",   url: "/overtime?tab=history" },
  "overtime:admin_edited":       { app: "残業", word: "新着",   url: "/overtime?tab=history" },
  "overtime:grant":              { app: "残業", word: "新着",   url: "/overtime" },
  "overtime:grant_declined":     { app: "残業", word: "新着",   url: "/overtime" },
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

    // イベント別ON/OFF設定・追加送信先役職（notification_settingsのchannel='push'）を取得
    const { data: settings } = await supabase
      .from("notification_settings")
      .select("event_key, enabled, recipient")
      .eq("channel", "push");
    const pushEnabled = new Map<string, boolean>();
    const ccRolesByEvent = new Map<string, string[]>();
    for (const s of (settings ?? []) as { event_key: string; enabled: boolean; recipient: string | null }[]) {
      pushEnabled.set(s.event_key, s.enabled);
      try {
        const p = JSON.parse(s.recipient ?? "{}");
        if (Array.isArray(p.ccRoles) && p.ccRoles.length > 0) ccRolesByEvent.set(s.event_key, p.ccRoles);
      } catch { /* recipientが役職設定でない場合は無視 */ }
    }

    // ユーザー×(アプリ名×状態語×URL) で集約
    type Group = { userId: string; app: string; word: string; url: string; ids: string[]; tagKey: string };
    const groups = new Map<string, Group>();
    const skippedIds: string[] = [];
    // 追加送信（CC）用：base event_key → その本来の宛先user_id集合（二重送信を防ぐため）
    const primaryUsersByEvent = new Map<string, Set<string>>();

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
      if (!primaryUsersByEvent.has(base)) primaryUsersByEvent.set(base, new Set());
      primaryUsersByEvent.get(base)!.add(row.user_id);
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

    // 追加送信（CC）：管理画面で「追加でプッシュする役職」を設定したイベントは、
    // 本来の宛先に加えてその役職の人にも同じプッシュを送る（設定が空なら何もしない）。
    // CC送信の成否はpush_queueのstatusには影響させない（本来の宛先送信が主）。
    let ccSent = 0;
    for (const [base, roles] of ccRolesByEvent.entries()) {
      const map = EVENT_MAP[base];
      if (!map || pushEnabled.get(base) === false) continue;
      // このバッチにそのイベントが無ければCCも送らない
      const primaryUsers = primaryUsersByEvent.get(base);
      if (!primaryUsers || primaryUsers.size === 0) continue;

      const { data: roleProfiles } = await supabase
        .from("profiles").select("id").in("role_title", roles).eq("is_active", true);
      const roleIds = ((roleProfiles ?? []) as { id: string }[]).map(p => p.id);
      // 本来の宛先と重複する人は除く（二重送信防止）
      const ccIds = roleIds.filter(id => !primaryUsers.has(id));
      if (ccIds.length === 0) continue;

      // 購読者だけに絞る
      const { data: subs } = await supabase
        .from("push_subscriptions").select("user_id").in("user_id", ccIds);
      const ccPushIds = [...new Set(((subs ?? []) as { user_id: string }[]).map(s => s.user_id))];
      if (ccPushIds.length === 0) continue;

      const count = primaryUsers.size;
      const res = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
        body: JSON.stringify({
          user_ids: ccPushIds,
          title: `ファイブM ${map.app}`,
          body: `${map.word} ${count}件`,
          url: map.url,
          tag: `cc-${base}`,
        }),
      });
      if (res.ok) ccSent += ccPushIds.length;
    }

    // 7日より古い処理済み行を掃除
    await supabase.from("push_queue")
      .delete()
      .in("status", ["sent", "skipped"])
      .lt("created_at", new Date(Date.now() - 7 * 86400000).toISOString());

    console.log(`[push-dispatch] sent=${sent} cc=${ccSent} skipped=${skippedIds.length} failed=${failed}`);
    return new Response(JSON.stringify({ sent, cc: ccSent, skipped: skippedIds.length, failed }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[push-dispatch] error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
