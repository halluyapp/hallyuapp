-- Hallyu backend — report a push delivery using the delivery row's actual `id` field.
--
-- `report_delivery` in migration 28 loaded a notification_deliveries row into a rowtype variable
-- named `d`, then addressed it as `d.delivery_id`. The table column is `id`; report_delivery would
-- therefore fail for sent, retry, and invalid-token outcomes after successfully loading a row.
set check_function_bodies = off;

create or replace function public.report_delivery(
  p_delivery_id uuid,
  p_sent boolean,
  p_error text default null,
  p_invalid boolean default false,
  p_provider_message_id text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.notification_deliveries%rowtype;
begin
  if auth.uid() is not null then
    raise exception 'push delivery is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  select * into d from public.notification_deliveries where id = p_delivery_id for update;
  if not found then
    return;
  end if;

  if p_invalid then
    update public.push_tokens set disabled_at = now() where id = d.push_token_id;

    update public.notification_deliveries
       set status = 'invalid_token',
           last_error = left(coalesce(p_error, 'token rejected by provider'), 300),
           provider_message_id = left(p_provider_message_id, 200),
           updated_at = now()
     where push_token_id = d.push_token_id
       and status in ('queued', 'failed', 'sending')
       and id <> d.id;

    update public.notification_deliveries
       set status = 'invalid_token',
           last_error = left(coalesce(p_error, 'token rejected by provider'), 300),
           provider_message_id = left(p_provider_message_id, 200),
           updated_at = now()
     where id = d.id;

    return;
  end if;

  if p_sent then
    update public.notification_deliveries
       set status = 'sent',
           sent_at = now(),
           last_error = null,
           provider_message_id = left(p_provider_message_id, 200),
           updated_at = now()
     where id = d.id;
    return;
  end if;

  -- Transient failure: exponential backoff, capped, and the attempt ceiling decides when it stops.
  update public.notification_deliveries
     set status = (case when d.attempt >= 5 then 'failed' else 'queued' end)::public.delivery_status,
         last_error = left(p_error, 300),
         next_attempt_at = now() + make_interval(mins => least(60, (2 ^ greatest(d.attempt, 1))::integer)),
         updated_at = now()
   where id = d.id;
end;
$$;

revoke all on function public.report_delivery(uuid, boolean, text, boolean, text) from public, anon, authenticated;
grant execute on function public.report_delivery(uuid, boolean, text, boolean, text) to service_role;

reset check_function_bodies;
