-- Reconstructed source for live migration 59: universal-only Android release responses.
-- Verified against both deployed functions on 2026-11-11. No release rows or storage objects change.
set check_function_bodies = off;

create or replace function public.get_latest_app_release()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select jsonb_build_object(
      'version_code', r.version_code, 'version_name', r.version_name,
      'apk_url', r.apk_url, 'universal_apk_url', r.apk_url,
      'arm64_apk_url', r.apk_url, 'arm32_apk_url', r.apk_url,
      'x86_64_apk_url', r.apk_url, 'x86_apk_url', r.apk_url,
      'sha256', r.sha256, 'file_size_bytes', r.file_size_bytes,
      'release_notes', r.release_notes, 'is_mandatory', r.is_mandatory,
      'min_supported_version', r.min_supported_version, 'git_commit', r.git_commit,
      'published_at', r.published_at, 'universal_only', true)
     from public.app_releases r order by r.version_code desc limit 1),
    jsonb_build_object('version_code', 0, 'version_name', '', 'universal_only', true));
$$;

create or replace function public.get_latest_app_release_url()
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select apk_url from public.app_releases order by version_code desc limit 1),
    'https://ltyymanoidagwsapgiql.supabase.co/storage/v1/object/public/app-releases/hallyu-universal-latest.apk');
$$;

grant execute on function public.get_latest_app_release() to anon, authenticated, service_role;
grant execute on function public.get_latest_app_release_url() to anon, authenticated, service_role;
reset check_function_bodies;
