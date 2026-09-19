-- 退職者の申請期間・2段目の第1歩（2026-09-19・設計書 §8-5 の手順1）
-- 関数の「誰でも実行できる（PUBLIC）」を外し、いま実際に使っている anon・authenticated・service_role に
-- **今とまったく同じ実行許可**を付け直す。あわせて、今後作る関数に PUBLIC を自動で付けない。
-- ねらい：退職者専用の役割（retiree・次の手順で作る）に、関数が初めから1本も使えない状態を作る（許したものだけ使える）
-- 🚨 在籍者・お客様向けFAQ（anon）の動きは変えない。検証＝前後で anon・authenticated が実行できる関数の集合が1本も変わらない
-- 🚨 残る PUBLIC 実行可能な188本は**すべて拡張 btree_gist の関数**（supabase_admin の所有・索引の部品で表を読まない・2026-09-19 実測）。
--    postgres からは外せないが、退職者に呼ばれても漏れるものは無い
-- 🚨 CLAUDE.md の「新しい関数は anon から revoke」は今後も必要（既定で anon に付くのは Supabase の pg_default_acl のため）
do $$
declare
  r record;
begin
  for r in
    select p.oid, p.oid::regprocedure::text as sig,
           has_function_privilege('anon', p.oid, 'execute') as anon_had,
           has_function_privilege('authenticated', p.oid, 'execute') as auth_had,
           has_function_privilege('service_role', p.oid, 'execute') as svc_had
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p')
       and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    where a.grantee = 0 and a.privilege_type = 'EXECUTE')
  loop
    execute format('revoke execute on function %s from public', r.sig);
    if r.anon_had then execute format('grant execute on function %s to anon', r.sig); end if;
    if r.auth_had then execute format('grant execute on function %s to authenticated', r.sig); end if;
    if r.svc_had  then execute format('grant execute on function %s to service_role', r.sig); end if;
  end loop;
end $$;

-- 今後 postgres が作る関数に PUBLIC の実行許可を自動で付けない（anon・authenticated・service_role への既定はそのまま）
alter default privileges for role postgres revoke execute on functions from public;
