// Hallyu AI Operator — Executive AI Command Centre.
//
// 7-section workspace:
// 1. Overview — System status, live platform metrics, operational health, alerts.
// 2. AI Workspace — Multi-turn conversation with persistent task history, real tool call tracing.
// 3. Intelligence — Deep platform metrics, community engagement, catalog sync reliability, reports.
// 4. Approvals — Fail-closed approval queue with formatted payload previews and risk verification.
// 5. Automations — Background intelligence schedules, enable/disable switches, manual execution.
// 6. Memory — Persistent operational knowledge base, kind filtering, search.
// 7. Activity & Audit — Full audit trail of tasks, tool calls, and publications.
//
// Spec: docs/HALLYU-AI-OPERATOR.md & HALLYU_AI_OPERATOR_STABILIZATION_PROMPT.md.
// All data is live from backend RPCs. No simulated metrics, mock analytics, or fake success states.

import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';
import { colors, palette, radius, space } from '../../constants/theme';
import { supabase } from '../../lib/api/client';
import { haptic, useApp } from '../../lib/hooks';
import { Button } from '../ui/Button';
import { Segmented, SegmentItem } from '../ui/Segmented';
import { EmptyState } from '../ui/States';
import { Text } from '../ui/Text';
import { useToast } from '../ui/Toast';

export type OperatorSection =
  | 'overview'
  | 'workspace'
  | 'intelligence'
  | 'approvals'
  | 'automations'
  | 'memory'
  | 'audit';

interface AiTask {
  id: string;
  kind: string;
  status: string;
  title: string;
  prompt: string;
  requester_role?: string | null;
  error: string | null;
  result: { answer?: string } | null;
  created_at: string;
  model?: string | null;
}

interface AiApproval {
  id: string;
  task_id: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  status: string;
  requested_at: string;
}

interface AiSchedule {
  id: string;
  name: string;
  kind: string;
  interval_minutes: number;
  enabled: boolean;
  config: Record<string, unknown> | null;
  last_run_at: string | null;
  last_status: string | null;
  created_at: string;
}

interface AiMemory {
  kind: string;
  key: string;
  value: Record<string, unknown> | string | number | boolean;
  task_id: string | null;
  created_at: string;
}

interface AiPublication {
  id: string;
  task_id: string | null;
  kind: string;
  target_id: string | null;
  parent_id: string | null;
  content: Record<string, unknown>;
  published_by: string;
  approved_by: string | null;
  created_at: string;
}

interface PlatformOverviewData {
  total_members: number;
  active_members: number;
  new_registrations_24h: number;
  public_posts_total: number;
  public_posts_24h: number;
  comments_total: number;
  comments_24h: number;
  open_reports: number;
  failed_catalog_jobs_24h: number;
  last_updated: string;
}

type Ping = {
  model_configured: boolean;
  provider: string;
  model: string;
  gemini_key_count?: number;
  gemini_keys?: {
    label: string;
    configured: boolean;
    status: string;
    consecutive_failures: number;
    cooldown_remaining_sec: number;
    last_latency_ms: number | null;
  }[];
  last_provider_failure?: { at: string; provider: string; error: string } | null;
  last_successful_inference?: { at: string; provider: string; key_label?: string; latency_ms: number } | null;
  failover_events?: { timestamp: string; from_key: string; to_key: string; reason: string }[];
  avg_latency_ms?: number | null;
  rork_fallback_enabled?: boolean;
  lovable_ai_configured?: boolean;
  staff: boolean;
  approval_mode: string;
  tools: string[];
};

const STATUS_TONE: Record<string, string> = {
  completed: colors.success,
  failed: colors.danger,
  cancelled: colors.textSecondary,
  running: palette.blue400,
  queued: colors.textSecondary,
  awaiting_approval: colors.warning,
};

function invoke<T>(body: Record<string, unknown>): Promise<T> {
  if (!supabase) return Promise.reject(new Error('This build has no backend connection.'));
  return supabase.functions.invoke<T>('hallyu-ai-operator', { body }).then(({ data, error }) => {
    if (error) throw new Error(error.message);
    return data as T;
  });
}

function invokeScheduler<T>(body: Record<string, unknown>): Promise<T> {
  if (!supabase) return Promise.reject(new Error('This build has no backend connection.'));
  return supabase.functions.invoke<T>('hallyu-ai-scheduler', { body }).then(({ data, error }) => {
    if (error) throw new Error(error.message);
    return data as T;
  });
}

