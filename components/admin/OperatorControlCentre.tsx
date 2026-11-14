import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native';
import { colors, radius, space } from '../../constants/theme';
import {
  operatorApi,
  OperatorApiError,
  type OperatorApproval,
  type OperatorAuditEntry,
  type OperatorCampaign,
  type OperatorModerationCase,
  type OperatorModerationQueueItem,
  type OperatorOverview,
  type OperatorPolicy,
  type OperatorProvider,
  type OperatorResearchItem,
  type OperatorSchedule,
  type OperatorTask,
  type OperatorTool,
  type OperatorUsageRow,
  type OperatorWorker,
} from '../../lib/api/operator';
import { timeAgo } from '../../lib/format';
import { Text } from '../ui/Text';

type TabKey =
  | 'overview'
  | 'queue'
  | 'approvals'
  | 'providers'
  | 'tools'
  | 'moderation'
  | 'research'
  | 'campaigns'
  | 'health';

const TABS: { key: TabKey; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'overview', label: 'Overview', icon: 'pulse-outline' },
  { key: 'queue', label: 'Queue', icon: 'layers-outline' },
  { key: 'approvals', label: 'Approvals', icon: 'shield-checkmark-outline' },
  { key: 'providers', label: 'Providers', icon: 'git-network-outline' },
  { key: 'tools', label: 'Tools', icon: 'construct-outline' },
  { key: 'moderation', label: 'Moderation', icon: 'alert-circle-outline' },
  { key: 'research', label: 'Research', icon: 'search-outline' },
  { key: 'campaigns', label: 'Campaigns', icon: 'megaphone-outline' },
  { key: 'health', label: 'Health', icon: 'heart-outline' },
];

interface TabData {
  overview?: OperatorOverview;
  tasks?: OperatorTask[];
  approvals?: OperatorApproval[];
  providers?: { providers: OperatorProvider[]; recent_usage: OperatorUsageRow[] };
  tools?: OperatorTool[];
  policy?: OperatorPolicy | null;
  moderation?: { queue: OperatorModerationQueueItem[]; cases: OperatorModerationCase[] };
  research?: OperatorResearchItem[];
  campaigns?: OperatorCampaign[];
  health?: { providers: OperatorProvider[]; workers: OperatorWorker[]; task_counts: Record<string, number> };
  schedules?: OperatorSchedule[];
  audit?: OperatorAuditEntry[];
}

