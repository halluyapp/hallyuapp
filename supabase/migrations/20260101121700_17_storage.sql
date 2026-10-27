-- Hallyu backend — 17 storage.
-- One private bucket, `media`, for everything the app uploads: post images, video clips, posters and
-- avatars. Bytes never enter Postgres — `post_media.storage_path` and `profiles.avatar_path` point at
-- object keys inside this bucket.
--
-- Object layout (the prefix is the access rule):
--   u/<user-id>/…           a member's uploads (posts, avatars) — writable only by that member
--   avatars/…               display images readable by anyone, including anonymous visitors
--   catalog/…               catalog artwork (posters/backdrops/stills) readable by anyone
--
-- The bucket stays private: reads go through a signed URL or an authenticated request, so a leaked
-- anon key cannot read a member's private shelf image. The two public prefixes are readable by
-- anyone because they are exactly what a feed card renders.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media',
  'media',
  false,
  -- Hard ceiling for the whole bucket. The composer is stricter (100 MB per video, 6 images per post);
  -- this is the backstop that keeps a single oversized upload from consuming the project.
  104857600,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif', 'video/mp4', 'video/quicktime']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Owner helper: an object belongs to the member whose uuid is the second path segment. Returns NULL
-- for any path that is not of the form `u/<uuid>/…`, which is what makes the public prefixes safe.
create or replace function public.storage_owner(name text)
returns uuid
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when split_part(name, '/', 1) = 'u'
     and split_part(name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(name, '/', 2)::uuid
    else null
  end
$$;

revoke all on function public.storage_owner(text) from public, anon, authenticated;
grant execute on function public.storage_owner(text) to authenticated;

-- Writes are scoped to the caller's own folder: `u/<auth.uid()>/…`. Nothing else is insertable.
create policy media_upload_own_folder on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media' and public.storage_owner(name) = auth.uid());

create policy media_update_own_folder on storage.objects
  for update to authenticated
  using (bucket_id = 'media' and public.storage_owner(name) = auth.uid())
  with check (bucket_id = 'media' and public.storage_owner(name) = auth.uid());

create policy media_delete_own_folder on storage.objects
  for delete to authenticated
  using (bucket_id = 'media' and (public.storage_owner(name) = auth.uid() or public.is_moderator()));

-- Reads: a member may read their own objects, plus anything attached to content they can see.
create policy media_read_own_or_attached on storage.objects
  for select to authenticated
  using (
    bucket_id = 'media'
    and (
      public.storage_owner(name) = auth.uid()
      or exists (
        select 1
        from public.post_media m
        join public.posts p on p.id = m.post_id
        where m.storage_path = name
          and (p.state = 'active' or p.author_id = auth.uid())
      )
      or exists (select 1 from public.post_media m where m.poster_path = name)
      or exists (
        select 1 from public.profiles p
        where p.avatar_path = name and p.account_status <> 'deleted'
      )
      or public.is_moderator()
    )
    and not exists (
      select 1 from public.blocks b
      where public.storage_owner(name) is not null
        and b.blocker_id = auth.uid()
        and b.blocked_id = public.storage_owner(name)
    )
  );

-- Public prefixes: the only anonymous read in the bucket.
create policy media_read_public_prefix on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'media' and (name like 'avatars/%' or name like 'catalog/%'));

grant usage on schema storage to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
