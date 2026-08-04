-- 調整休の提案：回答しても提案者に通知が届かない不具合の修正
--
-- 症状：一般・パート・フロア責任者が提案に回答しても、提案者にベル通知が届かない。
--       しかもクライアントは .then(null, () => {}) で握りつぶすのでエラーも出ない。
-- 原因：notifications の INSERT ポリシーがリーダー以上限定
--       （20260610100000_create_notifications.sql:16）。回答者の多くはそれ未満。
-- 対策：通知の作成を、回答を確定させる RPC の中（SECURITY DEFINER）に移す。
--       クライアント側の insertNotification は削除する。
--
-- ※引数・戻り値は変えていないので、古いクライアントからでもそのまま呼べる。

create or replace function public.respond_overtime_adjustment_proposal(
  p_proposal_id uuid,
  p_note text,
  p_options jsonb           -- [{option_id, selection, custom_date, custom_time}, ...]
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_claimed  int;
  v_proposer uuid;
  v_name     text;
  v_chosen   int;
  v_site_on  boolean;
begin
  update overtime_adjustment_proposals
    set status = 'responded', recipient_note = p_note, responded_at = now()
    where id = p_proposal_id and recipient_id = auth.uid() and status = 'open'
  returning proposer_id into v_proposer;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    return false;  -- 既に回答済み or 権限なし → 呼び出し側で「回答済みです」を表示
  end if;

  update overtime_adjustment_proposal_options o set
    selection   = coalesce(nullif(e->>'selection',''), o.selection),
    custom_date = nullif(e->>'custom_date','')::date,
    custom_time = nullif(e->>'custom_time','')::time
  from jsonb_array_elements(coalesce(p_options, '[]'::jsonb)) e
  where o.id = (e->>'option_id')::uuid and o.proposal_id = p_proposal_id;

  -- 提案者へのベル通知（クライアントからは RLS で insert できないためここで作る）
  select count(*) into v_chosen
    from overtime_adjustment_proposal_options
   where proposal_id = p_proposal_id and selection in ('accepted', 'custom');

  select name into v_name from profiles where id = auth.uid();

  select enabled into v_site_on from notification_settings
   where event_key = 'overtime_proposal:responded' and channel = 'site';

  if coalesce(v_site_on, true) and v_proposer is not null then
    insert into notifications
      (user_id, message, sub_message, source_type, reference_id, event_key)
    values (
      v_proposer,
      coalesce(v_name, 'スタッフ') || 'さんが調整の提案に回答しました',
      case when v_chosen > 0 then '採用' || v_chosen || '件' else '後日あらためて調整' end,
      'overtime_proposal:responded', p_proposal_id::text, 'overtime_proposal:responded'
    );
  end if;

  return true;
end; $$;
revoke execute on function public.respond_overtime_adjustment_proposal(uuid, text, jsonb) from public;
grant  execute on function public.respond_overtime_adjustment_proposal(uuid, text, jsonb) to authenticated;

-- プッシュのON/OFF行（site は上の関数が読む。無ければ送る扱い）
insert into public.notification_settings (event_key, channel, enabled, recipient, subject, template)
values ('overtime_proposal:responded', 'site', true, null, null, null)
on conflict (event_key, channel) do nothing;
