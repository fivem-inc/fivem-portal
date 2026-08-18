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

// URLにパラメータを足す（?の有無を自動で判断する）
function addParams(url: string, params: Record<string, string>): string {
  const parts = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  if (parts.length === 0) return url;
  return url + (url.includes("?") ? "&" : "?") + parts.join("&");
}

// イベント種別 → プッシュ文面・タップ先のマッピング（ホワイトリスト）
// ここに無いevent_keyはプッシュしない（ベル通知のみ）
//
// bell: true を付けると、押したとき着地画面で🔔ベル一覧が自動で開き、該当行が黄色く光る。
//   付けるのは「知らせ・結果」＝中身が通知の文章にしかないもの（受理されました等）。
//   付けないのは ①要対応（着地画面に申請の中身が全部ある）②ホームに専用バナーがあるもの
//   ③連絡板（開けば未読が見える）④安否・緊急（災害時にベルを挟まない）。
const EVENT_MAP: Record<string, { app: string; word: string; url: string; bell?: true }> = {
  // 休暇申請（承認者の要対応）
  "leave:new_request":       { app: "休暇申請", word: "未承認", url: "/leave-approvals" },
  "leave:leader_approved":   { app: "休暇申請", word: "未承認", url: "/leave-approvals" },
  // 🚨 マネージャー受理は「申請者本人への結果報告」。承認者向けの通知ではない。
  // 「未承認」だと受理されたのに未処理と読めてしまい、/leave-approvals は
  // 申請者が開いても自分の申請が無い（権限が無ければ何も見えない）ため両方とも誤りだった。
  // word は実機テスト済みの安全語のみ（「受理」「承認」は 2026-08-18 に実機確認済み）
  "leave:manager_approved":  { app: "休暇申請", word: "受理", url: "/leave?tab=history", bell: true },
  // 休暇申請（申請者の要対応）
  // ⚠️ /leave の既定タブは申請フォーム。tab=history を省くと白紙の入力画面に着地する
  "leave:rejected":          { app: "休暇申請", word: "差戻", url: "/leave?tab=history", bell: true },
  // 安否確認：「助けが必要」の回答が入ったとき（発信者＋マネージャー以上へ）
  // 「ヘルプ」は 2026-08-04 に実機テスト済み（Chromeの警告表示に化けないことを確認）。
  // ⚠️ 化けるようになったら app を "安否"（検証済み）に戻すこと。ここ1行で切り替わる。
  // ⚠️ 本文に名前や文章を入れない。文章形はNG確定で、画面ロック中に他人へ見えるため。
  //    誰が助けを求めているかはタップ先の集計画面で確認する。
  "safety:urgent":           { app: "ヘルプ", word: "新着", url: "/safety?open=summary" },
  // 勤務変更申請
  // ⚠️ タブ指定を省くと既定タブ（報告の入力）に着地して「何を見ればいいか分からない」になる
  "shift_report:new_request": { app: "勤務変更報告", word: "未承認", url: "/shift-report?view=confirm" },
  "shift_report:returned":    { app: "勤務変更報告", word: "差戻", url: "/shift-report?tab=history", bell: true },
  // 備品精算（購入申請）
  // ⚠️ /purchase の既定タブは「💰 精算」なので、タブを指定しないと必ず精算入力に着地する
  "purchase_request:submitted":             { app: "備品精算", word: "未承認", url: "/purchase?tab=approvals" },
  "purchase_request:submitted_manager":     { app: "備品精算", word: "未承認", url: "/purchase?tab=approvals" },
  "purchase_request:submitted_board":       { app: "備品精算", word: "未承認", url: "/purchase?tab=approvals" },
  "purchase_request:manager_opinions_ready": { app: "備品精算", word: "未承認", url: "/purchase?tab=approvals" },
  // 審議中の回覧（他のマネージャーが意見を出した／否認が出た）。まだ全員の回答が揃っていないので
  // 「未承認」ではなく「審議」。2026-08-18 に社長端末で実機確認済みの語
  "purchase_request:opinion_submitted":      { app: "備品精算", word: "審議", url: "/purchase?tab=approvals" },
  "purchase_request:returned":              { app: "備品精算", word: "差戻", url: "/purchase?tab=history", bell: true },
  // 結果報告系（申請者・共有先へ）＝自分の申請の状況を見る画面へ
  // 「承認」は 2026-08-18 に社長端末で実機確認済み（Chromeの警告表示に化けない）
  "purchase_request:leader_approved":       { app: "備品精算", word: "承認", url: "/purchase?tab=history", bell: true },
  "purchase_request:manager_approved":      { app: "備品精算", word: "承認", url: "/purchase?tab=history", bell: true },
  "purchase_request:board_all_approved":    { app: "備品精算", word: "承認", url: "/purchase?tab=history", bell: true },
  "purchase_request:self_judgment_shared":  { app: "備品精算", word: "新着", url: "/purchase?tab=history", bell: true },
  // 交通費申請（経理の要対応）
  "expense:new_request":     { app: "交通費", word: "新着", url: "/admin" },
  // 出張報告（到着・終了）。2026-08-09 にスタッフ側へ履歴タブを新設したので、
  // ホーム着地（＝ベルで見てもらう）をやめて履歴タブに直接着地させる。
  // ⚠️ 履歴タブは「出張報告の履歴閲覧」権限が要る。宛先の役職を足すときは
  //    管理画面でこの権限も同じ役職をONにすること（OFFのままだとフォームに着地する）。
  // ⚠️ プッシュは「ユーザー×イベント」で集約して1通にまとめるため、
  //    ベル通知と違い focus=<報告id> は付けられない＝該当カードは光らない（一覧の先頭が最新）。
  // ⚠️「出張報告」は実機未検証の語。Chromeが警告表示に化けたら app を検証済みの語に変える
  "trip:report_arrival":     { app: "出張報告", word: "新着", url: "/trip-report?tab=history" },
  "trip:report_end":         { app: "出張報告", word: "新着", url: "/trip-report?tab=history" },
  // 連絡板
  "board:notice":           { app: "連絡板", word: "新着", url: "/board" },
  "board:group_message":    { app: "連絡板", word: "新着", url: "/board" },
  "board:dm_message":       { app: "連絡板", word: "新着", url: "/board" },
  "board:confirm_request":  { app: "連絡板", word: "新着", url: "/board" },
  // リマインド
  "reminder:unread:today":    { app: "連絡板", word: "本日期限", url: "/board" },
  "reminder:unread:tomorrow": { app: "連絡板", word: "明日期限", url: "/board" },
  "reminder:unread:later":    { app: "連絡板", word: "新着", url: "/board" },
  // 定期リマインドは特定のメッセージを指していないため連絡板に飛ばしても何も無い。
  // ホームに専用バナー（ScheduledReminderBanner）があるのでそちらへ着地させる（2026-08-18 修正）
  "reminder:scheduled":       { app: "リマインド", word: "新着", url: "/" },
  "reminder:encouragement":   { app: "休暇申請", word: "新着", url: "/leave" },
  // 社内お知らせ（作成時の連絡・終了日が近づいたリマインド）
  // word は安全語ホワイトリスト（新着）のみ。自由文は Android で警告表示に化けるため不可。
  "announcement:new":         { app: "お知らせ", word: "新着", url: "/" },
  "announcement:remind":      { app: "お知らせ", word: "新着", url: "/" },
  // 残業調整の提案（相手＝受信／提案者＝回答通知）。安全語「新着」のみ・催促しない。
  // 🚨 提案の回答画面は /overtime?proposal=<id> の専用ビューだけで、受信一覧が存在しない。
  //    プッシュはIDを持てない（集約するため）ので、ホームのバナーから開いてもらう（2026-08-18 修正）
  "overtime_proposal:received":  { app: "残業調整", word: "新着", url: "/" },
  // 提案者への回答通知。こちらも提案画面にIDなしでは入れないため、ベルを開いて本文を読む
  "overtime_proposal:responded": { app: "残業調整", word: "新着", url: "/overtime", bell: true },
  // 残業の実績未報告リマインド（本人へ日次・安全語「新着」）
  // ⚠️ /overtime の既定タブは「申請・報告」の入力フォーム。tab=history を省くと
  //    「実績を報告してください」の知らせなのに、報告する場所（履歴タブ）ではなく
  //    新規申請の入力画面に着地する。ベル側（App.tsx）は tab=history で正しかった。
  "overtime:unreported":         { app: "残業", word: "新着", url: "/overtime?tab=history" },
  // 残業がしきい値を超えたお知らせ。他人の残業申請が回ってきたのと区別できるよう
  // アプリ名を「残業」と分けている。
  // 「勤務時間」は 2026-08-04 に実機確認済み（警告表示に化けない）
  "overtime:threshold":          { app: "勤務時間", word: "新着", url: "/overtime?tab=history" },
  // 上長向けの部門まとめ。本人向けと同じ event_key を使っていたため上長が自分の履歴に
  // 着地していた（2026-08-18 修正）。飛び先はベル側（classifyNotif）と揃えてある
  "overtime:threshold_summary":  { app: "勤務時間", word: "新着", url: "/overtime?tab=history&mode=summary" },
  // 残業・時間管理の承認フロー系。
  // word は実機テスト済みの安全語のみ（未承認／差戻／新着／受理／承認。受理・承認は 2026-08-18 確認）。
  // 取消・修正の結果報告は区別せず「新着」に寄せる（詳細はベル・画面で見る前提）。
  "overtime:new_request":        { app: "残業", word: "未承認", url: "/overtime?view=confirm" },
  "overtime:request_confirmed":  { app: "残業", word: "受理",   url: "/overtime?tab=history" },
  "overtime:confirmed":          { app: "残業", word: "受理",   url: "/overtime?tab=history" },
  "overtime:returned":           { app: "残業", word: "差戻",   url: "/overtime?tab=history" },
  // 本人が取り消した知らせ（確認者へ）。取消済みなので確認待ち一覧には無い。
  // ベルを開いて本文（誰が・いつの分か）を読んでもらう（2026-08-18 修正）
  "overtime:cancelled":          { app: "残業", word: "取消",   url: "/overtime?tab=history", bell: true },
  "overtime:admin_cancelled":    { app: "残業", word: "新着",   url: "/overtime?tab=history" },
  "overtime:admin_edited":       { app: "残業", word: "新着",   url: "/overtime?tab=history" },
  "overtime:grant":              { app: "残業", word: "新着",   url: "/overtime" },
  // 備品購入申請の質問・回答。履歴タブに着地し、該当カードが光る（reference_id＝申請id）
  "purchase_request:comment_added": { app: "備品精算", word: "新着", url: "/purchase?tab=history" },
  // 打刻の確認（経理→本人／本人→経理）。アプリ名「勤務時間」は実機テスト済み（2026-08-04・林の端末）
  // 🚨 回答画面は /overtime?inquiry=<id> の専用ビューでしか開けず、履歴タブに一覧は無い。
  //    プッシュはIDを持てない（集約するため）ので、ホームの専用バナーから開いてもらう（2026-08-18 修正）
  "overtime:clock_inquiry":          { app: "勤務時間", word: "新着", url: "/" },
  "overtime:clock_inquiry_answered": { app: "勤務時間", word: "新着", url: "/admin?tab=overtime_admin&section=inquiries" },
  "overtime:grant_declined":     { app: "残業", word: "新着",   url: "/overtime" },
  // 修正依頼・取消依頼（correction_requests のRPCがベル通知を作る）
  // ⚠️ app名に「依頼」「確認」は使わない（Chromeが不正な通知と判定する実機テスト済みNG語）。
  //    「修正」は未検証の新語＝実機で警告が出たら app を「お知らせ」等の検証済み語に変える。
  // new=管理者の要対応→管理画面の修正依頼タブへ／resolved・declined=本人への結果→ホーム（ベルで詳細を見る）
  "correction:new":      { app: "修正", word: "新着", url: "/admin?tab=corrections" },
  "correction:resolved": { app: "修正", word: "新着", url: "/" },
  "correction:declined": { app: "修正", word: "新着", url: "/" },
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
        // 3回失敗したら諦める（failed）、それまではpendingのまま次回リトライ。
        // ⚠️ 判定は必ず「1件ずつ」行う。グループ一括で判定すると、グループ内の1件が
        //    上限に達しただけで、まだ再送できる残りの件まで failed になる（実際に起きたバグ）。
        const giveUpIds: string[] = [];
        const retryRows: { id: string; retryCount: number }[] = [];
        for (const id of g.ids) {
          const rc = pending.find(p => p.id === id)?.retry_count ?? 0;
          if (rc >= 2) giveUpIds.push(id);
          else retryRows.push({ id, retryCount: rc + 1 });
        }
        if (giveUpIds.length > 0) {
          await supabase.from("push_queue")
            .update({ status: "failed", error: errText })
            .in("id", giveUpIds);
        }
        // retry_count は行ごとに値が違うため1件ずつ更新する（グループは小さいので往復数は問題にならない）
        for (const r of retryRows) {
          await supabase.from("push_queue")
            .update({ error: errText, retry_count: r.retryCount })
            .eq("id", r.id);
        }
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