export function HallyuAIPanel() {
  const { me } = useApp();
  const toast = useToast();

  const [section, setSection] = useState<OperatorSection>('overview');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live state
  const [ping, setPing] = useState<Ping | null>(null);
  const [tasks, setTasks] = useState<AiTask[]>([]);
  const [approvals, setApprovals] = useState<AiApproval[]>([]);
  const [schedules, setSchedules] = useState<AiSchedule[]>([]);
  const [memories, setMemories] = useState<AiMemory[]>([]);
  const [publications, setPublications] = useState<AiPublication[]>([]);
  const [overview, setOverview] = useState<PlatformOverviewData | null>(null);

  // Chat / Composer state
  const [promptInput, setPromptInput] = useState('');
  const [auditFilter, setAuditFilter] = useState<'all' | 'completed' | 'failed' | 'awaiting_approval' | 'publications'>('all');
  const [memorySearch, setMemorySearch] = useState('');
  const [memoryKindFilter, setMemoryKindFilter] = useState<string>('all');
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!supabase) throw new Error('This build has no backend connection.');
      const client = supabase;

      const [
        pingState,
        taskRows,
        approvalRows,
        scheduleRows,
        memoryRows,
        publicationRows,
        overviewData,
      ] = await Promise.all([
        invoke<Ping>({ action: 'ping' }).catch((e) => {
          console.warn('Ping failed:', e);
          return null;
        }),
        client.rpc('hallyu_ai_admin_tasks', { p_limit: 40 }),
        client.rpc('hallyu_ai_admin_approvals'),
        client.rpc('hallyu_ai_admin_schedules'),
        client.rpc('hallyu_ai_admin_memories', { p_limit: 50 }),
        client.rpc('hallyu_ai_admin_publications', { p_limit: 50 }),
        Promise.resolve(client.rpc('hallyu_ai_platform_overview')).then((res) => res, () => ({ data: null })),
      ]);

      if (pingState) setPing(pingState);
      setTasks((taskRows.data as AiTask[]) ?? []);
      setApprovals((approvalRows.data as AiApproval[]) ?? []);
      setSchedules((scheduleRows.data as AiSchedule[]) ?? []);
      setMemories((memoryRows.data as AiMemory[]) ?? []);
      setPublications((publicationRows.data as AiPublication[]) ?? []);
      if (overviewData?.data) {
        setOverview(overviewData.data as PlatformOverviewData);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Section tabs
  const sectionItems: SegmentItem<OperatorSection>[] = useMemo(
    () => [
      { key: 'overview', label: 'Overview' },
      { key: 'workspace', label: 'Workspace' },
      { key: 'intelligence', label: 'Intelligence' },
      {
        key: 'approvals',
        label: 'Approvals',
        count: approvals.length > 0 ? approvals.length : undefined,
      },
      { key: 'automations', label: 'Automations' },
      { key: 'memory', label: 'Memory' },
      { key: 'audit', label: 'Audit' },
    ],
    [approvals.length],
  );

  // Send action in Workspace
  const handleSendPrompt = async (presetText?: string) => {
    const text = (presetText ?? promptInput).trim();
    if (!text || busy) return;
    setBusy(true);
    haptic.light();
    try {
      const outcome = await invoke<{ status?: string; detail?: string; error?: string; answer?: string }>({
        action: 'chat',
        prompt: text,
      });
      if (outcome.error) throw new Error(outcome.error);

      toast.show({
        message:
          outcome.status === 'awaiting_approval'
            ? outcome.detail ?? 'Action queued for human approval.'
            : 'Operator task completed.',
        tone: outcome.status === 'awaiting_approval' ? 'default' : 'success',
      });
      if (!presetText) setPromptInput('');
      await loadAll();
    } catch (e) {
      toast.show({
        message: e instanceof Error ? e.message : 'Operator request failed.',
        tone: 'danger',
      });
      await loadAll();
    } finally {
      setBusy(false);
    }
  };

  // Approval decision
  const handleDecideApproval = async (approvalId: string, approve: boolean) => {
    setBusy(true);
    haptic.medium();
    try {
      await invoke({ action: 'approval.decide', approval_id: approvalId, approve });
      toast.show({
        message: approve ? 'Approved — task resumed.' : 'Rejected — task cancelled.',
        tone: approve ? 'success' : 'default',
      });
      await loadAll();
    } catch (e) {
      toast.show({
        message: e instanceof Error ? e.message : 'Decision rejected by backend.',
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  };

  // Toggle automation schedule
  const handleToggleSchedule = async (scheduleId: string, currentEnabled: boolean) => {
    if (!supabase) return;
    haptic.light();
    try {
      const nextState = !currentEnabled;
      const { error: rpcError } = await supabase.rpc('hallyu_ai_admin_toggle_schedule', {
        p_id: scheduleId,
        p_enabled: nextState,
      });
      if (rpcError) throw new Error(rpcError.message);
      toast.show({
        message: nextState ? 'Schedule enabled' : 'Schedule disabled',
        tone: 'success',
      });
      await loadAll();
    } catch (e) {
      toast.show({
        message: e instanceof Error ? e.message : 'Failed to update schedule',
        tone: 'danger',
      });
    }
  };

  // Manually run a schedule ("Run Now") with full verification
  const handleRunScheduleNow = async (scheduleId: string, scheduleName: string) => {
    setBusy(true);
    haptic.medium();
    try {
      const outcome = await invokeScheduler<{
        status?: string;
        schedule?: string;
        task_id?: string;
        answer?: string;
        error?: string;
        detail?: string;
      }>({ schedule_id: scheduleId, force: true });

      if (outcome?.error) throw new Error(outcome.error);
      if (outcome?.status === 'failed') throw new Error(outcome.error || 'Schedule execution failed');

      toast.show({
        message: outcome?.answer
          ? `Executed: ${outcome.answer.slice(0, 60)}...`
          : `Executed ${scheduleName}`,
        tone: 'success',
      });
      await loadAll();
    } catch (e) {
      toast.show({
        message: e instanceof Error ? e.message : 'Failed to trigger schedule run',
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  };

  // Filtered memories
  const filteredMemories = useMemo(() => {
    return memories.filter((m) => {
      const matchesKind = memoryKindFilter === 'all' || m.kind === memoryKindFilter;
      const matchesQuery =
        !memorySearch.trim() ||
        m.key.toLowerCase().includes(memorySearch.toLowerCase()) ||
        JSON.stringify(m.value).toLowerCase().includes(memorySearch.toLowerCase());
      return matchesKind && matchesQuery;
    });
  }, [memories, memoryKindFilter, memorySearch]);

  // Filtered tasks for audit
  const filteredTasks = useMemo(() => {
    if (auditFilter === 'publications') return [];
    if (auditFilter === 'all') return tasks;
    return tasks.filter((t) => t.status === auditFilter);
  }, [tasks, auditFilter]);

  return (
    <View style={styles.container}>
      {/* ── Executive Header ── */}
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <View style={styles.headerBadge}>
            <Ionicons name="sparkles" size={16} color={palette.blue400} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2 }}>
              <Text variant="title">Hallyu AI Operator</Text>
              <View
                style={[
                  styles.statusPill,
                  {
                    backgroundColor: ping?.model_configured
                      ? 'rgba(52, 211, 153, 0.15)'
                      : 'rgba(239, 68, 68, 0.15)',
                  },
                ]}
              >
                <View
                  style={[
                    styles.statusDot,
                    { backgroundColor: ping?.model_configured ? colors.success : colors.danger },
                  ]}
                />
                <Text
                  variant="caption"
                  style={{
                    color: ping?.model_configured ? colors.success : colors.danger,
                    fontSize: 11,
                    fontWeight: '600',
                  }}
                >
                  {ping?.model_configured ? `${ping.provider.toUpperCase()} (${ping.model})` : 'NO MODEL CREDENTIAL'}
                </Text>
              </View>
            </View>
            <Text variant="caption" tone="secondary" style={{ marginTop: 2 }}>
              Verified Executive Command Centre · Gate: Fail-Closed (Staff Enforced)
            </Text>
          </View>
          <Pressable onPress={() => void loadAll()} disabled={loading} hitSlop={12} style={styles.iconButton}>
            <Ionicons name="refresh" size={18} color={loading ? colors.textDisabled : palette.blue400} />
          </Pressable>
        </View>

        {error ? (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color={colors.danger} />
            <Text variant="caption" style={{ color: colors.danger, flex: 1 }}>
              {error}
            </Text>
          </View>
        ) : null}

        {/* ── Navigation Tabs ── */}
        <Segmented
          items={sectionItems}
          value={section}
          onChange={(s) => {
            haptic.select();
            setSection(s);
          }}
          variant="pill"
          style={{ marginTop: space.x2 }}
        />
      </View>

      {/* ── Content Body ── */}
      <ScrollView
        contentContainerStyle={styles.contentContainer}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadAll()} />}
      >
        {/* ─────────────────────────────────────────────────────────────
            1. OVERVIEW
           ───────────────────────────────────────────────────────────── */}
        {section === 'overview' ? (
          <View style={styles.sectionBody}>
            {/* Provider & Rotation Observability Card */}
            <View style={styles.providerCard}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x1 }}>
                  <Ionicons name="hardware-chip-outline" size={18} color={palette.blue400} />
                  <Text variant="body" style={{ fontWeight: '700', color: colors.textPrimary }}>
                    Inference & Multi-Key Rotation
                  </Text>
                </View>
                <View
                  style={[
                    styles.statusPill,
                    {
                      backgroundColor: ping?.model_configured
                        ? 'rgba(52, 211, 153, 0.15)'
                        : 'rgba(239, 68, 68, 0.15)',
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.statusDot,
                      { backgroundColor: ping?.model_configured ? colors.success : colors.danger },
                    ]}
                  />
                  <Text
                    variant="caption"
                    style={{
                      color: ping?.model_configured ? colors.success : colors.danger,
                      fontSize: 11,
                      fontWeight: '700',
                    }}
                  >
                    {ping?.provider?.toUpperCase() ?? 'NONE'}
                  </Text>
                </View>
              </View>

              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.x2, marginTop: space.x1 }}>
                <View style={{ flex: 1, minWidth: 140 }}>
                  <Text variant="caption" tone="tertiary">
                    ACTIVE MODEL
                  </Text>
                  <Text variant="body" style={{ fontWeight: '600', color: colors.textPrimary }}>
                    {ping?.model ?? 'None'}
                  </Text>
                </View>

                <View style={{ flex: 1, minWidth: 140 }}>
                  <Text variant="caption" tone="tertiary">
                    AVG LATENCY
                  </Text>
                  <Text variant="body" style={{ fontWeight: '600', color: colors.textPrimary }}>
                    {ping?.avg_latency_ms ? `${ping.avg_latency_ms} ms` : '—'}
                  </Text>
                </View>

                <View style={{ flex: 1, minWidth: 140 }}>
                  <Text variant="caption" tone="tertiary">
                    GEMINI KEYS CONFIGURED
                  </Text>
                  <Text variant="body" style={{ fontWeight: '600', color: colors.textPrimary }}>
                    {ping?.gemini_key_count !== undefined ? `${ping.gemini_key_count} / 3 keys` : '—'}
                  </Text>
                </View>
              </View>

              {/* Individual Key Health Badges */}
              {ping?.gemini_keys && ping.gemini_keys.length > 0 ? (
                <View style={{ flexDirection: 'row', gap: space.x1, marginTop: space.x2 }}>
                  {ping.gemini_keys.map((k) => {
                    const isHealthy = k.configured && k.status === 'healthy';
                    const isCooling = k.configured && (k.status === 'cooling_down' || k.status === 'rate_limited');
                    const isError = k.configured && k.status === 'error';
                    const tint = !k.configured ? colors.textDisabled : isHealthy ? colors.success : isCooling ? colors.warning : colors.danger;
                    const bg = !k.configured ? 'rgba(156, 163, 175, 0.1)' : isHealthy ? 'rgba(52, 211, 153, 0.12)' : isCooling ? 'rgba(251, 191, 36, 0.12)' : 'rgba(239, 68, 68, 0.12)';
                    const labelText = !k.configured
                      ? `${k.label}: not set`
                      : isCooling
                      ? `${k.label}: cool (${k.cooldown_remaining_sec}s)`
                      : `${k.label}: ${k.status}`;

                    return (
                      <View key={k.label} style={[styles.keyBadge, { backgroundColor: bg, borderColor: tint }]}>
                        <View style={[styles.statusDot, { backgroundColor: tint }]} />
                        <Text variant="caption" style={{ color: tint, fontSize: 10, fontWeight: '600' }}>
                          {labelText}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              ) : null}

              {/* Failover and Fallback status */}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', marginTop: space.x2, paddingTop: space.x1, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.borderSubtle }}>
                <Text variant="caption" tone="secondary">
                  Failovers: {ping?.failover_events?.length ?? 0} · Lovable AI: {ping?.lovable_ai_configured ? 'Ready' : 'Off'} · Rork: {ping?.rork_fallback_enabled ? 'Enabled' : 'Disabled (Default)'}
                </Text>
                {ping?.last_successful_inference ? (
                  <Text variant="caption" tone="tertiary">
                    Last success: {new Date(ping.last_successful_inference.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </Text>
                ) : null}
              </View>
            </View>

            {/* Quick KPI grid from platform_overview */}
            <View style={styles.grid}>
              <View style={styles.kpiCard}>
                <Text variant="caption" tone="tertiary">
                  MEMBERS (ACTIVE / TOTAL)
                </Text>
                <Text variant="title" style={styles.kpiValue}>
                  {overview ? `${overview.active_members} / ${overview.total_members}` : '—'}
                </Text>
                <Text variant="caption" tone="secondary">
                  {overview ? `+${overview.new_registrations_24h} in last 24h` : 'No live telemetry'}
                </Text>
              </View>

              <View style={styles.kpiCard}>
                <Text variant="caption" tone="tertiary">
                  FEED POSTS (24H / TOTAL)
                </Text>
                <Text variant="title" style={styles.kpiValue}>
                  {overview ? `${overview.public_posts_24h} / ${overview.public_posts_total}` : '—'}
                </Text>
                <Text variant="caption" tone="secondary">
                  {overview ? `${overview.comments_total} total comments` : 'No live telemetry'}
                </Text>
              </View>

              <View style={styles.kpiCard}>
                <Text variant="caption" tone="tertiary">
                  MODERATION WORKLOAD
                </Text>
                <Text
                  variant="title"
                  style={[
                    styles.kpiValue,
                    { color: overview && overview.open_reports > 0 ? colors.warning : colors.textPrimary },
                  ]}
                >
                  {overview ? overview.open_reports : '—'}
                </Text>
                <Text variant="caption" tone="secondary">
                  Open community reports
                </Text>
              </View>

              <View style={styles.kpiCard}>
                <Text variant="caption" tone="tertiary">
                  CATALOG RELIABILITY
                </Text>
                <Text
                  variant="title"
                  style={[
                    styles.kpiValue,
                    { color: overview && overview.failed_catalog_jobs_24h > 0 ? colors.danger : colors.success },
                  ]}
                >
                  {overview ? overview.failed_catalog_jobs_24h : '—'}
                </Text>
                <Text variant="caption" tone="secondary">
                  Failed sync jobs (24h)
                </Text>
              </View>
            </View>

            {/* Quick Action / Launchpad */}
            <View style={styles.actionCard}>
              <View style={{ flex: 1, gap: 4 }}>
                <Text variant="label">AI Executive Workspace</Text>
                <Text variant="caption" tone="secondary">
                  Task the AI operator with platform analysis, draft announcements, or community pulse investigations.
                </Text>
              </View>
              <Button
                label="Open Workspace"
                variant="primary"
                size="sm"
                onPress={() => setSection('workspace')}
              />
            </View>

            {/* Pending Approvals Notice */}
            {approvals.length > 0 ? (
              <View style={[styles.card, { borderColor: colors.warning, borderLeftWidth: 3 }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2 }}>
                  <Ionicons name="time" size={18} color={colors.warning} />
                  <Text variant="label" style={{ color: colors.warning }}>
                    {approvals.length} Action{approvals.length > 1 ? 's' : ''} Awaiting Executive Approval
                  </Text>
                </View>
                <Text variant="caption" tone="secondary" style={{ marginTop: 4 }}>
                  Public announcements and publishing actions are paused fail-closed until verified by an authorized staff member.
                </Text>
                <View style={{ marginTop: space.x2 }}>
                  <Button
                    label="Review Approvals"
                    variant="ghost"
                    size="sm"
                    onPress={() => setSection('approvals')}
                  />
                </View>
              </View>
            ) : null}

            {/* Recent Tasks Preview */}
            <View style={{ gap: space.x2, marginTop: space.x2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text variant="label">Recent Operator Tasks</Text>
                <View style={{ flex: 1 }} />
                <Pressable onPress={() => setSection('audit')}>
                  <Text variant="caption" style={{ color: palette.blue400 }}>
                    View full audit →
                  </Text>
                </Pressable>
              </View>

              {tasks.slice(0, 3).map((task) => (
                <View key={task.id} style={[styles.card, { borderLeftColor: STATUS_TONE[task.status] ?? colors.borderSubtle, borderLeftWidth: 3 }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text variant="caption" tone="tertiary">
                      {task.kind.toUpperCase()}
                    </Text>
                    <Text variant="caption" tone="tertiary">·</Text>
                    <Text variant="caption" style={{ color: STATUS_TONE[task.status] ?? colors.textSecondary }}>
                      {task.status.toUpperCase()}
                    </Text>
                    <View style={{ flex: 1 }} />
                    <Text variant="caption" tone="tertiary">
                      {new Date(task.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </Text>
                  </View>
                  <Text variant="label" style={{ marginTop: 4 }}>
                    {task.title}
                  </Text>
                  {task.result?.answer ? (
                    <Text variant="caption" tone="secondary" numberOfLines={2} style={{ marginTop: 4 }}>
                      {task.result.answer}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* ─────────────────────────────────────────────────────────────
            2. AI WORKSPACE
           ───────────────────────────────────────────────────────────── */}
        {section === 'workspace' ? (
          <View style={styles.sectionBody}>
            {/* Suggested prompts */}
            <View style={{ gap: space.x2 }}>
              <Text variant="caption" tone="tertiary">
                SUGGESTED OPERATIONAL INQUIRIES
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.x2 }}>
                {[
                  'Give me platform overview and key telemetry',
                  'Check community pulse for trending discussions',
                  'Inspect open moderation reports and catalog sync status',
                  'Recall operational memories regarding campaign outcomes',
                ].map((preset, idx) => (
                  <Pressable
                    key={idx}
                    style={styles.suggestionChip}
                    onPress={() => void handleSendPrompt(preset)}
                    disabled={busy}
                  >
                    <Text variant="caption" style={{ color: palette.blue400 }}>
                      {preset}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>

            {/* Composer */}
            <View style={styles.composerCard}>
              <TextInput
                value={promptInput}
                onChangeText={setPromptInput}
                placeholder={me.role === 'ceo' ? 'Ask Hallyu AI as CEO…' : 'Enter operational task or question…'}
                placeholderTextColor={colors.textTertiary}
                multiline
                style={styles.composerInput}
              />
              <View style={styles.composerFooter}>
                <Text variant="caption" tone="tertiary">
                  Verified tools: platform_overview, community_pulse, remember, recall_memory, publish_post
                </Text>
                <Button
                  label={busy ? 'Thinking…' : 'Execute'}
                  variant="primary"
                  size="sm"
                  disabled={busy || !promptInput.trim()}
                  onPress={() => void handleSendPrompt()}
                />
              </View>
            </View>

            {/* Conversation / Task Stream */}
            <View style={{ gap: space.x3, marginTop: space.x2 }}>
              <Text variant="label">Conversation & Task Stream</Text>
              {tasks.length === 0 && !loading ? (
                <EmptyState
                  icon="sparkles-outline"
                  title="No workspace tasks yet"
                  body="Type a prompt above or tap a suggested inquiry to start real operator investigation."
                />
              ) : null}

              {tasks.map((task) => (
                <View key={task.id} style={styles.messageCard}>
                  {/* User request */}
                  <View style={styles.userBubble}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text variant="caption" style={{ fontWeight: '700', color: palette.blue400 }}>
                        {task.requester_role ? task.requester_role.toUpperCase() : 'USER'}
                      </Text>
                      <View style={{ flex: 1 }} />
                      <Text variant="caption" tone="tertiary">
                        {new Date(task.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                      </Text>
                    </View>
                    <Text variant="body" style={{ marginTop: 4 }}>
                      {task.prompt || task.title}
                    </Text>
                  </View>

                  {/* AI Response */}
                  <View
                    style={[
                      styles.aiBubble,
                      {
                        borderLeftColor: STATUS_TONE[task.status] ?? colors.borderSubtle,
                        borderLeftWidth: 3,
                      },
                    ]}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Ionicons name="sparkles" size={14} color={palette.blue400} />
                      <Text variant="caption" style={{ fontWeight: '700', color: colors.textPrimary }}>
                        HALLYU AI
                      </Text>
                      <View style={{ flex: 1 }} />
                      <View
                        style={[
                          styles.statusPill,
                          {
                            backgroundColor:
                              task.status === 'completed'
                                ? 'rgba(52, 211, 153, 0.15)'
                                : task.status === 'awaiting_approval'
                                  ? 'rgba(251, 191, 36, 0.15)'
                                  : 'rgba(239, 68, 68, 0.15)',
                          },
                        ]}
                      >
                        <Text
                          variant="caption"
                          style={{
                            color: STATUS_TONE[task.status] ?? colors.textSecondary,
                            fontSize: 10,
                            fontWeight: '600',
                          }}
                        >
                          {task.status.toUpperCase()}
                        </Text>
                      </View>
                    </View>

                    {task.result?.answer ? (
                      <Text variant="body" style={{ marginTop: 8, color: colors.textPrimary }}>
                        {task.result.answer}
                      </Text>
                    ) : null}

                    {task.error ? (
                      <Text variant="caption" style={{ marginTop: 6, color: colors.danger }}>
                        Failure: {task.error}
                      </Text>
                    ) : null}

                    {task.status === 'awaiting_approval' ? (
                      <View style={styles.awaitingBox}>
                        <Ionicons name="time" size={14} color={colors.warning} />
                        <Text variant="caption" style={{ color: colors.warning, flex: 1 }}>
                          Task paused: action requires staff approval in the Approvals Centre.
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* ─────────────────────────────────────────────────────────────
            3. INTELLIGENCE
           ───────────────────────────────────────────────────────────── */}
        {section === 'intelligence' ? (
          <View style={styles.sectionBody}>
            <View style={styles.card}>
              <Text variant="title">Verified Platform Intelligence</Text>
              <Text variant="caption" tone="secondary" style={{ marginTop: 4 }}>
                Real backend evidence queried from production tables. Every metric reflects strict time windows and verified states.
              </Text>
              {overview?.last_updated ? (
                <Text variant="caption" tone="tertiary" style={{ marginTop: 4 }}>
                  Last telemetry refresh: {new Date(overview.last_updated).toLocaleTimeString()}
                </Text>
              ) : null}
            </View>

            <View style={styles.card}>
              <Text variant="label">Community Engagement & Content</Text>
              <View style={styles.rowItem}>
                <Text variant="body">Active Profiles</Text>
                <Text variant="body" style={{ fontWeight: '700' }}>
                  {overview?.active_members ?? '—'}
                </Text>
              </View>
              <View style={styles.rowItem}>
                <Text variant="body">Total Member Accounts</Text>
                <Text variant="body" style={{ fontWeight: '700' }}>
                  {overview?.total_members ?? '—'}
                </Text>
              </View>
              <View style={styles.rowItem}>
                <Text variant="body">Public Posts (Last 24 Hours)</Text>
                <Text variant="body" style={{ fontWeight: '700', color: palette.blue400 }}>
                  {overview?.public_posts_24h ?? '—'}
                </Text>
              </View>
              <View style={styles.rowItem}>
                <Text variant="body">Total Active Public Posts</Text>
                <Text variant="body" style={{ fontWeight: '700' }}>
                  {overview?.public_posts_total ?? '—'}
                </Text>
              </View>
              <View style={styles.rowItem}>
                <Text variant="body">Active Comments (Last 24 Hours)</Text>
                <Text variant="body" style={{ fontWeight: '700', color: palette.blue400 }}>
                  {overview?.comments_24h ?? '—'}
                </Text>
              </View>
            </View>

            <View style={styles.card}>
              <Text variant="label">Operational Integrity</Text>
              <View style={styles.rowItem}>
                <Text variant="body">Open Moderation Reports</Text>
                <Text
                  variant="body"
                  style={{
                    fontWeight: '700',
                    color: overview && overview.open_reports > 0 ? colors.warning : colors.success,
                  }}
                >
                  {overview?.open_reports ?? '—'}
                </Text>
              </View>
              <View style={styles.rowItem}>
                <Text variant="body">Catalog Sync Failures (24h)</Text>
                <Text
                  variant="body"
                  style={{
                    fontWeight: '700',
                    color: overview && overview.failed_catalog_jobs_24h > 0 ? colors.danger : colors.success,
                  }}
                >
                  {overview?.failed_catalog_jobs_24h ?? '—'}
                </Text>
              </View>
            </View>

            <View style={styles.actionCard}>
              <View style={{ flex: 1 }}>
                <Text variant="label">Run Pulse Investigation</Text>
                <Text variant="caption" tone="secondary">
                  Instruct the operator to scan active posts and comments for emerging topics.
                </Text>
              </View>
              <Button
                label="Run Pulse"
                variant="primary"
                size="sm"
                disabled={busy}
                onPress={() => void handleSendPrompt('Investigate community_pulse for new posts and summarize active topics.')}
              />
            </View>
          </View>
        ) : null}

        {/* ─────────────────────────────────────────────────────────────
            4. APPROVALS
           ───────────────────────────────────────────────────────────── */}
        {section === 'approvals' ? (
          <View style={styles.sectionBody}>
            <View style={styles.card}>
              <Text variant="title">Approval Centre</Text>
              <Text variant="caption" tone="secondary" style={{ marginTop: 4 }}>
                High-impact operator actions (broadcasts, public posts, poll creation) pause here fail-closed.
                Approval requires verified staff identity and exact argument matching.
              </Text>
            </View>

            {approvals.length === 0 ? (
              <EmptyState
                icon="shield-checkmark"
                title="Approval queue clear"
                body="There are no pending public-facing operator requests. Any gated tool execution will appear here for staff authorization."
              />
            ) : null}

            {approvals.map((approval) => (
              <View key={approval.id} style={[styles.card, { borderColor: colors.warning, borderLeftWidth: 4 }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2 }}>
                  <Ionicons name="alert-circle" size={18} color={colors.warning} />
                  <Text variant="label" style={{ color: colors.warning }}>
                    Gated Action: {approval.tool}
                  </Text>
                  <View style={{ flex: 1 }} />
                  <Text variant="caption" tone="tertiary">
                    {new Date(approval.requested_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </Text>
                </View>

                <Text variant="caption" tone="secondary" style={{ marginTop: 6 }}>
                  Reason: {approval.reason}
                </Text>

                {/* Formatted payload preview */}
                <View style={styles.payloadBox}>
                  <Text variant="caption" style={{ fontWeight: '700', color: palette.blue400 }}>
                    EXACT PAYLOAD PROPOSAL:
                  </Text>
                  {typeof approval.args.title === 'string' ? (
                    <Text variant="caption" style={{ color: colors.textPrimary, marginTop: 2 }}>
                      Title: {approval.args.title}
                    </Text>
                  ) : null}
                  {typeof approval.args.body === 'string' ? (
                    <Text variant="caption" style={{ color: colors.textPrimary, marginTop: 2 }}>
                      Body: {approval.args.body}
                    </Text>
                  ) : null}
                  {typeof approval.args.question === 'string' ? (
                    <Text variant="caption" style={{ color: colors.textPrimary, marginTop: 2 }}>
                      Poll Question: {approval.args.question}
                    </Text>
                  ) : null}
                  {Array.isArray(approval.args.options) ? (
                    <Text variant="caption" style={{ color: colors.textPrimary, marginTop: 2 }}>
                      Poll Options: {approval.args.options.join(' · ')}
                    </Text>
                  ) : null}
                  <Text variant="caption" tone="tertiary" style={{ marginTop: 4, fontSize: 10 }}>
                    Raw JSON: {JSON.stringify(approval.args)}
                  </Text>
                </View>

                <View style={{ flexDirection: 'row', gap: space.x2, marginTop: space.x3 }}>
                  <Button
                    label="Authorize & Execute"
                    variant="primary"
                    size="sm"
                    disabled={busy}
                    onPress={() => void handleDecideApproval(approval.id, true)}
                  />
                  <Button
                    label="Reject Action"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onPress={() => void handleDecideApproval(approval.id, false)}
                  />
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {/* ─────────────────────────────────────────────────────────────
            5. AUTOMATIONS
           ───────────────────────────────────────────────────────────── */}
        {section === 'automations' ? (
          <View style={styles.sectionBody}>
            <View style={styles.card}>
              <Text variant="title">Automations & Intelligence Schedules</Text>
              <Text variant="caption" tone="secondary" style={{ marginTop: 4 }}>
                Schedules are defined in hallyu_ai_schedule and executed via the hallyu-ai-scheduler Edge Function.
                Disabled schedules are skipped until activated and verified.
              </Text>
            </View>

            {schedules.length === 0 ? (
              <EmptyState
                icon="time-outline"
                title="No schedules configured"
                body="Seed schedules can be populated via migration 72."
              />
            ) : null}

            {schedules.map((schedule) => (
              <View key={schedule.id} style={styles.card}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="label">{schedule.name}</Text>
                    <Text variant="caption" tone="tertiary">
                      Kind: {schedule.kind} · Interval: {schedule.interval_minutes} mins
                    </Text>
                  </View>
                  <Switch
                    value={schedule.enabled}
                    onValueChange={() => void handleToggleSchedule(schedule.id, schedule.enabled)}
                    trackColor={{ false: palette.ink700, true: palette.blue400 }}
                  />
                </View>

                <View style={styles.scheduleMeta}>
                  <Text variant="caption" tone="secondary">
                    Last Run:{' '}
                    {schedule.last_run_at
                      ? new Date(schedule.last_run_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
                      : 'Never executed'}
                  </Text>
                  <Text
                    variant="caption"
                    style={{
                      color:
                        schedule.last_status === 'ok'
                          ? colors.success
                          : schedule.last_status?.startsWith('failed')
                            ? colors.danger
                            : colors.textTertiary,
                    }}
                  >
                    Status: {schedule.last_status ?? 'Idle'}
                  </Text>
                </View>

                <View style={{ marginTop: space.x2 }}>
                  <Button
                    label="Run Now"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onPress={() => void handleRunScheduleNow(schedule.id, schedule.name)}
                  />
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {/* ─────────────────────────────────────────────────────────────
            6. MEMORY
           ───────────────────────────────────────────────────────────── */}
        {section === 'memory' ? (
          <View style={styles.sectionBody}>
            <View style={styles.card}>
              <Text variant="title">Executive Memory Knowledge Base</Text>
              <Text variant="caption" tone="secondary" style={{ marginTop: 4 }}>
                Persistent operational knowledge (decisions, campaign outcomes, patterns, notes).
                Staff only; sensitive configuration keys are never returned.
              </Text>

              {/* Search & Kind filters */}
              <TextInput
                value={memorySearch}
                onChangeText={setMemorySearch}
                placeholder="Search operational memories…"
                placeholderTextColor={colors.textTertiary}
                style={styles.searchInput}
              />

              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.x2, marginTop: space.x2 }}>
                {['all', 'decision', 'campaign_outcome', 'pattern', 'note'].map((k) => (
                  <Pressable
                    key={k}
                    onPress={() => setMemoryKindFilter(k)}
                    style={[
                      styles.filterChip,
                      memoryKindFilter === k ? { backgroundColor: palette.blue400 } : null,
                    ]}
                  >
                    <Text
                      variant="caption"
                      style={{
                        color: memoryKindFilter === k ? palette.ink1000 : colors.textSecondary,
                        fontWeight: '600',
                      }}
                    >
                      {k.toUpperCase()}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>

            {filteredMemories.length === 0 ? (
              <EmptyState
                icon="document-text-outline"
                title="No memories match"
                body="Save memories via the remember tool or clear filters to view stored entries."
              />
            ) : null}

            {filteredMemories.map((m, idx) => (
              <View key={`${m.kind}-${m.key}-${idx}`} style={styles.card}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2 }}>
                  <View style={styles.kindBadge}>
                    <Text variant="caption" style={{ color: palette.blue400, fontSize: 10, fontWeight: '700' }}>
                      {m.kind.toUpperCase()}
                    </Text>
                  </View>
                  <Text variant="label" style={{ flex: 1 }}>
                    {m.key}
                  </Text>
                </View>
                <View style={styles.payloadBox}>
                  <Text variant="caption" style={{ color: colors.textPrimary }}>
                    {typeof m.value === 'object' ? JSON.stringify(m.value, null, 2) : String(m.value)}
                  </Text>
                </View>
                <Text variant="caption" tone="tertiary" style={{ marginTop: 4 }}>
                  Stored: {new Date(m.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* ─────────────────────────────────────────────────────────────
            7. ACTIVITY & AUDIT
           ───────────────────────────────────────────────────────────── */}
        {section === 'audit' ? (
          <View style={styles.sectionBody}>
            <View style={styles.card}>
              <Text variant="title">Execution & Publication Audit</Text>
              <Text variant="caption" tone="secondary" style={{ marginTop: 4 }}>
                Immutable audit ledger recording all tasks, tool calls, and approved publications.
              </Text>

              {/* Filter tabs */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.x2, marginTop: space.x2 }}>
                {(['all', 'completed', 'failed', 'awaiting_approval', 'publications'] as const).map((f) => (
                  <Pressable
                    key={f}
                    onPress={() => setAuditFilter(f)}
                    style={[
                      styles.filterChip,
                      auditFilter === f ? { backgroundColor: palette.blue400 } : null,
                    ]}
                  >
                    <Text
                      variant="caption"
                      style={{
                        color: auditFilter === f ? palette.ink1000 : colors.textSecondary,
                        fontWeight: '600',
                      }}
                    >
                      {f.toUpperCase()}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>

            {/* Publication audit stream */}
            {auditFilter === 'publications' ? (
              <View style={{ gap: space.x2 }}>
                {publications.length === 0 ? (
                  <EmptyState
                    icon="newspaper-outline"
                    title="No AI publications recorded"
                    body="Approved posts, replies, and polls executed via hallyu_ai_publish are logged here."
                  />
                ) : null}

                {publications.map((p) => (
                  <View key={p.id} style={styles.card}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2 }}>
                      <Ionicons name="megaphone" size={16} color={palette.blue400} />
                      <Text variant="label">{p.kind.toUpperCase()}</Text>
                      <View style={{ flex: 1 }} />
                      <Text variant="caption" tone="tertiary">
                        {new Date(p.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                      </Text>
                    </View>
                    <Text variant="caption" tone="secondary" style={{ marginTop: 4 }}>
                      Target: {p.target_id ?? 'None'} · Published By: {p.published_by}
                    </Text>
                    <View style={styles.payloadBox}>
                      <Text variant="caption" style={{ color: colors.textPrimary }}>
                        {JSON.stringify(p.content, null, 2)}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              /* Task audit stream */
              <View style={{ gap: space.x2 }}>
                {filteredTasks.length === 0 ? (
                  <EmptyState icon="list-outline" title="No tasks match filter" body="Try selecting a different filter above." />
                ) : null}

                {filteredTasks.map((t) => {
                  const isExpanded = expandedTaskId === t.id;
                  return (
                    <Pressable
                      key={t.id}
                      onPress={() => setExpandedTaskId(isExpanded ? null : t.id)}
                      style={[
                        styles.card,
                        { borderLeftColor: STATUS_TONE[t.status] ?? colors.borderSubtle, borderLeftWidth: 3 },
                      ]}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text variant="caption" tone="tertiary">
                          {t.kind.toUpperCase()}
                        </Text>
                        <Text variant="caption" tone="tertiary">·</Text>
                        <Text variant="caption" style={{ color: STATUS_TONE[t.status] ?? colors.textSecondary }}>
                          {t.status.toUpperCase()}
                        </Text>
                        <View style={{ flex: 1 }} />
                        <Text variant="caption" tone="tertiary">
                          {new Date(t.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </Text>
                      </View>

                      <Text variant="label" style={{ marginTop: 4 }}>
                        {t.title}
                      </Text>

                      {t.result?.answer ? (
                        <Text
                          variant="caption"
                          tone="secondary"
                          numberOfLines={isExpanded ? undefined : 2}
                          style={{ marginTop: 4 }}
                        >
                          {t.result.answer}
                        </Text>
                      ) : null}

                      {t.error ? (
                        <Text variant="caption" style={{ marginTop: 4, color: colors.danger }}>
                          Error: {t.error}
                        </Text>
                      ) : null}

                      <Text variant="caption" tone="tertiary" style={{ marginTop: 6, fontSize: 10 }}>
                        Task ID: {t.id} {isExpanded ? '▲' : '▼ Tap to inspect'}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: space.x3,
  },
  header: {
    backgroundColor: colors.surface1,
    borderRadius: radius.md,
    padding: space.x3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    gap: space.x2,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
  },
  headerBadge: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(96, 165, 250, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  iconButton: {
    padding: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.surface2,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    padding: space.x2,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  contentContainer: {
    gap: space.x3,
    paddingBottom: space.x6,
  },
  sectionBody: {
    gap: space.x3,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.x2,
  },
  kpiCard: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: colors.surface1,
    borderRadius: radius.md,
    padding: space.x3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    gap: 2,
  },
  providerCard: {
    backgroundColor: colors.surface1,
    borderRadius: radius.md,
    padding: space.x3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    gap: space.x1,
  },
  keyBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  kpiValue: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  card: {
    backgroundColor: colors.surface1,
    borderRadius: radius.md,
    padding: space.x3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    gap: 2,
  },
  actionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface1,
    borderRadius: radius.md,
    padding: space.x3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.blue400,
    gap: space.x3,
  },
  suggestionChip: {
    backgroundColor: colors.surface2,
    paddingHorizontal: space.x3,
    paddingVertical: space.x2,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(96, 165, 250, 0.2)',
  },
  composerCard: {
    backgroundColor: colors.surface1,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    padding: space.x3,
    gap: space.x2,
  },
  composerInput: {
    minHeight: 64,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.canvas,
    color: colors.textPrimary,
    paddingHorizontal: space.x2,
    paddingTop: space.x2,
    textAlignVertical: 'top',
    fontSize: 14,
  },
  composerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  messageCard: {
    gap: space.x2,
  },
  userBubble: {
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    padding: space.x3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  aiBubble: {
    backgroundColor: colors.surface1,
    borderRadius: radius.md,
    padding: space.x3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  awaitingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(251, 191, 36, 0.1)',
    padding: space.x2,
    borderRadius: radius.sm,
    marginTop: space.x2,
  },
  rowItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.x1,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  payloadBox: {
    backgroundColor: colors.canvas,
    borderRadius: radius.sm,
    padding: space.x2,
    marginTop: space.x2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  scheduleMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.x2,
    paddingTop: space.x2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  searchInput: {
    height: 38,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.canvas,
    color: colors.textPrimary,
    paddingHorizontal: space.x2,
    marginTop: space.x2,
    fontSize: 13,
  },
  filterChip: {
    backgroundColor: colors.surface2,
    paddingHorizontal: space.x3,
    paddingVertical: space.x1,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  kindBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.xs,
    backgroundColor: 'rgba(96, 165, 250, 0.12)',
  },
});
