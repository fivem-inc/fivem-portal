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
// urgent: true を付けると、受信時間帯・休暇日のミュート判定を無視して常に送る。
//   付けるのは安否・緊急系のみ（災害時に「夜だから」で止めてはいけないもの）。
//   ⚠️ event_key が safety: で始まるものはコード側でも常に urgent 扱いにしている
//   （将来 safety 系のキーを足したとき、この印の付け忘れで夜間に止まる事故を防ぐ）
const EVENT_MAP: Record<string, { app: string; word: string; url: string; bell?: true; urgent?: true }> = {
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
  "safety:urgent":           { app: "ヘルプ", word: "新着", url: "/safety?open=summary", urgent: true },
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
  //    ベル通知と違い focus=<報告id> は付けられない（どの1件を指すか決まらない）。
  //    そのため bell: true を付けて、着地後に🔔ベル一覧を開き該当行を光らせる（2026-08-24）。
  //    履歴タブには他の人の報告も並ぶので、これが無いと「どれが新着か分からない」になる。
  // ⚠️「出張報告」は実機未検証の語。Chromeが警告表示に化けたら app を検証済みの語に変える
  "trip:report_arrival":     { app: "出張報告", word: "新着", url: "/trip-report?tab=history", bell: true },
  "trip:report_end":         { app: "出張報告", word: "新着", url: "/trip-report?tab=history", bell: true },
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
  // 残業の受理まちリマインド（確認者へ日次）。
  // 「未承認」は実機テスト済みの安全語。着地は確認者ビュー（申請の中身がそこに全部あるので bell は付けない）
  "overtime:pending_review":     { app: "残業", word: "未承認", url: "/overtime?view=confirm" },
  // 同じ受理まちでも「勤務日より前に1回だけ」出す分。掃除の対象を分けるためキーを分けている
  "overtime:pending_review_advance": { app: "残業", word: "未承認", url: "/overtime?view=confirm" },
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
  "overtime:request_confirmed":  { app: "残業", word: "受理",   url: "/overtime?tab=history", bell: true },
  "overtime:confirmed":          { app: "残業", word: "受理",   url: "/overtime?tab=history", bell: true },
  "overtime:returned":           { app: "残業", word: "差戻",   url: "/overtime?tab=history", bell: true },
  // 本人が取り消した知らせ（確認者へ）。取消済みなので確認待ち一覧には無い。
  // ベルを開いて本文（誰が・いつの分か）を読んでもらう（2026-08-18 修正）
  "overtime:cancelled":          { app: "残業", word: "取消",   url: "/overtime?tab=history", bell: true },
  "overtime:admin_cancelled":    { app: "残業", word: "新着",   url: "/overtime?tab=history", bell: true },
  "overtime:admin_edited":       { app: "残業", word: "新着",   url: "/overtime?tab=history", bell: true },
  "overtime:grant":              { app: "残業", word: "新着",   url: "/overtime" },
  // 備品購入申請の質問・回答。履歴タブに着地し、該当カードが光る（reference_id＝申請id）
  "purchase_request:comment_added": { app: "備品精算", word: "新着", url: "/purchase?tab=history", bell: true },
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
      .select("id, user_id, event_key, retry_count, notification_ids, urgent")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(500);
    if (qErr) throw qErr;
    // ⚠️ 送信待ち0件でもここで early return しない。
    //    受信時間外に保留した直送プッシュ（push_deferred）の配達が後段にあるため
    const pendingRows = pending ?? [];

    // 受信時間帯・休暇日のミュート判定（本人設定 push_preferences）。
    // ミュート中の人の行は pending のまま「触らずに残す」→ 受信時間になった次の実行で
    // 自然に集約されて届く（statusもretry_countも変えない）。
    // 🚨 fail-open: RPCが失敗したら「誰もミュートしない」＝全部送る
    let mutedSet = new Set<string>();
    if (pendingRows.length > 0) {
      try {
        const userIds = [...new Set(pendingRows.map((r) => r.user_id))];
        const { data: muted, error: mutedErr } = await supabase.rpc("push_muted_user_ids", { p_user_ids: userIds });
        if (!mutedErr && Array.isArray(muted)) mutedSet = new Set(muted as string[]);
      } catch { /* fail-open */ }
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
    type Group = { userId: string; app: string; word: string; url: string; ids: string[]; tagKey: string; bell?: true; nids: string[] };
    const groups = new Map<string, Group>();
    const skippedIds: string[] = [];
    let held = 0; // 受信時間外で保留した件数（ログ用）
    // 追加送信（CC）用：base event_key → その本来の宛先user_id集合（二重送信を防ぐため）
    // 🚨 「この実行で実際に送る行」だけから作る。保留した行まで含めると、
    //    本来の宛先がミュート中のあいだCC役職に同じプッシュが1分毎に飛び続ける
    const primaryUsersByEvent = new Map<string, Set<string>>();

    for (const row of pendingRows) {
      const map = EVENT_MAP[row.event_key];
      const base = baseEventKey(row.event_key);
      // ホワイトリスト外、または管理画面でpush OFFに設定されたイベントはスキップ
      // （設定行が無いイベントはON扱い）
      if (!map || pushEnabled.get(base) === false) {
        skippedIds.push(row.id);
        continue;
      }
      // ミュート中の人の行は保留（pendingのまま次回に持ち越す）。
      // 緊急（行のurgent＝連絡板の「当日の連絡・緊急」／EVENT_MAPのurgent／safety系）は保留しない
      const isUrgent = row.urgent === true || map.urgent === true || row.event_key.startsWith("safety:");
      if (!isUrgent && mutedSet.has(row.user_id)) {
        held++;
        continue;
      }
      const gKey = `${row.user_id}|${map.app}|${map.word}|${map.url}`;
      const g = groups.get(gKey);
      const rowNids = (row.notification_ids ?? []) as string[];
      if (g) {
        g.ids.push(row.id);
        g.nids.push(...rowNids);
      } else {
        groups.set(gKey, { userId: row.user_id, app: map.app, word: map.word, url: map.url, ids: [row.id], tagKey: base, bell: map.bell, nids: [...rowNids] });
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
          // bell が付いているイベントは、押したときに着地画面で🔔ベル一覧を開いて
          // 該当行を光らせる（プッシュの文面には中身が書けないため、内容はベルで読んでもらう）。
          // nids はその「該当行」を特定するためのベル通知ID。新しい順に20件まで
          url: addParams(g.url, g.bell && g.nids.length > 0
            ? { nids: [...new Set(g.nids)].slice(-20).join(","), bell: "1" }
            : {}),
          tag: g.tagKey,
          // キュー側でミュート判定・保留済みなので、send-push側の二重判定を止める
          // （付け忘れると保留解除後の配達がまた push_deferred に落ちて無限に届かない）
          skip_quiet_check: true,
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
          const rc = pendingRows.find(p => p.id === id)?.retry_count ?? 0;
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
      // ⚠️ CCには skip_quiet_check を付けない（意図的）。
      //    CC宛先はベル通知を持たないため、ミュート中の人の分を捨てると
      //    どの経路でもその連絡を知り得なくなる。send-push側の判定に任せて
      //    push_deferred に保留し、受信時間になったら届ける
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

    // ── 保留分（push_deferred）の配達 ──────────────────────────
    // 直送経路（send-pushを直接呼ぶ関数・CC送信）でミュート中だった人の分。
    // 受信時間になった人の分だけ配達する。
    let deferredSent = 0;
    {
      const { data: defRows } = await supabase
        .from("push_deferred")
        .select("id, user_id, payload")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(500);
      const deferred = (defRows ?? []) as { id: string; user_id: string; payload: { title: string; body: string; url: string; tag: string } }[];
      if (deferred.length > 0) {
        // まだミュート中の人の分は残す
        let stillMuted = new Set<string>();
        try {
          const defUserIds = [...new Set(deferred.map((d) => d.user_id))];
          const { data: muted, error: mutedErr } = await supabase.rpc("push_muted_user_ids", { p_user_ids: defUserIds });
          if (!mutedErr && Array.isArray(muted)) stillMuted = new Set(muted as string[]);
        } catch { /* fail-open（＝配達する） */ }

        // 同一 user×tag は「最後の1件だけ」送る。Webプッシュは同じtagで端末上書きされる
        // ため全部送っても最後の1件しか残らない（古い方は sent 扱いで片付ける）。
        // ⚠️ 古い方を pending に残すと毎分再判定され続けるので必ず片付けること
        const latestByUserTag = new Map<string, { id: string; user_id: string; payload: { title: string; body: string; url: string; tag: string } }>();
        const supersededIds: string[] = [];
        for (const d of deferred) {
          if (stillMuted.has(d.user_id)) continue;
          const key = `${d.user_id}|${d.payload?.tag ?? ""}`;
          const prev = latestByUserTag.get(key);
          if (prev) supersededIds.push(prev.id); // 古い順に走査しているので、前の行は上書きされる側
          latestByUserTag.set(key, d);
        }
        if (supersededIds.length > 0) {
          await supabase.from("push_deferred")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .in("id", supersededIds);
        }
        for (const d of latestByUserTag.values()) {
          const res = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
            body: JSON.stringify({
              user_ids: [d.user_id],
              title: d.payload.title,
              body: d.payload.body,
              url: d.payload.url,
              tag: d.payload.tag,
              skip_quiet_check: true, // 再判定して push_deferred に戻る無限ループを防ぐ
            }),
          });
          const result = await res.json().catch(() => null);
          if (res.ok && result && result.failed === 0) {
            await supabase.from("push_deferred")
              .update({ status: "sent", sent_at: new Date().toISOString() })
              .eq("id", d.id);
            deferredSent++;
          }
          // 失敗時は pending のまま次回リトライ（7日超で掃除される）
        }
      }
    }

    // 7日より古い処理済み行を掃除
    await supabase.from("push_queue")
      .delete()
      .in("status", ["sent", "skipped"])
      .lt("created_at", new Date(Date.now() - 7 * 86400000).toISOString());
    // 保留置き場も掃除。pending も7日で消す（ずっと受信時間にならない設定のままの安全弁。
    // ベル・メールには残っているので情報は失われない）
    await supabase.from("push_deferred")
      .delete()
      .lt("created_at", new Date(Date.now() - 7 * 86400000).toISOString());

    console.log(`[push-dispatch] sent=${sent} cc=${ccSent} held=${held} deferredSent=${deferredSent} skipped=${skippedIds.length} failed=${failed}`);
    return new Response(JSON.stringify({ sent, cc: ccSent, held, deferredSent, skipped: skippedIds.length, failed }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[push-dispatch] error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
