-- Phase 4: real external research. The previous research.search only queried the local titles
-- table, so the operator could not answer "what is trending right now" with anything it did not
-- already have. research.web queries a public, keyless source and returns citations.

insert into public.operator_tool (name, description, family, input_schema, permission, read_only, approval_required, rate_limit_per_min, timeout_ms)
values (
  'research.web',
  'Search an external public source for current entertainment news and return cited results.',
  'research',
  '{"type":"object","properties":{"query":{"type":"string","minLength":2,"maxLength":200}},"required":["query"],"additionalProperties":false}',
  'research.read', true, false, 20, 15000
)
on conflict (name) do update
  set description = excluded.description,
      input_schema = excluded.input_schema,
      permission = excluded.permission,
      read_only = excluded.read_only,
      approval_required = excluded.approval_required,
      rate_limit_per_min = excluded.rate_limit_per_min,
      timeout_ms = excluded.timeout_ms;
