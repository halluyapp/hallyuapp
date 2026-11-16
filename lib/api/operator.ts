// Control Centre API client.
//
// The Control Centre is a real admin surface: every call goes to the `operator-admin` Edge
// Function with the signed-in administrator's own JWT. The function re-derives the caller's
// profile and role server-side, so nothing here is trusted as authorization.
//
// The executive's conversation with Hallyu AI is NOT here — it lives in Direct Messages
// (`app/messages/[handle].tsx` with handle `hallyu.ai`). This module only manages the operator:
// providers, tools, schedules, tasks, knowledge and audit.

import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../../constants/keys';
import { ensureBackendSessionToken } from './client';

export type OperatorChannel = 'admin_control' | 'member_ai' | 'public_thread';

export interface OperatorProvider {
  provider: string;
  label: string;
  model_id: string;
  base_url?: string;
  enabled: boolean;
  is_default: boolean;
  health: string;
  last_ok_at: string | null;
  last_error_at: string | null;
  last_error_code: string | null;
  last_error_detail?: string | null;
  rpm_limit: number | null;
  notes?: string | null;
  updated_at?: string;
}

export interface OperatorUsageRow {
  provider: string;
  outcome: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  latency_ms: number | null;
  created_at: string;
}

export interface OperatorTask {
  id: string;
  task_type: string;
  status: string;
  priority: number;
  attempt_count: number;
  max_attempts?: number;
  error_code: string | null;
  error_detail?: string | null;
  provider?: string | null;
  model?: string | null;
  created_at: string;
  updated_at: string;
  available_at?: string;
  finished_at?: string | null;
}

export interface OperatorConversation {
  id: string;
  channel: OperatorChannel;
  member_profile_id: string | null;
  external_thread_id: string | null;
  subject: string | null;
  status: string;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  created_at: string;
}

export interface OperatorMessage {
  id: string;
  direction: string;
  author_type: string;
  author_profile_id: string | null;
  body: string;
  delivery_status: string | null;
  created_at: string;
}

