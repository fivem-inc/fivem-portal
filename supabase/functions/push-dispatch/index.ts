// プッシュ通知パイプラインのワーカー
//
// pg_cron（1分毎）から呼ばれ、push_queueの送信待ちを
// 「ユーザー×イベント種別」で集約して固定の安全文面で送信する。
//
// 文面ルール（2026-09-09 実機テストで全面的に見直した）:
//   本文は EVENT_MAP の text（意味の通る文章）を使い、2件以上なら末尾に「（3件）」を付ける。
//
//   🚨 2026-09-09 の実測（社長端末＝Android Chrome・20通を1通ずつ確認）:
//     旧ルールの「NG確定」とされていた語（確認／依頼／〜待ち／文章形）が **すべて表示された**。
//     2026-07-11 当時の判定は、いまの Chrome では成り立っていない。
//     ただし挙動が変わった以上 **また戻る可能性がある** ため、
//     短い状態語（word）を消さずに残し、環境変数 PUSH_SENTENCE=0 で旧方式へ戻せるようにしてある。
//     🚨 新しい文面を使うときは、これまでどおり社長端末へ1通ずつ試すこと。
//
//   🚨 文章にできても、個人名・金額・申請の中身は入れない。
//     プッシュはロック画面に出るため、そばにいる人に見える（方針は変えていない）。
//     例外は社内お知らせの件名だけで、これは書いた人が1件ごとにON/OFFを選ぶ。

// 文章モードで送るか（既定ON）。万一 Chrome の判定が戻ったら
// Function の環境変数に PUSH_SENTENCE=0 を入れるだけで、旧来の「状態語 + 件数」に戻る。
const USE_SENTENCE = (Deno.env.get("PUSH_SENTENCE") ?? "1") !== "0";

