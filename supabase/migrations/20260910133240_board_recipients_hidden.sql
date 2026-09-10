-- 2026-09-10 連絡板：アーカイブの「削除する」を、行を消さずに「印」で効かせる
--
-- 症状（2026-09-10 実機で確認）
--   連絡板 → 受信トレイ → アーカイブ → 選んで［削除する］が
--   「◯件を削除できませんでした」となり、押しても消えない。
--   board_message_recipients には INSERT / SELECT / UPDATE の許可しかなく、
--   DELETE の許可が1つも無かった（RLS で弾かれた delete はエラーにならず0件で返るので、
--   これまでは画面から消えたように見えて、開き直すと戻ってきていた）。
--
-- 🚨 DELETE の許可を足す案は採らない。この表は**2つの意味を兼ねている**：
--      ① 送信者の記録「誰に送ったか」
--      ② 受信者の受信箱「届いたもの・アーカイブしたか」
--    2026-09-10 に実測したところ、送信トレイの「◯人」・「対応状況 ◯/◯人 完了」・
--    「未対応 ◯人」の催促リストは**すべてこの表を数えている**（BoardPage.tsx の
--    loadOutbox / 受信トレイ詳細の useEffect）。行を消せるようにすると、受信者が
--    アーカイブを整理しただけで **① 送信者の記録が書き換わり、未対応のまま消えた人を
--    追えなくなる**。「誰に送ったか」は送信者の記録なので、受信者に消させない。
--
-- 直し方
--   受信者が「自分の受信箱から消す」ことを、行の削除ではなく **hidden の印**で表す。
--   🚨 送信トレイのアーカイブが outbox_hidden（board_messages）という印で
--      同じことをしており、**この考え方はすでにこのシステムの中に前例がある**。
--   🚨 UPDATE の許可（board_recipients_update_own・user_id = auth.uid()）は
--      すでにあるので、**新しい許可は要らない**。archived の ON/OFF と同じ経路で書ける。
--
-- 効く場所（画面側で hidden を除くのは受信者向けの3か所だけ。ここを間違えると穴が開く）
--   除く   … 受信トレイの一覧 / アーカイブの一覧 / 連絡板の検索
--   除かない … 送信トレイの「◯人」/ 対応状況・未対応リスト / 既読の詳細
--              （＝送信者の記録。受信者が隠しても数を変えない）

alter table public.board_message_recipients
  add column if not exists hidden boolean not null default false;

comment on column public.board_message_recipients.hidden is
  '受信者が自分の受信箱から消した印（アーカイブの「削除する」）。'
  '🚨 行は消さない。送信者の「誰に送ったか・未対応◯人」はこの表を数えているため、'
  '行を消すと送信者の記録が受信者の操作で書き換わる。'
  '送信トレイの board_messages.outbox_hidden と同じ考え方。';

comment on table public.board_message_recipients is
  'お知らせの宛先（1行＝1人ぶん）。送信者の記録「誰に送ったか」と、'
  '受信者の受信箱の状態（archived / hidden）を兼ねている。'
  '本体（board_messages）を消すと ON DELETE CASCADE で一緒に消える。';
