-- Backward-compatible safety for the currently deployed worker until it adopts task-bound search.
-- Legacy retrieval has no trusted channel, so it must never return staff-only material.
create or replace function public.operator_knowledge_search(p_query text,p_limit integer default 5)
returns table(slug text,title text,body text,score real)
language sql stable security definer set search_path = public,pg_temp as $$
  with terms as (
    select distinct lower(term) as term from regexp_split_to_table(left(coalesce(p_query,''),1000),'[^[:alnum:]_]+') term
    where length(term)>2 and lower(term) not in ('the','and','what','how','does','can','you','please','about','this','that','for','with')
  ), ranked as (
    select k.*,(select count(*) from terms t where strpos(lower(k.title || ' ' || array_to_string(k.tags,' ') || ' ' || k.body),t.term)>0)::real as relevance
    from public.operator_knowledge k where k.is_active and k.visibility='public'
  ) select r.slug,r.title,r.body,r.relevance from ranked r where r.relevance>0
  order by r.relevance desc,r.updated_at desc,r.slug limit greatest(1,least(coalesce(p_limit,5),20));
$$;
revoke all on function public.operator_knowledge_search(text,integer) from public,anon,authenticated;
grant execute on function public.operator_knowledge_search(text,integer) to service_role;
