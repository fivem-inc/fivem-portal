-- 退職者の申請期間・3段目の段階0（2026-09-20・レビューの指摘を反映）
-- 🚨 画面には1行も手を入れない。**先にDB側の穴を塞ぐ**だけ。利用者には何も起きない。
--
-- 【レビューで見つかった穴（本番で裏取り済み）】
--  ① `useAuth` は profiles から `is_faq_editor` も読んでいるが、2段目の列の許可に入れ忘れていた。
--     PostgREST は許可の無い列が1つでも混ざると**そのクエリ全体を 42501 で落とす**（部分的には返らない）。
--     → 退職者は自分の名前も役職も読めず、**権限が全部 false・画面が空**になるところだった。
--     しかも `useAuth` は `if (error || !data) return null;` なので、**理由が画面のどこにも出ない**。
--  ② 期限の判定が2か所に分かれていた（`lib/retire.ts` は retire_date 基準、Hook は retired_at 基準）。
--     画面に3か所目を書くと、少しずつ違う判定が3つ並ぶ。
--  ③ 期限の判定を画面でやると**端末の時計**に依存する（`toJstDateStr` は端末のタイムゾーンで、JST を保証しない）。
--     → 判定はDBに1本だけ置き、画面はその答えをもらうだけにする。

-- ───────────────────────────────────────────────
-- 1. 🚨 列の許し忘れを直す（これが無いと退職者の画面が空になる）
--    is_faq_editor は真偽値1つ。退職者に見えても害はない
-- ───────────────────────────────────────────────
grant select (is_faq_editor) on public.profiles to retiree;

-- ───────────────────────────────────────────────
-- 2. 「期限内の退職者か」の判定を1本にする
--    🚨 これが唯一の正。Hook も画面もここを見る
-- ───────────────────────────────────────────────
create or replace function public.is_retiree_in_grace(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $fn$
  select exists (
    select 1 from public.profiles p
     where p.id = p_uid
       and p.is_active = false
       and p.retired_at is not null            -- 退職に切り替わっている（予約だけの人は対象外）
       and p.retiree_access_until is not null
       and p.retiree_access_until >= (now() at time zone 'Asia/Tokyo')::date   -- 🚨 JST はここだけで計算する
       and coalesce(p.approval_status, '') <> 'pending'                        -- 承認待ちと取り違えない
  );
$fn$;
comment on function public.is_retiree_in_grace(uuid) is
  '期限内の退職者か。🚨 この判定はここ1本だけ。Hook も画面（my_access_state）もこれを呼ぶ';

-- ───────────────────────────────────────────────
-- 3. 画面が1回だけ呼ぶ「いまの自分の立場」
--    🚨 security definer なので、退職者に許していない列（retired_at・app_settings）も中では読める。
--       そのぶん**返すものは必要最小限**にする
-- ───────────────────────────────────────────────
create or replace function public.my_access_state()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  p record;
  v_keys jsonb;
begin
  select pr.id, pr.is_active, pr.approval_status, pr.retire_date, pr.retiree_access_until
    into p
    from public.profiles pr
   where pr.id = auth.uid();

  if not found then
    return jsonb_build_object('mode', 'blocked');
  end if;

  if p.is_active then
    return jsonb_build_object('mode', 'staff');
  end if;

  -- 🚨 承認待ちは退職者より先に判定する（取り違えるとログインさせてしまう）
  if coalesce(p.approval_status, '') = 'pending' then
    return jsonb_build_object('mode', 'blocked');
  end if;

  if public.is_retiree_in_grace(p.id) then
    select coalesce(s.value -> 'keys', '[]'::jsonb) into v_keys
      from public.app_settings s where s.key = 'retiree_feature_keys';
    return jsonb_build_object(
      'mode',         'retiree_grace',
      'access_until', p.retiree_access_until,
      'retire_date',  p.retire_date,
      'feature_keys', coalesce(v_keys, '[]'::jsonb)
    );
  end if;

  return jsonb_build_object('mode', 'blocked');
exception when others then
  -- 🚨 ここで例外を投げると、画面が「立場が分からない」まま止まる。分からないときは blocked に倒す
  return jsonb_build_object('mode', 'blocked');
end;
$fn$;
comment on function public.my_access_state() is
  'いまログインしている人の立場（staff / retiree_grace / blocked）と、退職者なら期限と使える機能。画面はこれ1本だけを呼ぶ';

-- ───────────────────────────────────────────────
-- 4. Hook を「判定を直書き」から「1本を呼ぶ」形に変える
--    🚨 条件は1文字も変えていない（is_retiree_in_grace が同じ条件を持っている）
--    🚨 例外を必ず受け止める作りは そのまま（ログインを止めない）
-- ───────────────────────────────────────────────
create or replace function public.custom_access_token_hook(event jsonb)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $fn$
declare
  v_claims jsonb;
begin
  if not public.is_retiree_in_grace((event ->> 'user_id')::uuid) then
    return event;
  end if;

  v_claims := coalesce(event -> 'claims', '{}'::jsonb);
  v_claims := jsonb_set(v_claims, '{role}', '"retiree"'::jsonb, true);
  return jsonb_set(event, '{claims}', v_claims, true);
exception when others then
  -- 🚨 何が起きてもログインは止めない
  return event;
end;
$fn$;

-- ───────────────────────────────────────────────
-- 5. 権限（🚨 新しい関数は anon から明示的に外す。`from public` では外れない）
-- ───────────────────────────────────────────────
revoke execute on function public.is_retiree_in_grace(uuid) from anon;
revoke execute on function public.my_access_state()        from anon;
grant  execute on function public.is_retiree_in_grace(uuid) to authenticated, retiree, service_role;
grant  execute on function public.my_access_state()         to authenticated, retiree, service_role;
-- Hook を呼べるのは Supabase の認証だけ（作り直したので付け直す）
revoke execute on function public.custom_access_token_hook(jsonb) from public, anon, authenticated, service_role;
grant  execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;

-- 戻し版（この migration を取り消すとき）:
--   ① 先に Supabase の管理画面で Hook を無効にする
--   ② 2026-09-20 の `20260920084250` の版に custom_access_token_hook を戻す
--   ③ drop function public.my_access_state(); drop function public.is_retiree_in_grace(uuid);
--   ④ revoke select (is_faq_editor) on public.profiles from retiree;