function errorMessage(error: unknown): string {
  if (error instanceof OperatorApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong talking to the operator backend.';
}

function statusTone(status: string): string {
  switch (status) {
    case 'completed':
    case 'ok':
    case 'available':
    case 'approved':
    case 'active':
      return colors.success;
    case 'running':
    case 'queued':
    case 'retrying':
    case 'pending':
    case 'reviewing':
      return colors.info;
    case 'failed':
    case 'dead':
    case 'cancelled':
    case 'rejected':
    case 'unavailable':
      return colors.danger;
    default:
      return colors.textTertiary;
  }
}

export function OperatorControlCentre() {
  const [tab, setTab] = useState<TabKey>('overview');
  const [data, setData] = useState<TabData>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (target: TabKey, options?: { silent?: boolean }) => {
      if (!options?.silent) setLoading(true);
      setError(null);
      try {
        switch (target) {
          case 'overview': {
            const overview = await operatorApi.overview();
            setData((prev) => ({ ...prev, overview }));
            break;
          }
          case 'queue': {
            const result = await operatorApi.tasks(undefined, 60);
            setData((prev) => ({ ...prev, tasks: result.tasks }));
            break;
          }
          case 'approvals': {
            const result = await operatorApi.approvals();
            setData((prev) => ({ ...prev, approvals: result.approvals }));
            break;
          }
          case 'providers': {
            const [providers, policy] = await Promise.all([operatorApi.providers(), operatorApi.policy()]);
            setData((prev) => ({ ...prev, providers, policy: policy.policy }));
            break;
          }
          case 'tools': {
            const [tools, policy] = await Promise.all([operatorApi.tools(), operatorApi.policy()]);
            setData((prev) => ({ ...prev, tools: tools.tools, policy: policy.policy }));
            break;
          }
          case 'moderation': {
            const result = await operatorApi.moderation();
            setData((prev) => ({ ...prev, moderation: result }));
            break;
          }
          case 'research': {
            const result = await operatorApi.research();
            setData((prev) => ({ ...prev, research: result.research }));
            break;
          }
          case 'campaigns': {
            const result = await operatorApi.campaigns();
            setData((prev) => ({ ...prev, campaigns: result.campaigns }));
            break;
          }
          case 'health': {
            const [health, schedules, audit] = await Promise.all([
              operatorApi.health(),
              operatorApi.schedules(),
              operatorApi.audit(),
            ]);
            setData((prev) => ({ ...prev, health, schedules: schedules.schedules, audit: audit.audit }));
            break;
          }
        }
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load(tab, { silent: true });
  }, [load, tab]);

  const retryTask = useCallback(
    async (taskId: string) => {
      setBusy(`task:${taskId}`);
      try {
        await operatorApi.retryTask(taskId);
        await load('queue', { silent: true });
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const decideApproval = useCallback(
    async (approvalId: string, decision: 'approved' | 'rejected') => {
      setBusy(`approval:${approvalId}`);
      try {
        await operatorApi.decideApproval(approvalId, decision);
        await load('approvals', { silent: true });
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const toggleAutonomy = useCallback(
    async (key: string, value: boolean) => {
      const current = data.policy;
      if (!current) return;
      const next = { ...current.autonomy, [key]: value };
      setData((prev) => ({ ...prev, policy: { ...current, autonomy: next } }));
      setBusy(`policy:${key}`);
      try {
        await operatorApi.updatePolicy({ autonomy: next });
      } catch (caught) {
        setError(errorMessage(caught));
        setData((prev) => ({ ...prev, policy: current }));
      } finally {
        setBusy(null);
      }
    },
    [data.policy],
  );

  return (
    <View style={styles.root}>
      <View style={styles.identityBar}>
        <View style={styles.identityDot} />
        <Text variant="caption" tone="secondary" style={styles.identityText}>
          Official Hallyu AI staff · openly disclosed AI · one model per task, no cross-provider fallback
        </Text>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabRow}
        style={styles.tabScroll}
      >
        {TABS.map((item) => {
          const active = item.key === tab;
          return (
            <Pressable
              key={item.key}
              onPress={() => setTab(item.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              style={[styles.tab, active && styles.tabActive]}
            >
              <Ionicons name={item.icon} size={15} color={active ? colors.onAccent : colors.textSecondary} />
              <Text variant="label" style={{ color: active ? colors.onAccent : colors.textSecondary }}>
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {error ? (
        <View style={styles.errorBanner}>
          <Ionicons name="warning-outline" size={16} color={colors.danger} />
          <Text variant="caption" tone="danger" style={{ flex: 1 }}>
            {error}
          </Text>
          <Pressable onPress={() => void load(tab)}>
            <Text variant="caption" tone="accent">
              Retry
            </Text>
          </Pressable>
        </View>
      ) : null}

      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
        keyboardShouldPersistTaps="handled"
      >
        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.accent} />
            <Text variant="caption" tone="tertiary">
              Loading live operator state…
            </Text>
          </View>
        ) : (
          <>
            {tab === 'overview' ? <OverviewScreen data={data.overview} /> : null}
            {tab === 'queue' ? <QueueScreen tasks={data.tasks ?? []} onRetry={retryTask} busyId={busy} /> : null}
            {tab === 'approvals' ? (
              <ApprovalsScreen approvals={data.approvals ?? []} onDecide={decideApproval} busyId={busy} />
            ) : null}
            {tab === 'providers' ? (
              <ProvidersScreen providers={data.providers?.providers ?? []} usage={data.providers?.recent_usage ?? []} />
            ) : null}
            {tab === 'tools' ? (
              <ToolsScreen tools={data.tools ?? []} policy={data.policy ?? null} onToggle={toggleAutonomy} busyId={busy} />
            ) : null}
            {tab === 'moderation' ? <ModerationScreen data={data.moderation} /> : null}
            {tab === 'research' ? <ResearchScreen items={data.research ?? []} /> : null}
            {tab === 'campaigns' ? <CampaignsScreen campaigns={data.campaigns ?? []} /> : null}
            {tab === 'health' ? (
              <HealthScreen
                health={data.health}
                schedules={data.schedules ?? []}
                audit={data.audit ?? []}
              />
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

// ── shared primitives ────────────────────────────────────────────────────────

function Section({ title, caption, children }: { title: string; caption?: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text variant="headline">{title}</Text>
      {caption ? (
        <Text variant="caption" tone="tertiary" style={{ marginTop: 2 }}>
          {caption}
        </Text>
      ) : null}
      <View style={{ marginTop: space.x3, gap: space.x2 }}>{children}</View>
    </View>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <View style={styles.stat}>
      <Text variant="title" style={{ color: tone ?? colors.textPrimary }} numeric>
        {value}
      </Text>
      <Text variant="caption" tone="tertiary">
        {label}
      </Text>
    </View>
  );
}

function Pill({ label, tone }: { label: string; tone?: string }) {
  return (
    <View style={[styles.pill, { borderColor: tone ?? colors.borderSubtle }]}>
      <Text variant="caption" style={{ color: tone ?? colors.textSecondary }}>
        {label}
      </Text>
    </View>
  );
}

function Empty({ icon, title, body }: { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }) {
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={26} color={colors.textTertiary} />
      <Text variant="label" tone="secondary" style={{ marginTop: space.x2 }}>
        {title}
      </Text>
      <Text variant="caption" tone="tertiary" align="center" style={{ marginTop: 4 }}>
        {body}
      </Text>
    </View>
  );
}

// ── screens ─────────────────────────────────────────────────────────────────

function OverviewScreen({ data }: { data?: OperatorOverview }) {
  const router = useRouter();
  if (!data) return <Empty icon="pulse-outline" title="No overview yet" body="Pull to refresh the operator state." />;
  const analytics = data.analytics ?? {};
  const worlds = analytics.worlds ?? {};
  return (
    <>
      <Section title="Talk to Hallyu AI" caption="Your executive conversation lives in Direct Messages, not here">
        <Pressable
          onPress={() => router.push('/messages/hallyu.ai')}
          accessibilityRole="button"
          accessibilityLabel="Open your Direct Messages conversation with Hallyu AI"
        >
          <Card>
            <View style={styles.rowBetween}>
              <View style={{ flex: 1 }}>
                <Text variant="label">Open Direct Messages</Text>
                <Text variant="caption" tone="tertiary" style={{ marginTop: 2 }}>
                  This console manages the operator. Chat with Hallyu AI as a peer in Messages.
                </Text>
              </View>
              <Ionicons name="arrow-forward" size={18} color={colors.accent} />
            </View>
          </Card>
        </Pressable>
      </Section>

      <Section title="Platform pulse" caption="Live from operator_platform_analytics()">
        <Card>
          <View style={styles.statGrid}>
            <Stat label="Members" value={analytics.members_total ?? 0} />
            <Stat label="Active" value={analytics.members_active ?? 0} />
            <Stat label="New · 7d" value={analytics.members_new_7d ?? 0} />
            <Stat label="Posts · 7d" value={analytics.posts_7d ?? 0} />
            <Stat label="Comments · 7d" value={analytics.comments_7d ?? 0} />
            <Stat label="DMs" value={analytics.dms_total ?? 0} />
            <Stat label="Open reports" value={analytics.reports_open ?? 0} tone={(analytics.reports_open ?? 0) > 0 ? colors.warm : undefined} />
            <Stat label="Notifications · 7d" value={analytics.notifications_7d ?? 0} />
          </View>
        </Card>
      </Section>

      <Section title="Worlds" caption="Posts by world">
        <Card>
          <View style={styles.pillRow}>
            {Object.entries(worlds).length === 0 ? (
              <Text variant="caption" tone="tertiary">
                No world activity recorded yet.
              </Text>
            ) : (
              Object.entries(worlds).map(([world, count]) => <Pill key={world} label={`${world} · ${count}`} />)
            )}
          </View>
        </Card>
      </Section>

      <Section title="Operational state" caption="Queue, approvals and providers">
        <Card>
          <View style={styles.statGrid}>
            <Stat label="Queued" value={data.task_counts.queued ?? 0} tone={colors.info} />
            <Stat label="Running" value={data.task_counts.running ?? 0} tone={colors.info} />
            <Stat label="Failed" value={data.task_counts.failed ?? 0} tone={colors.danger} />
            <Stat label="Pending approvals" value={data.pending_approvals} tone={data.pending_approvals > 0 ? colors.warm : undefined} />
          </View>
        </Card>
        <Card>
          {data.providers.length === 0 ? (
            <Text variant="caption" tone="tertiary">
              No providers configured.
            </Text>
          ) : (
            data.providers.map((provider) => (
              <View key={provider.provider} style={styles.rowBetween}>
                <View style={{ flex: 1 }}>
                  <Text variant="label">{provider.label}</Text>
                  <Text variant="caption" tone="tertiary">
                    {provider.model_id} · {provider.is_default ? 'default' : 'standby'}
                  </Text>
                </View>
                <Pill label={provider.health} tone={statusTone(provider.health)} />
              </View>
            ))
          )}
        </Card>
      </Section>

      <Section title="Signed in as" caption="Server-verified administrator">
        <Card>
          <Text variant="label">
            {data.caller.displayName || data.caller.handle} · {data.caller.role}
          </Text>
          <Text variant="caption" tone="tertiary" style={{ marginTop: 2 }}>
            {data.caller.profileId}
          </Text>
        </Card>
      </Section>
    </>
  );
}

function QueueScreen({ tasks, onRetry, busyId }: { tasks: OperatorTask[]; onRetry: (id: string) => void; busyId: string | null }) {
  return (
    <Section title="Task queue" caption="Durable queue · leased claims · bounded retries">
      {tasks.length === 0 ? (
        <Empty icon="layers-outline" title="Queue is clear" body="No operator tasks have been recorded yet." />
      ) : (
        tasks.map((task) => (
          <Card key={task.id}>
            <View style={styles.rowBetween}>
              <View style={{ flex: 1 }}>
                <Text variant="label">{task.task_type}</Text>
                <Text variant="caption" tone="tertiary">
                  {task.provider ?? 'provider pending'} · attempt {task.attempt_count}/{task.max_attempts ?? '—'} · {timeAgo(task.created_at)}
                </Text>
                {task.error_code ? (
                  <Text variant="caption" tone="danger" style={{ marginTop: 2 }}>
                    {task.error_code}
                  </Text>
                ) : null}
              </View>
              <View style={{ alignItems: 'flex-end', gap: 6 }}>
                <Pill label={task.status} tone={statusTone(task.status)} />
                {['failed', 'dead', 'retrying'].includes(task.status) ? (
                  <Pressable onPress={() => onRetry(task.id)} disabled={busyId === `task:${task.id}`}>
                    <Text variant="caption" tone="accent">
                      {busyId === `task:${task.id}` ? 'Re-queueing…' : 'Re-queue'}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          </Card>
        ))
      )}
    </Section>
  );
}

function ApprovalsScreen({
  approvals,
  onDecide,
  busyId,
}: {
  approvals: OperatorApproval[];
  onDecide: (id: string, decision: 'approved' | 'rejected') => void;
  busyId: string | null;
}) {
  const pending = approvals.filter((approval) => approval.status === 'pending');
  const decided = approvals.filter((approval) => approval.status !== 'pending');
  return (
    <>
      <Section title="Pending approvals" caption="Role, permission, security and flagged actions stop here">
        {pending.length === 0 ? (
          <Empty icon="shield-checkmark-outline" title="Nothing waiting" body="The operator has not requested any human decisions." />
        ) : (
          pending.map((approval) => (
            <Card key={approval.id}>
              <Text variant="label">{approval.action}</Text>
              <Text variant="caption" tone="tertiary" style={{ marginTop: 2 }}>
                requires {approval.required_role} · {timeAgo(approval.created_at)}
              </Text>
              {approval.payload ? (
                <Text variant="caption" tone="secondary" style={styles.payload}>
                  {JSON.stringify(approval.payload).slice(0, 400)}
                </Text>
              ) : null}
              <View style={styles.actionRow}>
                <Pressable
                  onPress={() => onDecide(approval.id, 'approved')}
                  disabled={busyId === `approval:${approval.id}`}
                  style={[styles.smallButton, { backgroundColor: colors.success }]}
                >
                  <Text variant="caption" tone="onAccent">
                    Approve
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => onDecide(approval.id, 'rejected')}
                  disabled={busyId === `approval:${approval.id}`}
                  style={[styles.smallButton, { backgroundColor: colors.dangerFill }]}
                >
                  <Text variant="caption" tone="onAccent">
                    Reject
                  </Text>
                </Pressable>
              </View>
            </Card>
          ))
        )}
      </Section>

      <Section title="Decision history" caption="Every decision is audited">
        {decided.length === 0 ? (
          <Text variant="caption" tone="tertiary">
            No decisions yet.
          </Text>
        ) : (
          decided.map((approval) => (
            <Card key={approval.id}>
              <View style={styles.rowBetween}>
                <Text variant="label">{approval.action}</Text>
                <Pill label={approval.status} tone={statusTone(approval.status)} />
              </View>
              <Text variant="caption" tone="tertiary" style={{ marginTop: 2 }}>
                {approval.decided_at ? timeAgo(approval.decided_at) : '—'}
                {approval.note ? ` · ${approval.note}` : ''}
              </Text>
            </Card>
          ))
        )}
      </Section>
    </>
  );
}

function ProvidersScreen({ providers, usage }: { providers: OperatorProvider[]; usage: OperatorUsageRow[] }) {
  return (
    <>
      <Section title="Model providers" caption="Two isolated pools · separate credentials · no automatic fallback">
        {providers.length === 0 ? (
          <Empty icon="git-network-outline" title="No providers" body="Provider rows are seeded by the operator migration." />
        ) : (
          providers.map((provider) => (
            <Card key={provider.provider}>
              <View style={styles.rowBetween}>
                <View style={{ flex: 1 }}>
                  <Text variant="label">{provider.label}</Text>
                  <Text variant="caption" tone="tertiary">
                    {provider.model_id}
                  </Text>
                  <Text variant="caption" tone="tertiary" style={{ marginTop: 2 }}>
                    {provider.base_url ?? ''}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 6 }}>
                  <Pill label={provider.health} tone={statusTone(provider.health)} />
                  {provider.is_default ? <Pill label="default" tone={colors.accent} /> : null}
                </View>
              </View>
              <View style={styles.metaRow}>
                <Text variant="caption" tone="tertiary">
                  {provider.enabled ? 'enabled' : 'disabled'} · rpm {provider.rpm_limit ?? '—'}
                </Text>
                <Text variant="caption" tone="tertiary">
                  last ok {provider.last_ok_at ? timeAgo(provider.last_ok_at) : 'never'}
                </Text>
              </View>
              {provider.last_error_code ? (
                <Text variant="caption" tone="danger" style={{ marginTop: 4 }}>
                  {provider.last_error_code}
                </Text>
              ) : null}
            </Card>
          ))
        )}
      </Section>

      <Section title="Recent usage" caption="Each request is recorded against exactly one provider">
        {usage.length === 0 ? (
          <Text variant="caption" tone="tertiary">
            No usage recorded yet.
          </Text>
        ) : (
          <Card>
            {usage.slice(0, 40).map((row, index) => (
              <View key={`${row.created_at}-${index}`} style={styles.usageRow}>
                <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
                  {row.provider} · {row.outcome}
                </Text>
                <Text variant="caption" tone="tertiary" numeric>
                  {row.total_tokens ?? 0} tok · {row.latency_ms ?? '—'}ms
                </Text>
              </View>
            ))}
          </Card>
        )}
      </Section>
    </>
  );
}

function ToolsScreen({
  tools,
  policy,
  onToggle,
  busyId,
}: {
  tools: OperatorTool[];
  policy: OperatorPolicy | null;
  onToggle: (key: string, value: boolean) => void;
  busyId: string | null;
}) {
  const families = Array.from(new Set(tools.map((tool) => tool.family)));
  const autonomy = policy?.autonomy ?? {};
  return (
    <>
      <Section title="Autonomy" caption="Backend-enforced · changes apply to the next task">
        {Object.keys(autonomy).length === 0 ? (
          <Text variant="caption" tone="tertiary">
            Policy not loaded.
          </Text>
        ) : (
          <Card>
            {Object.entries(autonomy).map(([key, value]) => (
              <View key={key} style={styles.rowBetween}>
                <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
                  {key.replace(/_/g, ' ')}
                </Text>
                <Switch
                  value={value}
                  onValueChange={(next) => onToggle(key, next)}
                  disabled={busyId === `policy:${key}`}
                  trackColor={{ false: colors.surface3, true: colors.accentSoft }}
                  thumbColor={value ? colors.accent : colors.textTertiary}
                />
              </View>
            ))}
          </Card>
        )}
      </Section>

      <Section title="Tool gateway" caption={`${tools.length} tools · schema validated · permission gated · rate limited`}>
        {families.map((family) => (
          <View key={family} style={{ gap: space.x2 }}>
            <Text variant="label" tone="secondary" style={styles.familyLabel}>
              {family}
            </Text>
            {tools
              .filter((tool) => tool.family === family)
              .map((tool) => (
                <Card key={tool.name}>
                  <View style={styles.rowBetween}>
                    <Text variant="label">{tool.name}</Text>
                    <Pill label={tool.permission} tone={tool.read_only ? colors.textTertiary : colors.warm} />
                  </View>
                  <Text variant="caption" tone="tertiary" style={{ marginTop: 2 }}>
                    {tool.description}
                  </Text>
                  <View style={styles.metaRow}>
                    <Text variant="caption" tone="tertiary">
                      {tool.read_only ? 'read-only' : 'write'} · {tool.timeout_ms}ms
                    </Text>
                    <Text variant="caption" tone="tertiary">
                      {tool.approval_required ? 'approval required' : `rpm ${tool.rate_limit_per_min ?? '—'}`}
                    </Text>
                  </View>
                </Card>
              ))}
          </View>
        ))}
      </Section>
    </>
  );
}

function ModerationScreen({ data }: { data?: { queue: OperatorModerationQueueItem[]; cases: OperatorModerationCase[] } }) {
  const queue = data?.queue ?? [];
  const cases = data?.cases ?? [];
  return (
    <>
      <Section title="Open reports" caption="Operator reviews these against policy thresholds">
        {queue.length === 0 ? (
          <Empty icon="checkmark-circle-outline" title="Queue is clear" body="No open reports right now." />
        ) : (
          queue.map((item, index) => (
            <Card key={String(item.report_id ?? index)}>
              <View style={styles.rowBetween}>
                <Text variant="label">{String(item.target_type ?? 'target')}</Text>
                <Pill label={String(item.reason ?? 'reported')} tone={colors.warm} />
              </View>
              <Text variant="caption" tone="secondary" style={{ marginTop: 4 }}>
                {String(item.target_excerpt ?? 'No excerpt available').slice(0, 300)}
              </Text>
            </Card>
          ))
        )}
      </Section>

      <Section title="Decisions" caption="Every case records rule, confidence and action">
        {cases.length === 0 ? (
          <Text variant="caption" tone="tertiary">
            No moderation cases recorded yet.
          </Text>
        ) : (
          cases.map((item) => (
            <Card key={item.id}>
              <View style={styles.rowBetween}>
                <Text variant="label">{item.decision}</Text>
                <Pill label={item.target_type} tone={colors.textTertiary} />
              </View>
              <Text variant="caption" tone="tertiary" style={{ marginTop: 2 }}>
                {item.rule_code} · confidence {item.confidence ?? '—'} · {timeAgo(item.created_at)}
              </Text>
              <Text variant="caption" tone="secondary" style={{ marginTop: 2 }}>
                {item.rule_text}
              </Text>
            </Card>
          ))
        )}
      </Section>
    </>
  );
}

function ResearchScreen({ items }: { items: OperatorResearchItem[] }) {
  return (
    <Section title="Research library" caption="Verified items the operator saved for content">
      {items.length === 0 ? (
        <Empty icon="search-outline" title="Nothing saved yet" body="The entertainment digest task will populate this." />
      ) : (
        items.map((item) => (
          <Card key={item.id}>
            <View style={styles.rowBetween}>
              <Text variant="label" style={{ flex: 1 }}>
                {item.headline}
              </Text>
              <Pill label={item.verification} tone={item.verification === 'confirmed' ? colors.success : colors.warm} />
            </View>
            <Text variant="caption" tone="tertiary" style={{ marginTop: 2 }}>
              {item.topic}
              {item.world ? ` · ${item.world}` : ''} · {timeAgo(item.created_at)}
            </Text>
            {item.summary ? (
              <Text variant="caption" tone="secondary" style={{ marginTop: 4 }}>
                {item.summary.slice(0, 400)}
              </Text>
            ) : null}
          </Card>
        ))
      )}
    </Section>
  );
}

function CampaignsScreen({ campaigns }: { campaigns: OperatorCampaign[] }) {
  return (
    <Section title="Campaigns" caption="Content and marketing pushes the operator runs">
      {campaigns.length === 0 ? (
        <Empty icon="megaphone-outline" title="No campaigns" body="Campaigns created by the operator will appear here." />
      ) : (
        campaigns.map((campaign) => (
          <Card key={campaign.id}>
            <View style={styles.rowBetween}>
              <Text variant="label">{campaign.name}</Text>
              <Pill label={campaign.status} tone={statusTone(campaign.status)} />
            </View>
            <Text variant="caption" tone="tertiary" style={{ marginTop: 2 }}>
              {campaign.kind} · {timeAgo(campaign.created_at)}
              {campaign.ends_at ? ` · ends ${timeAgo(campaign.ends_at)}` : ''}
            </Text>
          </Card>
        ))
      )}
    </Section>
  );
}

function HealthScreen({
  health,
  schedules,
  audit,
}: {
  health?: { providers: OperatorProvider[]; workers: OperatorWorker[]; task_counts: Record<string, number> };
  schedules: OperatorSchedule[];
  audit: OperatorAuditEntry[];
}) {
  return (
    <>
      <Section title="Task counts" caption="Live queue distribution">
        <Card>
          <View style={styles.statGrid}>
            {Object.entries(health?.task_counts ?? {}).length === 0 ? (
              <Text variant="caption" tone="tertiary">
                No tasks recorded.
              </Text>
            ) : (
              Object.entries(health?.task_counts ?? {}).map(([status, count]) => (
                <Stat key={status} label={status} value={count} tone={statusTone(status)} />
              ))
            )}
          </View>
        </Card>
      </Section>

      <Section title="Workers" caption="Heartbeats from the 24/7 worker">
        {!health || health.workers.length === 0 ? (
          <Empty icon="heart-outline" title="No heartbeat yet" body="The worker records a heartbeat on every invocation." />
        ) : (
          health.workers.map((worker) => (
            <Card key={worker.worker_id}>
              <View style={styles.rowBetween}>
                <Text variant="label">{worker.worker_id}</Text>
                <Pill label={timeAgo(worker.last_seen_at)} tone={colors.info} />
              </View>
              <Text variant="caption" tone="tertiary" style={{ marginTop: 2 }}>
                v{worker.version ?? '—'} · {worker.tasks_processed ?? 0} processed
              </Text>
              {worker.last_error ? (
                <Text variant="caption" tone="danger" style={{ marginTop: 2 }}>
                  {worker.last_error}
                </Text>
              ) : null}
            </Card>
          ))
        )}
      </Section>

      <Section title="Schedules" caption="Recurring operator work">
        {schedules.length === 0 ? (
          <Text variant="caption" tone="tertiary">
            No schedules configured.
          </Text>
        ) : (
          schedules.map((schedule) => (
            <Card key={schedule.name}>
              <View style={styles.rowBetween}>
                <Text variant="label">{schedule.name}</Text>
                <Pill label={schedule.enabled ? 'enabled' : 'paused'} tone={schedule.enabled ? colors.success : colors.textTertiary} />
              </View>
              <Text variant="caption" tone="tertiary" style={{ marginTop: 2 }}>
                {schedule.task_type} · every {Math.round(schedule.cadence_seconds / 60)}m · last {schedule.last_run_at ? timeAgo(schedule.last_run_at) : 'never'}
              </Text>
            </Card>
          ))
        )}
      </Section>

      <Section title="Audit trail" caption="Immutable operator actions">
        {audit.length === 0 ? (
          <Text variant="caption" tone="tertiary">
            No audit entries yet.
          </Text>
        ) : (
          <Card>
            {audit.slice(0, 50).map((entry) => (
              <View key={entry.id} style={styles.auditRow}>
                <Text variant="caption" tone={entry.outcome === 'ok' || entry.outcome === 'succeeded' ? 'success' : 'secondary'} style={{ flex: 1 }}>
                  {entry.action}
                </Text>
                <Text variant="caption" tone="tertiary" numeric>
                  {timeAgo(entry.created_at)}
                </Text>
              </View>
            ))}
          </Card>
        )}
      </Section>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  identityBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: space.x4,
    paddingVertical: space.x2,
    backgroundColor: colors.glass,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.glassBorder,
  },
  identityDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  identityText: { flex: 1 },
  tabScroll: { flexGrow: 0 },
  tabRow: { paddingHorizontal: space.x4, paddingVertical: space.x3, gap: space.x2 },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: colors.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  tabActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: space.x4,
    marginBottom: space.x2,
    padding: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.danger,
  },
  body: { flex: 1 },
  bodyContent: { padding: space.x4, paddingBottom: space.x16, gap: space.x6 },
  loading: { alignItems: 'center', gap: space.x3, paddingVertical: space.x12 },
  section: { gap: 2 },
  card: {
    backgroundColor: colors.surface1,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    padding: space.x4,
    gap: 2,
  },
  cardActive: { borderColor: colors.accent },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.x4 },
  stat: { minWidth: 92, gap: 2 },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.x3 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, gap: space.x2 },
  messageRow: {
    paddingVertical: space.x2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  input: {
    minHeight: 84,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong ?? colors.borderSubtle,
    backgroundColor: colors.surface2,
    color: colors.textPrimary,
    padding: space.x3,
    textAlignVertical: 'top',
    fontSize: 15,
  },
  primaryButton: {
    marginTop: space.x3,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.45 },
  actionRow: { flexDirection: 'row', gap: space.x2, marginTop: space.x3 },
  smallButton: {
    paddingHorizontal: 14,
    height: 34,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  payload: {
    marginTop: 6,
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
  },
  usageRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  auditRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  familyLabel: { marginTop: space.x2, textTransform: 'uppercase', letterSpacing: 0.6 },
  empty: { alignItems: 'center', paddingVertical: space.x8, paddingHorizontal: space.x6 },
});
