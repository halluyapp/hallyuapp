-- 94: Align operator_constitution & operator_knowledge read policies with public.is_admin().
--
-- Migration 86 compared `auth.uid()` against `operator_is_staff(profile_id)`, mixing auth subject
-- UUIDs with profile UUIDs. All other 19 operator tables use `public.is_admin()` (which resolves
-- via `current_profile_id()` for both Supabase GoTrue and Rork JWTs).

set check_function_bodies = off;

drop policy if exists operator_constitution_admin_read on public.operator_constitution;
create policy operator_constitution_admin_read
  on public.operator_constitution
  for select to authenticated
  using (public.is_admin());

drop policy if exists operator_knowledge_admin_read on public.operator_knowledge;
create policy operator_knowledge_admin_read
  on public.operator_knowledge
  for select to authenticated
  using (public.is_admin());
