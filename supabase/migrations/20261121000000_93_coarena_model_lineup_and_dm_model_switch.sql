-- 93: Coarena model lineup update (Gemini 3.8, GPT-6 Luna, DeepSeek) and DM active-model discovery.
--
-- Fable 5.2 is retired per Nari Master Plan (Part IV Section 7.5 & Part XVIII Section 55).
-- Coarena models available are Gemini 3.8, GPT-6 Luna and DeepSeek.
-- Exposes operator_get_active_model() and operator_list_models() for Nari DM header & model selector.

set check_function_bodies = off;

-- ── 1. Update Coarena provider row & retire Fable 5.2 ─────────────────────────────────────────
update public.operator_provider
   set model_id = 'gpt-6-luna',
       notes = 'Coarena route. Supported models: Gemini 3.8, GPT-6 Luna, DeepSeek.',
       updated_at = now()
 where provider = 'coarena';

-- ── 2. Update knowledge entry to remove Fable 5.2 references ──────────────────────────────────
update public.operator_knowledge
   set body = 'Two providers exist: APINEX (free/gpt-6-luna) and Coarena (models: Gemini 3.8, GPT-6 Luna, DeepSeek). Each task uses exactly one provider chosen at creation. There is no automatic cross-provider fallback. If the assigned provider fails, the task fails honestly and may be retried on the same provider within its budget.',
       updated_at = now()
 where slug = 'provider-rules';

-- ── 3. Active model query for DM header ───────────────────────────────────────────────────────
create or replace function public.operator_get_active_model()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_provider public.operator_provider%rowtype;
begin
  select * into v_provider
    from public.operator_provider
   where enabled
   order by is_default desc, updated_at desc
   limit 1;

  if v_provider.provider is null then
    return jsonb_build_object(
      'provider', 'apinex',
      'label', 'APINEX',
      'model_id', 'free/gpt-6-luna',
      'health', 'unknown'
    );
  end if;

  return jsonb_build_object(
    'provider', v_provider.provider,
    'label', v_provider.label,
    'model_id', v_provider.model_id,
    'health', v_provider.health
  );
end;
$$;

revoke all on function public.operator_get_active_model() from public;
grant execute on function public.operator_get_active_model() to anon, authenticated, service_role;

-- ── 4. Candidate models list for DM selector ───────────────────────────────────────────────────
create or replace function public.operator_list_models()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res jsonb;
begin
  select jsonb_agg(
    jsonb_build_object(
      'provider', provider,
      'label', label,
      'active_model', model_id,
      'is_default', is_default,
      'health', health,
      'models', case provider
        when 'coarena' then jsonb_build_array('gpt-6-luna', 'gemini-3.8', 'deepseek')
        when 'apinex' then jsonb_build_array('free/gpt-6-luna')
        else jsonb_build_array(model_id)
      end
    ) order by is_default desc, provider asc
  ) into v_res
  from public.operator_provider
  where enabled;

  return coalesce(v_res, '[]'::jsonb);
end;
$$;

revoke all on function public.operator_list_models() from public;
grant execute on function public.operator_list_models() to authenticated, service_role;
