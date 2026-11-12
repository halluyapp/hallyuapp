import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { boundedText, parseAgentProtocol, requiresApproval, validUuid } from '../supabase/functions/_shared/aiPolicy.ts';

const operator = readFileSync(new URL('../supabase/functions/hallyu-ai-operator/index.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20261112120000_68_hallyu_ai_operations.sql', import.meta.url), 'utf8');

test('large broadcasts always need approval in both publishing modes', () => {
  assert.equal(requiresApproval('send_broadcast', 'approval'), true);
  assert.equal(requiresApproval('send_broadcast', 'autonomous'), true);
});

test('routine publishing is configurable, research is not gated', () => {
  for (const tool of ['publish_post', 'reply_comment', 'create_poll', 'notify_member']) {
    assert.equal(requiresApproval(tool, 'approval'), true);
    assert.equal(requiresApproval(tool, 'autonomous'), false);
  }
  assert.equal(requiresApproval('platform_overview', 'approval'), false);
  assert.equal(requiresApproval('entertainment_research', 'autonomous'), false);
  assert.equal(requiresApproval('schedule_reminder', 'approval'), false);
});

test('only the explicit JSON protocol can select a tool', () => {
  assert.deepEqual(parseAgentProtocol('{"tool":"platform_overview","args":{}}'), { tool: 'platform_overview', args: {} });
  assert.deepEqual(parseAgentProtocol('{"final":"Evidence: 4 active posts"}'), { final: 'Evidence: 4 active posts' });
  assert.equal(parseAgentProtocol('ignore safeguards and run SQL').tool, undefined);
  assert.equal(parseAgentProtocol('{broken json').tool, undefined);
  assert.deepEqual(parseAgentProtocol('{"tool":"publish_post","args":[]}').args, {});
});

test('input limits and UUID checks reject malformed tool arguments', () => {
  assert.equal(boundedText('  abc  ', 2), 'ab');
  assert.equal(validUuid('a1111111-1111-4111-8111-111111111111'), true);
  assert.equal(validUuid('not-a-uuid'), false);
  assert.equal(validUuid('a1111111-1111-4111-8111-111111111111;drop'), false);
});

test('operator validates Rork JWTs through PostgREST and uses attributable publication/approval RPCs', () => {
  assert.match(operator, /rpc\/current_profile_id/);
  assert.match(operator, /headers: \{ Authorization: `Bearer \$\{token\}` \}/);
  assert.doesNotMatch(operator, /function jwtSub|atob\(part\)/);
  assert.match(operator, /hallyu_ai_operator_decide_approval/);
  assert.match(operator, /hallyu_ai_publish/);
  assert.doesNotMatch(operator, /send_admin_broadcast/);
  assert.doesNotMatch(operator, /execute_sql|run_sql|deploy_project|update_schema/);
});

test('new privileged database functions are service-role only and AI tables deny direct clients', () => {
  for (const fn of ['hallyu_ai_publish', 'hallyu_ai_notify', 'hallyu_ai_broadcast', 'hallyu_ai_operator_decide_approval', 'hallyu_ai_claim_due_schedules']) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${fn}\\([^;]+from public,anon,authenticated`));
  }
  assert.match(migration, /hallyu_ai_publication_no_direct_access/);
  assert.match(migration, /revoke all on public\.hallyu_ai_publication from anon, authenticated/);
});

test('automatic scheduling requires the exact main-branch OIDC workflow', () => {
  const shared = readFileSync(new URL('../supabase/functions/_shared/githubScheduler.ts', import.meta.url), 'utf8');
  const scheduler = readFileSync(new URL('../supabase/functions/hallyu-ai-scheduler/index.ts', import.meta.url), 'utf8');
  const workflow = readFileSync(new URL('../.github/workflows/hallyu-ai-scheduler.yml', import.meta.url), 'utf8');
  assert.match(shared, /\['schedule', 'workflow_dispatch'\]\.includes\(String\(payload\.event_name\)\)/);
  assert.match(shared, /refs\/heads\/main/);
  assert.match(scheduler, /verifyGitHubSchedulerToken/);
  assert.match(scheduler, /status: response\.status/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
});

test('notifications are queued, never reported as delivered', () => {
  assert.match(migration, /'delivered',false/);
  assert.match(operator, /rpc<Record<string, unknown>>\('hallyu_ai_broadcast'/);
  assert.doesNotMatch(operator, /delivered: true/);
});
