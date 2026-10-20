-- Hallyu — 42: Full Consumer Product Backend Upgrade
-- Interactive Polls, Instant Community Title Ratings, Direct Messages (Send-to-Friend),
-- Custom Profile Backdrops, and Multi-Filter Catalog Discovery + Tonight's Pick.

-- 1. Profile custom backdrop banner support
alter table public.profiles
  add column if not exists banner_url text;

-- 2. Interactive Polls on Posts
create table if not exists public.post_polls (
  post_id uuid primary key references public.posts(id) on delete cascade,
  question text not null check (length(btrim(question)) between 1 and 240),
  options text[] not null check (cardinality(options) between 2 and 4),
  closes_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.post_polls enable row level security;

drop policy if exists "post_polls_select_all" on public.post_polls;
create policy "post_polls_select_all"
  on public.post_polls
  for select
  using (true);

drop policy if exists "post_polls_author_insert" on public.post_polls;
create policy "post_polls_author_insert"
  on public.post_polls
  for insert
  with check (
    exists (
      select 1
      from public.posts p
      where p.id = post_polls.post_id
        and p.author_id = auth.uid()
    )
  );

drop policy if exists "post_polls_author_delete" on public.post_polls;
create policy "post_polls_author_delete"
  on public.post_polls
  for delete
  using (
    exists (
      select 1
      from public.posts p
      where p.id = post_polls.post_id
        and p.author_id = auth.uid()
    )
  );

create table if not exists public.post_poll_votes (
  post_id uuid not null references public.post_polls(post_id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  option_index smallint not null check (option_index between 0 and 3),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create index if not exists post_poll_votes_post_idx
  on public.post_poll_votes (post_id);

alter table public.post_poll_votes enable row level security;

drop policy if exists "post_poll_votes_select_all" on public.post_poll_votes;
create policy "post_poll_votes_select_all"
  on public.post_poll_votes
  for select
  using (true);

drop policy if exists "post_poll_votes_owner_insert" on public.post_poll_votes;
create policy "post_poll_votes_owner_insert"
  on public.post_poll_votes
  for insert
  with check (user_id = auth.uid());

drop policy if exists "post_poll_votes_owner_update" on public.post_poll_votes;
create policy "post_poll_votes_owner_update"
  on public.post_poll_votes
  for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "post_poll_votes_owner_delete" on public.post_poll_votes;
create policy "post_poll_votes_owner_delete"
  on public.post_poll_votes
  for delete
  using (user_id = auth.uid());

create or replace function public.create_post_poll(
  p_post_id uuid,
  p_question text,
  p_options text[],
  p_hours integer default 168
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_clean text[];
  v_closes timestamptz;
begin
  if v_uid is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.posts p where p.id = p_post_id and p.author_id = v_uid
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select array_agg(trimmed)
    into v_clean
    from (
      select left(btrim(opt), 80) as trimmed
      from unnest(coalesce(p_options, '{}'::text[])) as opt
      where length(btrim(opt)) > 0
      limit 4
    ) cleaned;

  if coalesce(cardinality(v_clean), 0) < 2 then
    raise exception 'poll_requires_at_least_two_options' using errcode = '22023';
  end if;

  v_closes := case
    when p_hours is null or p_hours <= 0 then null
    else now() + make_interval(hours => least(p_hours, 720))
  end;

  insert into public.post_polls (post_id, question, options, closes_at)
  values (
    p_post_id,
    left(coalesce(nullif(btrim(p_question), ''), 'Vote below'), 240),
    v_clean,
    v_closes
  )
  on conflict (post_id) do update
    set question = excluded.question,
        options = excluded.options,
        closes_at = excluded.closes_at;

  return jsonb_build_object(
    'post_id', p_post_id,
    'question', left(coalesce(nullif(btrim(p_question), ''), 'Vote below'), 240),
    'options', v_clean,
    'counts', array_fill(0, array[cardinality(v_clean)]),
    'total_votes', 0,
    'my_vote', null,
    'closes_at', v_closes
  );
end;
$$;

create or replace function public.vote_post_poll(
  p_post_id uuid,
  p_option_index integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_poll public.post_polls%rowtype;
  v_counts integer[];
  v_total integer;
begin
  if v_uid is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  select * into v_poll
  from public.post_polls
  where post_id = p_post_id;

  if not found then
    raise exception 'poll_not_found' using errcode = 'P0002';
  end if;

  if v_poll.closes_at is not null and v_poll.closes_at <= now() then
    raise exception 'poll_closed' using errcode = '22023';
  end if;

  if p_option_index < 0 or p_option_index >= cardinality(v_poll.options) then
    raise exception 'invalid_poll_option' using errcode = '22023';
  end if;

  insert into public.post_poll_votes (post_id, user_id, option_index)
  values (p_post_id, v_uid, p_option_index::smallint)
  on conflict (post_id, user_id) do update
    set option_index = excluded.option_index,
        created_at = now();

  select
    array_agg(coalesce(v.cnt, 0) order by idx.i),
    coalesce(sum(v.cnt), 0)::integer
  into v_counts, v_total
  from generate_series(0, cardinality(v_poll.options) - 1) as idx(i)
  left join (
    select option_index::integer as opt, count(*)::integer as cnt
    from public.post_poll_votes
    where post_id = p_post_id
    group by option_index
  ) v on v.opt = idx.i;

  return jsonb_build_object(
    'post_id', p_post_id,
    'question', v_poll.question,
    'options', v_poll.options,
    'counts', coalesce(v_counts, '{}'::integer[]),
    'total_votes', coalesce(v_total, 0),
    'my_vote', p_option_index,
    'closes_at', v_poll.closes_at
  );
end;
$$;

create or replace function public.get_post_polls(p_post_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_object_agg(
      q.post_id::text,
      jsonb_build_object(
        'post_id', q.post_id,
        'question', q.question,
        'options', q.options,
        'counts', q.counts,
        'total_votes', q.total_votes,
        'my_vote', q.my_vote,
        'closes_at', q.closes_at
      )
    ),
    '{}'::jsonb
  )
  from (
    select
      pp.post_id,
      pp.question,
      pp.options,
      pp.closes_at,
      coalesce(
        (
          select array_agg(coalesce(v.cnt, 0) order by idx.i)
          from generate_series(0, cardinality(pp.options) - 1) as idx(i)
          left join (
            select option_index::integer as opt, count(*)::integer as cnt
            from public.post_poll_votes pv
            where pv.post_id = pp.post_id
            group by option_index
          ) v on v.opt = idx.i
        ),
        '{}'::integer[]
      ) as counts,
      (
        select count(*)::integer
        from public.post_poll_votes pv
        where pv.post_id = pp.post_id
      ) as total_votes,
      (
        select pv.option_index::integer
        from public.post_poll_votes pv
        where pv.post_id = pp.post_id
          and pv.user_id = auth.uid()
        limit 1
      ) as my_vote
    from public.post_polls pp
    where pp.post_id = any(coalesce(p_post_ids, '{}'::uuid[]))
  ) q;
$$;

-- 3. Instant Community Title Ratings
create table if not exists public.title_ratings (
  title_id uuid not null references public.titles(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  score numeric(3,1) not null check (score >= 1.0 and score <= 10.0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (title_id, user_id)
);

create index if not exists title_ratings_title_idx
  on public.title_ratings (title_id);

alter table public.title_ratings enable row level security;

drop policy if exists "title_ratings_select_all" on public.title_ratings;
create policy "title_ratings_select_all"
  on public.title_ratings
  for select
  using (true);

drop policy if exists "title_ratings_owner_insert" on public.title_ratings;
create policy "title_ratings_owner_insert"
  on public.title_ratings
  for insert
  with check (user_id = auth.uid());

drop policy if exists "title_ratings_owner_update" on public.title_ratings;
create policy "title_ratings_owner_update"
  on public.title_ratings
  for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "title_ratings_owner_delete" on public.title_ratings;
create policy "title_ratings_owner_delete"
  on public.title_ratings
  for delete
  using (user_id = auth.uid());

create or replace function public.rate_title(
  p_title_id uuid,
  p_score numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_clean numeric(3,1);
  v_avg numeric(3,1);
  v_cnt integer;
begin
  if v_uid is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  if p_score is null or p_score < 1 or p_score > 10 then
    raise exception 'invalid_rating_score' using errcode = '22023';
  end if;

  v_clean := round(p_score::numeric, 1);

  insert into public.title_ratings (title_id, user_id, score, updated_at)
  values (p_title_id, v_uid, v_clean, now())
  on conflict (title_id, user_id) do update
    set score = excluded.score,
        updated_at = now();

  select
    round(avg(s.val)::numeric, 1),
    count(*)::integer
  into v_avg, v_cnt
  from (
    select tr.score::numeric as val
    from public.title_ratings tr
    where tr.title_id = p_title_id
    union all
    select p.rating::numeric as val
    from public.posts p
    where p.title_id = p_title_id
      and p.state = 'active'
      and p.rating is not null
  ) s;

  update public.titles
  set community_rating = v_avg,
      updated_at = now()
  where id = p_title_id;

  return jsonb_build_object(
    'title_id', p_title_id,
    'my_score', v_clean,
    'community_rating', v_avg,
    'rating_count', coalesce(v_cnt, 0)
  );
end;
$$;

-- 4. Direct Messages & Send-to-Friend
create table if not exists public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 2000),
  shared_drama_id text,
  shared_post_id uuid references public.posts(id) on delete set null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint direct_messages_distinct_peers check (sender_id <> recipient_id)
);

create index if not exists direct_messages_recipient_unread_idx
  on public.direct_messages (recipient_id, created_at desc)
  where read_at is null;

create index if not exists direct_messages_pair_created_idx
  on public.direct_messages (least(sender_id, recipient_id), greatest(sender_id, recipient_id), created_at desc);

alter table public.direct_messages enable row level security;

drop policy if exists "direct_messages_participants_select" on public.direct_messages;
create policy "direct_messages_participants_select"
  on public.direct_messages
  for select
  using (sender_id = auth.uid() or recipient_id = auth.uid());

drop policy if exists "direct_messages_sender_insert" on public.direct_messages;
create policy "direct_messages_sender_insert"
  on public.direct_messages
  for insert
  with check (
    sender_id = auth.uid()
    and sender_id <> recipient_id
    and not exists (
      select 1
      from public.blocks b
      where (b.blocker_id = sender_id and b.blocked_id = recipient_id)
         or (b.blocker_id = recipient_id and b.blocked_id = sender_id)
    )
  );

drop policy if exists "direct_messages_recipient_update" on public.direct_messages;
create policy "direct_messages_recipient_update"
  on public.direct_messages
  for update
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

create or replace function public.send_direct_message(
  p_recipient_handle text,
  p_body text,
  p_shared_drama_id text default null,
  p_shared_post_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_sender public.profiles%rowtype;
  v_peer public.profiles%rowtype;
  v_msg public.direct_messages%rowtype;
  v_notif_id uuid;
begin
  if v_uid is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  select * into v_sender from public.profiles where id = v_uid;
  select * into v_peer
  from public.profiles
  where lower(handle) = lower(regexp_replace(btrim(coalesce(p_recipient_handle, '')), '^@', ''))
    and account_status = 'active';

  if not found then
    raise exception 'recipient_not_found' using errcode = 'P0002';
  end if;

  if v_peer.id = v_uid then
    raise exception 'cannot_message_self' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.blocks b
    where (b.blocker_id = v_uid and b.blocked_id = v_peer.id)
       or (b.blocker_id = v_peer.id and b.blocked_id = v_uid)
  ) then
    raise exception 'blocked_conversation' using errcode = '42501';
  end if;

  insert into public.direct_messages (
    sender_id,
    recipient_id,
    body,
    shared_drama_id,
    shared_post_id
  )
  values (
    v_uid,
    v_peer.id,
    left(btrim(p_body), 2000),
    nullif(btrim(coalesce(p_shared_drama_id, '')), ''),
    p_shared_post_id
  )
  returning * into v_msg;

  -- Deliver a real in-app & OS push notification for the recipient
  insert into public.notifications (
    recipient_id,
    actor_ids,
    kind,
    "group",
    title,
    body,
    post_id,
    deep_link
  )
  values (
    v_peer.id,
    array[v_uid],
    'mention',
    'social',
    coalesce(v_sender.display_name, '@' || v_sender.handle) || ' sent you a message',
    left(btrim(p_body), 140),
    p_shared_post_id,
    '/messages/' || v_sender.handle
  )
  returning id into v_notif_id;

  insert into public.notification_deliveries (notification_id, push_token_id, status)
  select v_notif_id, pt.id, 'queued'
  from public.push_tokens pt
  where pt.user_id = v_peer.id
    and pt.disabled_at is null
  on conflict do nothing;

  return jsonb_build_object(
    'id', v_msg.id,
    'sender_id', v_msg.sender_id,
    'recipient_id', v_msg.recipient_id,
    'body', v_msg.body,
    'shared_drama_id', v_msg.shared_drama_id,
    'shared_post_id', v_msg.shared_post_id,
    'read_at', v_msg.read_at,
    'created_at', v_msg.created_at
  );
end;
$$;

create or replace function public.list_conversations(p_limit integer default 40)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (
    select auth.uid() as uid
  ),
  latest as (
    select distinct on (
      case when dm.sender_id = (select uid from me) then dm.recipient_id else dm.sender_id end
    )
      case when dm.sender_id = (select uid from me) then dm.recipient_id else dm.sender_id end as peer_id,
      dm.id,
      dm.sender_id,
      dm.body,
      dm.shared_drama_id,
      dm.shared_post_id,
      dm.read_at,
      dm.created_at
    from public.direct_messages dm
    where dm.sender_id = (select uid from me)
       or dm.recipient_id = (select uid from me)
    order by
      case when dm.sender_id = (select uid from me) then dm.recipient_id else dm.sender_id end,
      dm.created_at desc
  ),
  unread as (
    select dm.sender_id as peer_id, count(*)::integer as unread_count
    from public.direct_messages dm
    where dm.recipient_id = (select uid from me)
      and dm.read_at is null
    group by dm.sender_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'peer_id', p.id,
        'handle', p.handle,
        'display_name', p.display_name,
        'avatar_path', p.avatar_path,
        'verified', p.verified,
        'last_message_id', l.id,
        'last_sender_id', l.sender_id,
        'last_body', l.body,
        'shared_drama_id', l.shared_drama_id,
        'shared_post_id', l.shared_post_id,
        'last_at', l.created_at,
        'unread_count', coalesce(u.unread_count, 0)
      )
      order by l.created_at desc
    ),
    '[]'::jsonb
  )
  from latest l
  join public.profiles p on p.id = l.peer_id
  left join unread u on u.peer_id = l.peer_id
  where p.account_status = 'active'
  limit least(greatest(coalesce(p_limit, 40), 1), 100);
$$;

create or replace function public.list_direct_messages(
  p_peer_handle text,
  p_limit integer default 60
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with peer as (
    select id
    from public.profiles
    where lower(handle) = lower(regexp_replace(btrim(coalesce(p_peer_handle, '')), '^@', ''))
    limit 1
  ),
  msgs as (
    select dm.*
    from public.direct_messages dm, peer
    where (dm.sender_id = auth.uid() and dm.recipient_id = peer.id)
       or (dm.sender_id = peer.id and dm.recipient_id = auth.uid())
    order by dm.created_at desc
    limit least(greatest(coalesce(p_limit, 60), 1), 200)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', m.id,
        'sender_id', m.sender_id,
        'recipient_id', m.recipient_id,
        'body', m.body,
        'shared_drama_id', m.shared_drama_id,
        'shared_post_id', m.shared_post_id,
        'read_at', m.read_at,
        'created_at', m.created_at
      )
      order by m.created_at asc
    ),
    '[]'::jsonb
  )
  from msgs m;
$$;

create or replace function public.mark_conversation_read(p_peer_handle text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peer_id uuid;
  v_updated integer := 0;
begin
  if v_uid is null then
    return 0;
  end if;

  select id into v_peer_id
  from public.profiles
  where lower(handle) = lower(regexp_replace(btrim(coalesce(p_peer_handle, '')), '^@', ''))
  limit 1;

  if v_peer_id is null then
    return 0;
  end if;

  update public.direct_messages
  set read_at = now()
  where recipient_id = v_uid
    and sender_id = v_peer_id
    and read_at is null;

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

-- 5. Multi-Filter Catalog Discovery + Tonight's Random Pick RPC
create or replace function public.discover_catalog(
  p_world text default null,
  p_genre text default null,
  p_provider text default null,
  p_status text default null,
  p_min_rating numeric default null,
  p_min_year integer default null,
  p_sort text default 'relevance',
  p_limit integer default 30,
  p_offset integer default 0
)
returns setof public.titles
language sql
volatile
security invoker
set search_path = public, pg_temp
as $$
  select t.*
  from public.titles t
  where t.catalog_unavailable_at is null
    and (p_world is null or t.world = p_world)
    and (
      p_genre is null
      or exists (
        select 1
        from unnest(t.genres) g
        where lower(g) = lower(p_genre)
      )
    )
    and (
      p_provider is null
      or lower(coalesce(t.network, '')) like '%' || lower(p_provider) || '%'
      or exists (
        select 1
        from unnest(coalesce(t.streaming_on, '{}'::text[])) sp
        where lower(sp) like '%' || lower(p_provider) || '%'
      )
    )
    and (p_status is null or t.status::text = lower(p_status))
    and (
      p_min_rating is null
      or coalesce(t.community_rating, t.vote_average, 0) >= p_min_rating
    )
    and (p_min_year is null or coalesce(t.year, 0) >= p_min_year)
  order by
    case when p_sort = 'random' then random() else 0 end asc,
    case when p_sort = 'rating' then coalesce(t.community_rating, t.vote_average, 0) else 0 end desc,
    case when p_sort = 'newest' then coalesce(t.year, 0) else 0 end desc,
    case when p_sort = 'popular' then coalesce(t.popularity, 0) else 0 end desc,
    coalesce(t.popularity, 0) desc,
    t.updated_at desc
  limit least(greatest(coalesce(p_limit, 30), 1), 60)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

grant execute on function public.create_post_poll(uuid, text, text[], integer) to authenticated;
grant execute on function public.vote_post_poll(uuid, integer) to authenticated;
grant execute on function public.get_post_polls(uuid[]) to anon, authenticated;
grant execute on function public.rate_title(uuid, numeric) to authenticated;
grant execute on function public.send_direct_message(text, text, text, uuid) to authenticated;
grant execute on function public.list_conversations(integer) to authenticated;
grant execute on function public.list_direct_messages(text, integer) to authenticated;
grant execute on function public.mark_conversation_read(text) to authenticated;
grant execute on function public.discover_catalog(text, text, text, text, numeric, integer, text, integer, integer) to anon, authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.direct_messages;
    exception when duplicate_object then
      null;
    end;
    begin
      alter publication supabase_realtime add table public.post_poll_votes;
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;
