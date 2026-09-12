-- 🚨 匿名（ログインしていない状態）から実行できるままだった2本を、確実に外す
--
-- 【前のファイル（20260912122255）でやり残したこと】
--   `revoke execute … from anon` だけを書いたが、適用後に実測したら**まだ true のまま**だった。
--   理由：この2本の実行権限は **PUBLIC（全員）経由**で付いており、anon から個別に外しても
--   PUBLIC の分が残るため。
--   🚨 CLAUDE.md には「`revoke … from public` では外れない（anon を明示せよ）」と書いてあるが、
--      **逆も同じ**で「anon だけ外しても PUBLIC が残る」。**両方**外し、必要な相手に与え直すのが正しい。
--      新しく作った `answer_encouragement_day` は最初から両方書いていたので false になっている。
--
-- 【この順番でやる理由】
--   PUBLIC から外すと、ログイン済み（authenticated）の分も一緒に消える。
--   そのため **外す → ログイン済みに与え直す → 念のため anon からも外す** の順にする。
--   逆にすると、画面から自分の休暇を取消・編集できなくなる。
--
-- 【実害】いまも匿名では対象が0件（どちらの関数も `auth.uid()` を見るため）で、実害は出ていない。
--   ただし「新しい関数は anon から外す」という決まりに反した状態なので揃える。
--
-- 🚨 `has_feature_permission` は**外さない**。DB の許可（RLS）の判定そのものに使われており、
--    外すと匿名での判定が「拒否」ではなく「エラー」になるおそれがある。

revoke execute on function public.cancel_own_leave(uuid) from public;
grant  execute on function public.cancel_own_leave(uuid) to authenticated;
revoke execute on function public.cancel_own_leave(uuid) from anon;

revoke execute on function public.edit_own_leave(uuid, text, text, text, text, text, text, date, date, text) from public;
grant  execute on function public.edit_own_leave(uuid, text, text, text, text, text, text, date, date, text) to authenticated;
revoke execute on function public.edit_own_leave(uuid, text, text, text, text, text, text, date, date, text) from anon;

-- 適用後に必ず実測すること（true/false を目で見る）：
--   select has_function_privilege('anon','public.cancel_own_leave(uuid)','execute');            -- false
--   select has_function_privilege('authenticated','public.cancel_own_leave(uuid)','execute');   -- true