// プッシュ本文を組み立てる。1件のときは件数を出さない（「（1件）」は読み手に意味が無いため）
function buildBody(text: string, word: string, count: number): string {
  if (!USE_SENTENCE) return `${word} ${count}件`;
  return count >= 2 ? `${text}（${count}件）` : text;
}
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
const EVENT_MAP: Record<string, { app: string; word: string; text: string; url: string; bell?: true; urgent?: true }> = {
  // 休暇申請（承認者の要対応）
  "leave:new_request":       { app: "休暇申請", word: "未承認", text: "休暇申請が届いています", url: "/leave-approvals" },
  "leave:leader_approved":   { app: "休暇申請", word: "未承認", text: "休暇申請が届いています", url: "/leave-approvals" },
  // 🚨 マネージャー受理は「申請者本人への結果報告」。承認者向けの通知ではない。
  // 「未承認」だと受理されたのに未処理と読めてしまい、/leave-approvals は
  // 申請者が開いても自分の申請が無い（権限が無ければ何も見えない）ため両方とも誤りだった。
  // word は実機テスト済みの安全語のみ（「受理」「承認」は 2026-08-18 に実機確認済み）
  "leave:manager_approved":  { app: "休暇申請", word: "受理", text: "休暇申請が受理されました", url: "/leave?tab=history", bell: true },
  // 🚨 2026-09-09 追加。ここに無い event_key はプッシュされない（ベルだけ出て静かに欠ける）。
  //    シフト調整がまだの休暇のお知らせ（上長あて）。押すと勤怠カレンダーのその日に飛ぶ。
    // 中身（誰が・いつ休むか）は着地画面で見るので bell は付けない。
  //    🚨 飛び先は「未調整だけで絞った状態」。絞らずに着地すると、ひと月ぶんの一覧から
  //       自分で探すことになり、何をすればよいか分からない（2026-09-09 ユーザー指示）。
  //       同じ着地を App.tsx の classifyNotif にも書いてある。片方だけ直さないこと。
  "leave:shift_adjust_due":  { app: "休暇申請", word: "未調整", text: "シフト調整がまだの休暇があります", url: "/calendar?shift=pending&view=fyi" },
  // 申請の依頼（上長 → 本人）。押すと残業ページが開く。
  // 🚨 文言は「検証済み語」だけを使う（引き継ぎアーカイブ「検証済み語」を参照）。
  //    「依頼」単独・「確認」を含む語・文章形は NG確定。新しい語は社長端末に1通テストしてから使う。
  //    🚨 2026-09-09 実機で確認済み：アプリ名「申請依頼」／状態語「未調整」はどちらも化けずに表示された
  //       （1通目でタイトル＋本文、2通目でタイトルだけを切り分けて確認）。
  "application_request:received": { app: "申請依頼", word: "新着", text: "申請の依頼が届いています", url: "/overtime?tab=history" },
  // 休暇申請（申請者の要対応）
  // ⚠️ /leave の既定タブは申請フォーム。tab=history を省くと白紙の入力画面に着地する
  "leave:rejected":          { app: "休暇申請", word: "差戻", text: "休暇申請が差し戻されました", url: "/leave?tab=history", bell: true },
  // 安否確認：「助けが必要」の回答が入ったとき（発信者＋マネージャー以上へ）
  // 「ヘルプ」は 2026-08-04 に実機テスト済み（Chromeの警告表示に化けないことを確認）。
  // ⚠️ 化けるようになったら app を "安否"（検証済み）に戻すこと。ここ1行で切り替わる。
  // ⚠️ 本文に名前や文章を入れない。文章形はNG確定で、画面ロック中に他人へ見えるため。
  //    誰が助けを求めているかはタップ先の集計画面で確認する。
  "safety:urgent":           { app: "ヘルプ", word: "新着", text: "助けが必要との回答があります", url: "/safety?open=summary", urgent: true },
  // 勤務変更申請
  // ⚠️ タブ指定を省くと既定タブ（報告の入力）に着地して「何を見ればいいか分からない」になる
  "shift_report:new_request": { app: "勤務変更報告", word: "未承認", text: "勤務変更報告が届いています", url: "/shift-report?view=confirm" },
  "shift_report:returned":    { app: "勤務変更報告", word: "差戻", text: "勤務変更報告が差し戻されました", url: "/shift-report?tab=history", bell: true },
  // 🚨 2026-09-09 追加。ベルには出ていたのに EVENT_MAP に無く、スマホに届いていなかった
  //    （実データで4件確認）。何を直されたかはベルの本文にしかないので bell を付ける。
  "shift:admin_edited":       { app: "勤務変更報告", word: "新着", text: "管理者が勤務変更報告を修正しました", url: "/shift-report?tab=history", bell: true },
  // 備品精算（購入申請）
  // ⚠️ /purchase の既定タブは「💰 精算」なので、タブを指定しないと必ず精算入力に着地する
  "purchase_request:submitted":             { app: "備品精算", word: "未承認", text: "備品購入申請が届いています", url: "/purchase?tab=approvals" },
  "purchase_request:submitted_manager":     { app: "備品精算", word: "未承認", text: "備品購入申請が届いています", url: "/purchase?tab=approvals" },
  "purchase_request:submitted_board":       { app: "備品精算", word: "未承認", text: "備品購入申請が届いています", url: "/purchase?tab=approvals" },
  "purchase_request:manager_opinions_ready": { app: "備品精算", word: "未承認", text: "備品購入申請が届いています", url: "/purchase?tab=approvals" },
  // 審議中の回覧（他のマネージャーが意見を出した／否認が出た）。まだ全員の回答が揃っていないので
  // 「未承認」ではなく「審議」。2026-08-18 に社長端末で実機確認済みの語
  "purchase_request:opinion_submitted":      { app: "備品精算", word: "審議", text: "備品購入申請の審議が進んでいます", url: "/purchase?tab=approvals" },
  "purchase_request:returned":              { app: "備品精算", word: "差戻", text: "備品購入申請が差し戻されました", url: "/purchase?tab=history", bell: true },
  // 結果報告系（申請者・共有先へ）＝自分の申請の状況を見る画面へ
  // 「承認」は 2026-08-18 に社長端末で実機確認済み（Chromeの警告表示に化けない）
  "purchase_request:leader_approved":       { app: "備品精算", word: "承認", text: "備品購入申請が承認されました", url: "/purchase?tab=history", bell: true },
  "purchase_request:manager_approved":      { app: "備品精算", word: "承認", text: "備品購入申請が承認されました", url: "/purchase?tab=history", bell: true },
  "purchase_request:board_all_approved":    { app: "備品精算", word: "承認", text: "備品購入申請が承認されました", url: "/purchase?tab=history", bell: true },
  "purchase_request:self_judgment_shared":  { app: "備品精算", word: "新着", text: "自己判断での備品購入が共有されました", url: "/purchase?tab=history", bell: true },
  // 交通費申請（経理の要対応）
  "expense:new_request":     { app: "交通費", word: "新着", text: "交通費申請が届いています", url: "/admin" },
  // 出張報告（到着・終了）。2026-08-09 にスタッフ側へ履歴タブを新設したので、
  // ホーム着地（＝ベルで見てもらう）をやめて履歴タブに直接着地させる。
  // ⚠️ 履歴タブは「出張報告の履歴閲覧」権限が要る。宛先の役職を足すときは
  //    管理画面でこの権限も同じ役職をONにすること（OFFのままだとフォームに着地する）。
  // ⚠️ プッシュは「ユーザー×イベント」で集約して1通にまとめるため、
  //    ベル通知と違い focus=<報告id> は付けられない（どの1件を指すか決まらない）。
  //    そのため bell: true を付けて、着地後に🔔ベル一覧を開き該当行を光らせる（2026-08-24）。
  //    履歴タブには他の人の報告も並ぶので、これが無いと「どれが新着か分からない」になる。
  // ⚠️「出張報告」は実機未検証の語。Chromeが警告表示に化けたら app を検証済みの語に変える
  "trip:report_arrival":     { app: "出張報告", word: "新着", text: "出張の到着報告が届いています", url: "/trip-report?tab=history", bell: true },
  "trip:report_end":         { app: "出張報告", word: "新着", text: "出張の終了報告が届いています", url: "/trip-report?tab=history", bell: true },
  // 連絡板
  "board:notice":           { app: "連絡板", word: "新着", text: "連絡板に新しい投稿があります", url: "/board" },
  "board:group_message":    { app: "連絡板", word: "新着", text: "連絡板に新しい投稿があります", url: "/board" },
  "board:dm_message":       { app: "連絡板", word: "新着", text: "連絡板に新しい投稿があります", url: "/board" },
  "board:confirm_request":  { app: "連絡板", word: "新着", text: "連絡板に新しい投稿があります", url: "/board" },
  // リマインド
  "reminder:unread:today":    { app: "連絡板", word: "本日期限", text: "連絡板に本日期限の未読があります", url: "/board" },
  "reminder:unread:tomorrow": { app: "連絡板", word: "明日期限", text: "連絡板に明日期限の未読があります", url: "/board" },
  "reminder:unread:later":    { app: "連絡板", word: "新着", text: "連絡板に未読があります", url: "/board" },
  // 定期リマインドは特定のメッセージを指していないため連絡板に飛ばしても何も無い。
  // ホームに専用バナー（ScheduledReminderBanner）があるのでそちらへ着地させる（2026-08-18 修正）
  "reminder:scheduled":       { app: "リマインド", word: "新着", text: "定期リマインドが届いています", url: "/" },
  "reminder:encouragement":   { app: "休暇申請", word: "新着", text: "有給奨励日の回答期限が近づいています", url: "/leave" },
  // 社内お知らせ（作成時の連絡・終了日が近づいたリマインド）
  // word は安全語ホワイトリスト（新着）のみ。自由文は Android で警告表示に化けるため不可。
  "announcement:new":         { app: "お知らせ", word: "新着", text: "社内お知らせが届いています", url: "/" },
  "announcement:remind":      { app: "お知らせ", word: "新着", text: "社内お知らせの期限が近づいています", url: "/" },
  // 残業調整の提案（相手＝受信／提案者＝回答通知）。安全語「新着」のみ・催促しない。
  // 🚨 提案の回答画面は /overtime?proposal=<id> の専用ビューだけで、受信一覧が存在しない。
  //    プッシュはIDを持てない（集約するため）ので、ホームのバナーから開いてもらう（2026-08-18 修正）
  "overtime_proposal:received":  { app: "残業調整", word: "新着", text: "残業調整の提案が届いています", url: "/" },
  // 提案者への回答通知。こちらも提案画面にIDなしでは入れないため、ベルを開いて本文を読む
  "overtime_proposal:responded": { app: "残業調整", word: "新着", text: "残業調整の提案に回答がありました", url: "/overtime", bell: true },
  // 残業の実績未報告リマインド（本人へ日次・安全語「新着」）
  // ⚠️ /overtime の既定タブは「申請・報告」の入力フォーム。tab=history を省くと
  //    「実績を報告してください」の知らせなのに、報告する場所（履歴タブ）ではなく
  //    新規申請の入力画面に着地する。ベル側（App.tsx）は tab=history で正しかった。
  "overtime:unreported":         { app: "残業", word: "新着", text: "残業の実績報告がまだです", url: "/overtime?tab=history" },
  // 残業の受理まちリマインド（確認者へ日次）。
  // 「未承認」は実機テスト済みの安全語。着地は確認者ビュー（申請の中身がそこに全部あるので bell は付けない）
  "overtime:pending_review":     { app: "残業", word: "未承認", text: "受理まちの残業申請があります", url: "/overtime?view=confirm" },
  // 同じ受理まちでも「勤務日より前に1回だけ」出す分。掃除の対象を分けるためキーを分けている
  "overtime:pending_review_advance": { app: "残業", word: "未承認", text: "受理まちの残業申請があります", url: "/overtime?view=confirm" },
  // 残業がしきい値を超えたお知らせ。他人の残業申請が回ってきたのと区別できるよう
  // アプリ名を「残業」と分けている。
  // 「勤務時間」は 2026-08-04 に実機確認済み（警告表示に化けない）
  "overtime:threshold":          { app: "勤務時間", word: "新着", text: "今月の残業が目安を超えています", url: "/overtime?tab=history" },
  // 上長向けの部門まとめ。本人向けと同じ event_key を使っていたため上長が自分の履歴に
  // 着地していた（2026-08-18 修正）。飛び先はベル側（classifyNotif）と揃えてある
  "overtime:threshold_summary":  { app: "勤務時間", word: "新着", text: "部門の残業が目安を超えています", url: "/overtime?tab=history&mode=summary" },
  // 残業・時間管理の承認フロー系。
  // word は実機テスト済みの安全語のみ（未承認／差戻／新着／受理／承認。受理・承認は 2026-08-18 確認）。
  // 取消・修正の結果報告は区別せず「新着」に寄せる（詳細はベル・画面で見る前提）。
  "overtime:new_request":        { app: "残業", word: "未承認", text: "残業の事前申請が届いています", url: "/overtime?view=confirm" },
  "overtime:request_confirmed":  { app: "残業", word: "受理", text: "残業の事前申請が受理されました",   url: "/overtime?tab=history", bell: true },
  "overtime:confirmed":          { app: "残業", word: "受理", text: "残業の実績が確認されました",   url: "/overtime?tab=history", bell: true },
  "overtime:returned":           { app: "残業", word: "差戻", text: "残業申請が差し戻されました",   url: "/overtime?tab=history", bell: true },
  // 本人が取り消した知らせ（確認者へ）。取消済みなので確認待ち一覧には無い。
  // ベルを開いて本文（誰が・いつの分か）を読んでもらう（2026-08-18 修正）
  "overtime:cancelled":          { app: "残業", word: "取消", text: "残業申請が取り消されました",   url: "/overtime?tab=history", bell: true },
  "overtime:admin_cancelled":    { app: "残業", word: "新着", text: "管理者が残業申請を取り消しました",   url: "/overtime?tab=history", bell: true },
  "overtime:admin_edited":       { app: "残業", word: "新着", text: "管理者が残業申請を修正しました",   url: "/overtime?tab=history", bell: true },
  "overtime:grant":              { app: "残業", word: "新着", text: "締め後の残業申請が許可されました",   url: "/overtime" },
  // 備品購入申請の質問・回答。履歴タブに着地し、該当カードが光る（reference_id＝申請id）
  "purchase_request:comment_added": { app: "備品精算", word: "新着", text: "備品購入申請に書き込みがあります", url: "/purchase?tab=history", bell: true },
  // 打刻の確認（経理→本人／本人→経理）。アプリ名「勤務時間」は実機テスト済み（2026-08-04・林の端末）
  // 🚨 回答画面は /overtime?inquiry=<id> の専用ビューでしか開けず、履歴タブに一覧は無い。
  //    プッシュはIDを持てない（集約するため）ので、ホームの専用バナーから開いてもらう（2026-08-18 修正）
  "overtime:clock_inquiry":          { app: "勤務時間", word: "新着", text: "打刻の確認が届いています", url: "/" },
  "overtime:clock_inquiry_answered": { app: "勤務時間", word: "新着", text: "打刻の確認に回答がありました", url: "/admin?tab=overtime_admin&section=inquiries" },
  "overtime:grant_declined":     { app: "残業", word: "新着", text: "締め後申請の許可が見送られました",   url: "/overtime" },
  // 修正依頼・取消依頼（correction_requests のRPCがベル通知を作る）
  // ⚠️ app名に「依頼」「確認」は使わない（Chromeが不正な通知と判定する実機テスト済みNG語）。
  //    「修正」は未検証の新語＝実機で警告が出たら app を「お知らせ」等の検証済み語に変える。
  // new=管理者の要対応→管理画面の修正依頼タブへ／resolved・declined=本人への結果→ホーム（ベルで詳細を見る）
  // 🚨 旧キー（2026-09-09 に種類ごとへ分ける前に作られた通知が持っている）。消さないこと。
  //    分けた理由：correction_requests は「修正依頼」と「取消依頼」の2種類を扱うのに
  //    キーが1つしかなく、取消依頼のときも「修正」と出ていた。
  "correction:new":      { app: "修正", word: "新着", text: "修正依頼が届いています", url: "/admin?tab=corrections" },
  "correction:resolved": { app: "修正", word: "新着", text: "修正依頼が対応済みになりました", url: "/" },
  "correction:declined": { app: "修正", word: "新着", text: "修正依頼が見送られました", url: "/" },
  // 修正依頼（request_kind = 'edit'）
  "correction:new_edit":       { app: "修正依頼", word: "新着", text: "修正依頼が届いています", url: "/admin?tab=corrections" },
  "correction:resolved_edit":  { app: "修正依頼", word: "新着", text: "修正依頼に対応がありました", url: "/" },
  "correction:declined_edit":  { app: "修正依頼", word: "新着", text: "修正依頼にお返事があります", url: "/" },
  // 取消依頼（request_kind = 'cancel'）
  "correction:new_cancel":      { app: "取消依頼", word: "新着", text: "取消依頼が届いています", url: "/admin?tab=corrections" },
  "correction:resolved_cancel": { app: "取消依頼", word: "新着", text: "取消依頼に対応がありました", url: "/" },
  "correction:declined_cancel": { app: "取消依頼", word: "新着", text: "取消依頼にお返事があります", url: "/" },
};

