-- Reconstructed source for live migration 58 (CEO authority and Rork registration).
-- Definitions match the deployed objects inspected on 2026-11-11, including the register_profile
-- type/concurrency defects repaired by migration 61. Keeping that history explicit avoids replaying
-- or disguising the live deployment.
set check_function_bodies = off;

alter type public.profile_role add value if not exists 'ceo';

create or replace function public.is_moderator()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.profiles p
    where p.id = public.current_profile_id()
      and p.role in ('ceo', 'moderator', 'admin') and p.account_status = 'active');
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.profiles p
    where p.id = public.current_profile_id()
      and p.role in ('ceo', 'admin') and p.account_status = 'active');
$$;

create or replace function public.promote_first_profile_to_ceo()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.profiles where id <> new.id) then
    new.role := 'ceo';
    new.is_founder := true;
    new.verified := true;
    new.verification_tier := 'red';
    new.exclude_from_competitions := true;
    new.verification_note := 'Founder & Chief Executive Officer — first account on the fresh Hallyu backend';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_first_becomes_ceo on public.profiles;
create trigger profiles_first_becomes_ceo
before insert on public.profiles for each row execute function public.promote_first_profile_to_ceo();

create or replace function public.register_profile(p_handle text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_sub text := public.user_id();
  v_id uuid;
  v_name text;
begin
  if v_sub is null then raise exception 'sign in required' using errcode = '28000'; end if;
  select id into v_id from public.profiles where auth_sub = v_sub limit 1;
  if v_id is not null then return v_id; end if;
  v_name := left(coalesce(nullif(btrim(p_display_name), ''), 'Member'), 40);
  insert into public.profiles (id, auth_sub, handle, display_name)
  values (gen_random_uuid(), v_sub,
    public.generate_handle(coalesce(nullif(btrim(p_handle), ''), 'member'), v_sub), v_name)
  on conflict (auth_sub) do nothing returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.register_profile(text, text) from public, anon;
grant execute on function public.register_profile(text, text) to authenticated, service_role;
reset check_function_bodies;