export interface OperatorApproval {
  id: string;
  task_id: string | null;
  action: string;
  requested_by: string | null;
  required_role: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface OperatorTool {
  name: string;
  description: string;
  family: string;
  permission: string;
  read_only: boolean;
  approval_required: boolean;
  rate_limit_per_min: number | null;
  timeout_ms: number;
  enabled: boolean;
}

export interface OperatorPolicy {
  autonomy: Record<string, boolean>;
  moderation: Record<string, number>;
  notifications: Record<string, number>;
  providers: Record<string, unknown>;
  approval_required: string[];
  updated_at?: string;
  updated_by?: string | null;
}

export interface OperatorWorker {
  worker_id: string;
  last_seen_at: string;
  version: string | null;
  tasks_processed: number | null;
  last_error: string | null;
}

export interface OperatorAnalytics {
  members_total?: number;
  members_active?: number;
  members_new_7d?: number;
  posts_total?: number;
  posts_7d?: number;
  comments_total?: number;
  comments_7d?: number;
  dms_total?: number;
  reports_open?: number;
  notifications_7d?: number;
  worlds?: Record<string, number>;
  top_posts_7d?: Record<string, unknown>[];
}

export interface OperatorOverview {
  analytics: OperatorAnalytics | null;
  providers: OperatorProvider[];
  workers: OperatorWorker[];
  task_counts: Record<string, number>;
  pending_approvals: number;
  caller: { profileId: string; role: string; handle: string; displayName: string };
}

export interface OperatorModerationQueueItem {
  report_id?: string;
  target_type?: string;
  target_id?: string;
  target_excerpt?: string | null;
  target_author_id?: string | null;
  reason?: string | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface OperatorModerationCase {
  id: string;
  target_type: string;
  target_id: string;
  rule_code: string;
  rule_text: string;
  confidence: number | null;
  decision: string;
  action_taken: string | null;
  appeal_status: string | null;
  created_at: string;
}

export interface OperatorResearchItem {
  id: string;
  topic: string;
  headline: string;
  summary: string | null;
  source_name: string | null;
  source_url: string | null;
  verification: string;
  world: string | null;
  used_in_post_id: string | null;
  created_at: string;
}

export interface OperatorCampaign {
  id: string;
  name: string;
  kind: string;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  payload: Record<string, unknown> | null;
  post_id: string | null;
  created_at: string;
}

export interface OperatorSchedule {
  name: string;
  task_type: string;
  cadence_seconds: number;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  input: Record<string, unknown> | null;
  priority: number;
}

export interface OperatorAuditEntry {
  id: number;
  task_id: string | null;
  actor_profile_id: string | null;
  actor_type: string;
  action: string;
  outcome: string;
  resource_type: string | null;
  resource_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export class OperatorApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'OperatorApiError';
    this.status = status;
  }
}

async function callOperatorAdmin<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new OperatorApiError('This build has no backend connection configured.', 0);
  }
  const token = await ensureBackendSessionToken();
  if (!token) {
    throw new OperatorApiError('Sign in with an administrator account to open the Control Centre.', 401);
  }

  const response = await fetch(`${SUPABASE_URL}/functions/v1/operator-admin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action, ...payload }),
  });

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    let message = text.slice(0, 300) || `Control Centre request failed (${response.status})`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // keep raw text
    }
    throw new OperatorApiError(message, response.status);
  }

  return (text ? JSON.parse(text) : {}) as T;
}

export const operatorApi = {
  overview: () => callOperatorAdmin<OperatorOverview>('overview'),
  conversations: () => callOperatorAdmin<{ conversations: OperatorConversation[] }>('conversations'),
  conversation: (conversationId: string) =>
    callOperatorAdmin<{ context: Record<string, unknown> | null; messages: OperatorMessage[] }>('conversation', {
      conversation_id: conversationId,
    }),
  sendAdminMessage: (body: string, conversationId?: string) =>
    callOperatorAdmin<{ ok: boolean; conversation_id: string; task_id: string }>('admin_message', {
      body,
      conversation_id: conversationId,
    }),
  tasks: (status?: string, limit = 40) =>
    callOperatorAdmin<{ tasks: OperatorTask[] }>('tasks', { status, limit }),
  retryTask: (taskId: string) => callOperatorAdmin<{ ok: boolean; task: OperatorTask }>('task_retry', { task_id: taskId }),
  approvals: () => callOperatorAdmin<{ approvals: OperatorApproval[] }>('approvals'),
  decideApproval: (approvalId: string, decision: 'approved' | 'rejected', note?: string) =>
    callOperatorAdmin<{ ok: boolean }>('approval_decide', { approval_id: approvalId, decision, note }),
  providers: () =>
    callOperatorAdmin<{ providers: OperatorProvider[]; recent_usage: OperatorUsageRow[] }>('providers'),
  tools: () => callOperatorAdmin<{ tools: OperatorTool[] }>('tools'),
  moderation: () =>
    callOperatorAdmin<{ queue: OperatorModerationQueueItem[]; cases: OperatorModerationCase[] }>('moderation'),
  research: () => callOperatorAdmin<{ research: OperatorResearchItem[] }>('research'),
  campaigns: () => callOperatorAdmin<{ campaigns: OperatorCampaign[] }>('campaigns'),
  schedules: () => callOperatorAdmin<{ schedules: OperatorSchedule[] }>('schedules'),
  audit: () => callOperatorAdmin<{ audit: OperatorAuditEntry[] }>('audit'),
  policy: () => callOperatorAdmin<{ policy: OperatorPolicy | null }>('policy'),
  updatePolicy: (patch: Partial<Pick<OperatorPolicy, 'autonomy' | 'moderation' | 'notifications' | 'providers'>>) =>
    callOperatorAdmin<{ ok: boolean }>('policy_update', patch as Record<string, unknown>),
  health: () =>
    callOperatorAdmin<{ providers: OperatorProvider[]; workers: OperatorWorker[]; task_counts: Record<string, number> }>(
      'health',
    ),
};