// 社内お知らせだけ、本文に「件名そのもの」を出せる（2026-09-09 ユーザー確定）。
// 🚨 出せるのは次の3つが揃ったときだけ。1つでも欠けたらふつうの文章に戻す。
//   ① 社内お知らせであること（連絡板は出さない。DMの用件がロック画面に出るため）
//   ② まとめが1件であること（2件を1つの件名では言えない）
//   ③ 書いた人が「件名を通知に出す」をONにしていること（announcements.push_show_title）
// 🚨 引けなかったときは黙って落とさず、ふつうの文章で送る（通知が消えるほうが困る）。
const TITLE_MAX = 60; // ロック画面で読めない長さは切る（末尾に…）

async function bodyForGroup(
  supabase: ReturnType<typeof createClient>,
  g: { app: string; word: string; text: string; ids: string[]; nids: string[]; tagKey: string },
): Promise<string> {
  const fallback = buildBody(g.text, g.word, g.ids.length);
  if (!USE_SENTENCE) return fallback;
  if (!g.tagKey.startsWith("announcement:")) return fallback;
  if (g.ids.length !== 1) return fallback;
  const nid = g.nids[0];
  if (!nid) return fallback;
  try {
    const { data: notif } = await supabase
      .from("notifications").select("reference_id").eq("id", nid).maybeSingle();
    const refId = (notif as { reference_id?: string } | null)?.reference_id;
    if (!refId) return fallback;
    const { data: ann } = await supabase
      .from("announcements").select("title, push_show_title").eq("id", refId).maybeSingle();
    const row = ann as { title?: string; push_show_title?: boolean } | null;
    if (!row?.push_show_title) return fallback;
    const title = (row.title ?? "").trim();
    if (!title) return fallback;
    return title.length > TITLE_MAX ? title.slice(0, TITLE_MAX - 1) + "…" : title;
  } catch {
    return fallback;
  }
}

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
    type Group = { userId: string; app: string; word: string; text: string; url: string; ids: string[]; tagKey: string; bell?: true; nids: string[] };
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
      // 🚨 まとめる鍵は「いま表示に使う文言」と必ず揃える。
      //    文章モードで word を鍵にすると、同じ「新着」でも中身の違う通知
      //    （例：残業の実績未報告／管理者の取消／締め後の許可）が1つに混ざり、
      //    先に来た1件の文章だけが出て残りが消える。
      const label = USE_SENTENCE ? map.text : map.word;
      const gKey = `${row.user_id}|${map.app}|${label}|${map.url}`;
      const g = groups.get(gKey);
      const rowNids = (row.notification_ids ?? []) as string[];
      if (g) {
        g.ids.push(row.id);
        g.nids.push(...rowNids);
      } else {
        groups.set(gKey, { userId: row.user_id, app: map.app, word: map.word, text: map.text, url: map.url, ids: [row.id], tagKey: base, bell: map.bell, nids: [...rowNids] });
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
          body: await bodyForGroup(supabase, g),
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

      // 🚨 役職名では引かない（2026-09-10 段4）。設定の ccRoles（役職名／role_id／立場コード）は DB 側が解釈する
      const { data: roleProfiles } = await supabase.rpc("profile_ids_for_roles", { p_spec: roles });
      const roleIds = ((roleProfiles ?? []) as ({ profile_ids_for_roles: string } | string)[])
        .map(r => (typeof r === "string" ? r : r.profile_ids_for_roles));
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
          // CC送信（役職まとめ）はベル通知IDを持たないので、お知らせでも件名は出せない
          body: buildBody(map.text, map.word, count),
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
