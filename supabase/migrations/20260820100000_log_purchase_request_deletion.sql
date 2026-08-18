-- 購入申請・精算を削除したときに、内容を丸ごと控えとして残す
--
-- 【背景】
-- 管理画面の「🚫 削除」は完全削除で、明細・見積もり・意見・修正履歴まで
-- 連鎖して消え、誰が何を消したのかが一切残らなかった。
-- テスト申請や間違った申請を片付ける用途で実際に使われているため削除自体は残し、
-- 「消したという事実と中身」だけを確実に残す。
--
-- 【設計】
-- ・親が消えるので purchase_request_id に外部キーは張らない（張ると控えも一緒に消える）
-- ・書き込みポリシーを作らない＝トリガー（SECURITY DEFINER）だけが書ける。
--   あとから人が書き換え・削除できない
-- ・閲覧は管理者のみ

create table if not exists public.purchase_request_deletion_log (
  id uuid primary key default gen_random_uuid(),
  purchase_request_id uuid not null,
  request_type text,
  applicant_id uuid,
  amount integer,
  item_name text,
  deleted_by uuid,
  deleted_at timestamptz not null default now(),
  snapshot jsonb not null
);

create index if not exists idx_prdl_deleted_at on public.purchase_request_deletion_log (deleted_at desc);
create index if not exists idx_prdl_request_id on public.purchase_request_deletion_log (purchase_request_id);

alter table public.purchase_request_deletion_log enable row level security;

drop policy if exists "prdl_select_admin" on public.purchase_request_deletion_log;
create policy "prdl_select_admin" on public.purchase_request_deletion_log
  for select to authenticated
  using (public.is_admin());

-- 削除の直前に、本体と子テーブルをまとめて控えに書き出す。
-- BEFORE DELETE なので、この時点では子テーブルの行はまだ残っている
-- （外部キーの連鎖削除は親の削除後に走るため）。
create or replace function public.log_purchase_request_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.purchase_request_deletion_log
    (purchase_request_id, request_type, applicant_id, amount, item_name, deleted_by, snapshot)
  values (
    OLD.id,
    OLD.request_type,
    OLD.user_id,
    OLD.amount,
    OLD.item_name,
    auth.uid(),
    jsonb_build_object(
      'request', to_jsonb(OLD),
      'items', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'item', to_jsonb(i),
            'quotes', coalesce((
              select jsonb_agg(to_jsonb(q) order by q.id)
              from purchase_request_item_quotes q
              where q.purchase_request_item_id = i.id
            ), '[]'::jsonb)
          ) order by i.id
        )
        from purchase_request_items i
        where i.purchase_request_id = OLD.id
      ), '[]'::jsonb),
      'edit_log', coalesce((
        select jsonb_agg(to_jsonb(e) order by e.edited_at)
        from purchase_request_edit_log e
        where e.purchase_request_id = OLD.id
      ), '[]'::jsonb),
      'opinions', coalesce((
        select jsonb_agg(to_jsonb(o))
        from purchase_request_manager_opinions o
        where o.purchase_request_id = OLD.id
      ), '[]'::jsonb),
      'comments', coalesce((
        select jsonb_agg(to_jsonb(cm))
        from purchase_request_comments cm
        where cm.purchase_request_id = OLD.id
      ), '[]'::jsonb)
    )
  );
  return OLD;
end;
$$;

drop trigger if exists trg_log_purchase_request_deletion on public.purchase_requests;
create trigger trg_log_purchase_request_deletion
  before delete on public.purchase_requests
  for each row execute function public.log_purchase_request_deletion();
