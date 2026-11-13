// Hallyu AI Operator control panel — the AI's command centre inside the Admin Command Centre.
// This is NOT a conversational interface. It is an operational dashboard for configuring,
// monitoring, and governing the Hallyu AI operator. Chat with the AI happens in DMs, not here.
//
// Talks only to the hallyu-ai-operator edge function and the hallyu_ai_* admin RPCs; renders
// exactly what the backend reports, including failures (spec: no fake success, no fake analytics).

import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet,
  Switch, TextInput, TouchableOpacity, View,
} from 'react-native';
import { supabase } from '../../lib/api/client';
import { colors, radius, space } from '../../constants/theme';
import { haptic, useApp } from '../../lib/hooks';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/States';
import { Text } from '../ui/Text';
import { useToast } from '../ui/Toast';

interface AiTask {
  id: string;
  kind: string;
  status: string;
  title: string;
  error: string | null;
  result: { answer?: string } | null;
  created_at: string;
  requester_profile_id: string | null;
  requester_role: string | null;
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
  prompt: string;
  next_run_at: string | null;
  last_status: string | null;
  last_task_id: string | null;
}

interface AiToolCall {
  id: string;
  seq: number;
  tool: string;
  status: string;
  result: unknown;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

interface AiProvider {
  id: string;
  name: string;
  provider_type: string;
  endpoint: string;
  model: string;
  auth_method: string;
  enabled: boolean;
  priority: number;
  cooldown_until: string | null;
  rate_limit_remaining: number | null;
  rate_limit_resets_at: string | null;
  last_successful_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  total_requests: number;
  total_failures: number;
}

interface AiUsageStat {
  id: string;
  provider_id: string;
  provider_name: string;
  model: string;
  request_date: string;
  requests_count: number;
  failures_count: number;
  total_tokens_in: number;
  total_tokens_out: number;
  avg_latency_ms: number | null;
}

interface AiDmEvent {
  id: string;
  conversation_id: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  message_id: string;
  created_at: string;
  processed_at: string | null;
  status: string;
  error: string | null;
  attempt_count: number;
  max_attempts: number;
}

interface AiCommentEvent {
  id: string;
  comment_id: string;
  post_id: string;
  author_id: string;
  mentioned_handle: string;
  body: string;
  created_at: string;
  processed_at: string | null;
  status: string;
  error: string | null;
  attempt_count: number;
  max_attempts: number;
}

type Ping = {
  providers: AiProvider[];
  primary_provider: string | null;
  staff: boolean;
  publishing_mode: 'approval' | 'autonomous';
  tools: string[];
};

const STATUS_TONE: Record<string, string> = {
  completed: colors.success,
  failed: colors.danger,
  cancelled: colors.textSecondary,
  running: colors.info,
  queued: colors.textSecondary,
  awaiting_approval: colors.warning,
  pending: colors.textSecondary,
};

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  if (!supabase) throw new Error('Hallyu AI is unavailable because this build has no backend connection.');
  const { data, error } = await supabase.functions.invoke<T>('hallyu-ai-operator', { body });
  if (error) {
    const context = (error as { context?: Response }).context;
    let detail: string | null = null;
    if (context) {
      const payload = await context.clone().json().catch(() => null) as { error?: unknown; message?: unknown } | null;
      detail = typeof payload?.error === 'string' ? payload.error : typeof payload?.message === 'string' ? payload.message : null;
      if (!detail) detail = (await context.text().catch(() => '')).trim().slice(0, 500) || null;
    }
    const status = context?.status ? ` (HTTP ${context.status})` : '';
    throw new Error(detail ?? `${error.message}${status}`);
  }
  const payload = data as T & { error?: unknown };
  if (payload && typeof payload === 'object' && typeof payload.error === 'string') throw new Error(payload.error);
  return data as T;
}

export function HallyuAIPanel() {
  useApp();
  
  const toast = useToast();
  const [ping, setPing] = useState<Ping | null>(null);
  const [tasks, setTasks] = useState<AiTask[]>([]);
  const [approvals, setApprovals] = useState<AiApproval[]>([]);
  const [schedules, setSchedules] = useState<AiSchedule[]>([]);
  
  const [toolCalls, setToolCalls] = useState<Record<string, AiToolCall[]>>({});
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [usage, setUsage] = useState<AiUsageStat[]>([]);
    const [dmEvents, setDmEvents] = useState<AiDmEvent[]>([]);
  const [commentEvents, setCommentEvents] = useState<AiCommentEvent[]>([]);
  const [providerForm, setProviderForm] = useState<{ open: boolean; editing: AiProvider | null; name: string; provider_type: string; endpoint: string; model: string; enabled: boolean; priority: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<'overview' | 'providers' | 'activity' | 'execution' | 'configuration' | 'inspector'>('overview');

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const client = supabase;
      if (!client) throw new Error('Hallyu AI is unavailable because this build has no backend connection.');
      const [pingState, taskRows, approvalRows, scheduleRows, dmRows, commentRows] = await Promise.all([
        invoke<Ping>({ action: 'ping' }),
        client.rpc('hallyu_ai_admin_tasks', { p_limit: 30 }),
        client.rpc('hallyu_ai_admin_approvals'),
        client.rpc('hallyu_ai_admin_schedules'),
                client.rpc('hallyu_ai_admin_dm_events', { p_limit: 30 }),
        client.rpc('hallyu_ai_admin_comment_events', { p_limit: 30 }),
      ]);
      const readError = taskRows.error ?? approvalRows.error ?? scheduleRows.error ?? dmRows.error ?? commentRows.error;
      if (readError) throw new Error(readError.message);
      setPing(pingState);
      setTasks((taskRows.data as AiTask[]) ?? []);
      setApprovals((approvalRows.data as AiApproval[]) ?? []);
      setSchedules((scheduleRows.data as AiSchedule[]) ?? []);
      setDmEvents((dmRows.data as AiDmEvent[]) ?? []);
      setCommentEvents((commentRows.data as AiCommentEvent[]) ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // ---- Providers tab data ----
  const loadProviders = useCallback(async () => {
    try {
      const client = supabase;
      if (!client) return;
      const [providersRes, usageRes] = await Promise.all([
        client.rpc('hallyu_ai_admin_provider_configs'),
        client.rpc('hallyu_ai_admin_provider_usage', { p_limit: 100 }),
      ]);
      const err = providersRes.error ?? usageRes.error;
      if (err) throw new Error(err.message);
      setProviders((providersRes.data as AiProvider[]) ?? []);
      setUsage((usageRes.data as AiUsageStat[]) ?? []);
    } catch (e) {
      toast.show({ message: e instanceof Error ? e.message : 'Failed to load providers.', tone: 'danger' });
    }
  }, [toast]);

  const upsertProvider = async (values: { name: string; provider_type: string; endpoint: string; api_key: string; model: string; auth_method?: string; enabled?: boolean; priority?: number }, id?: string) => {
    setBusy(true);
    try {
      const client = supabase;
      if (!client) throw new Error('No backend connection.');
      const { error: rpcError } = await client.rpc('hallyu_ai_admin_upsert_provider', {
        p_id: id ?? null,
        p_name: values.name,
        p_provider_type: values.provider_type,
        p_endpoint: values.endpoint,
        p_api_key: values.api_key || null,
        p_model: values.model,
        p_auth_method: values.auth_method ?? 'bearer',
        p_enabled: values.enabled ?? true,
        p_priority: values.priority ?? 100,
      });
      if (rpcError) throw new Error(rpcError.message);
      toast.show({ message: id ? 'Provider updated.' : 'Provider created.', tone: 'success' });
      setProviderForm(null);
      await loadProviders();
      await loadAll();
    } catch (e) {
      toast.show({ message: e instanceof Error ? e.message : 'Provider save failed.', tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const deleteProvider = async (id: string) => {
    setBusy(true);
    try {
      const client = supabase;
      if (!client) throw new Error('No backend connection.');
      const { error: rpcError } = await client.rpc('hallyu_ai_admin_delete_provider', { p_id: id });
      if (rpcError) throw new Error(rpcError.message);
      toast.show({ message: 'Provider removed.', tone: 'success' });
      await loadProviders();
      await loadAll();
    } catch (e) {
      toast.show({ message: e instanceof Error ? e.message : 'Delete failed.', tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  // ---- Actions ----
  const updateSchedule = async (schedule: AiSchedule) => {
    setBusy(true);
    try {
      await invoke({ action: 'schedule.update', schedule_id: schedule.id, enabled: !schedule.enabled, interval_minutes: schedule.interval_minutes, prompt: schedule.prompt });
      toast.show({ message: schedule.enabled ? `${schedule.name} paused.` : `${schedule.name} enabled; first run is due now.`, tone: 'success' });
      await loadAll();
    } catch (e) {
      toast.show({ message: e instanceof Error ? e.message : 'Schedule update failed.', tone: 'danger' });
    } finally { setBusy(false); }
  };

  const changePublishingMode = async () => {
    if (!ping) return;
    setBusy(true);
    try {
      const next = ping.publishing_mode === 'approval' ? 'autonomous' : 'approval';
      await invoke({ action: 'settings.update', publishing_mode: next });
      toast.show({ message: next === 'autonomous' ? 'Routine publishing is autonomous. Broadcasts still require approval.' : 'Routine publishing now requires approval.', tone: 'success' });
      await loadAll();
    } catch (e) {
      toast.show({ message: e instanceof Error ? e.message : 'Settings update failed.', tone: 'danger' });
    } finally { setBusy(false); }
  };

  const toggleToolCalls = async (taskId: string) => {
    if (toolCalls[taskId]) {
      setToolCalls((current) => { const next = { ...current }; delete next[taskId]; return next; });
      return;
    }
    if (!supabase) return;
    const { data, error: readError } = await supabase.rpc('hallyu_ai_admin_tool_calls', { p_task: taskId });
    if (readError) toast.show({ message: readError.message, tone: 'danger' });
    else setToolCalls((current) => ({ ...current, [taskId]: (data as AiToolCall[]) ?? [] }));
  };

  const decide = async (approvalId: string, approve: boolean) => {
    setBusy(true);
    void haptic.medium();
    try {
      await invoke({ action: 'approval.decide', approval_id: approvalId, approve });
      toast.show({ message: approve ? 'Approved — the AI resumes its plan.' : 'Rejected — the AI was told no.', tone: 'success' });
      await loadAll();
    } catch (e) {
      toast.show({ message: e instanceof Error ? e.message : 'Decision failed.', tone: 'danger' });
    } finally { setBusy(false); }
  };

  // ---- Section rendering ----
  const renderOverview = () => (
    <View style={styles.section}>
      <Text variant="title">Operator status</Text>
      <View style={[styles.card, { borderLeftColor: ping?.primary_provider ? '#34c759' : '#ffb340' }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Ionicons name={ping?.primary_provider ? 'sparkles' : 'sparkles-outline'} size={18} color={colors.accent} />
          <Text variant="label">Hallyu AI Operator</Text>
          <View style={{ flex: 1 }} />
          {loading ? <ActivityIndicator size="small" color={colors.accent} /> : null}
        </View>
        {ping ? (
          <View style={styles.statusRow}>
            <Text variant="caption" tone="secondary" style={{ flex: 1 }} numberOfLines={2}>
              Primary: {ping.primary_provider ?? 'none configured'} · Publishing: {ping.publishing_mode === 'approval' ? 'approval required' : 'routine autonomous'} · broadcasts always need approval
            </Text>
            <Button label="Change mode" variant="ghost" size="sm" disabled={busy} onPress={() => void changePublishingMode()} />
          </View>
        ) : null}
        <Text variant="caption" tone="secondary" style={{ marginTop: space.x2 }}>
          {ping === null ? 'Checking the operator…' : ping.primary_provider ? `${ping.providers.length} provider(s) registered; ${ping.primary_provider.toUpperCase()} is primary.` : 'No AI provider is configured. Use the Providers tab to add one.'}
        </Text>
      </View>

      {error ? (
        <View style={[styles.card, styles.errorCard]}>
          <View style={styles.errorHeading}>
            <Ionicons name="alert-circle" size={18} color={colors.danger} />
            <Text variant="label" style={{ color: colors.danger, flex: 1 }}>Connection error</Text>
          </View>
          <Text variant="caption" style={{ color: colors.textPrimary }}>{error}</Text>
          <Button label="Retry" variant="secondary" size="sm" onPress={() => void loadAll()} />
        </View>
      ) : null}

      <View style={styles.subsection}>
        <Text variant="label">Pending approvals ({approvals.length})</Text>
        {approvals.length === 0 ? (
          <Text variant="caption" tone="secondary">No approvals needed right now.</Text>
        ) : (
          approvals.map((approval) => (
            <View key={approval.id} style={[styles.card, { borderLeftColor: '#ffb340' }]}>
              <Text variant="label">{approval.tool}</Text>
              <Text variant="caption" tone="secondary" style={{ marginTop: 4 }}>{JSON.stringify(approval.args).slice(0, 240)}</Text>
              <Text variant="caption" tone="tertiary" style={{ marginTop: 4 }}>{approval.reason}</Text>
              <View style={{ flexDirection: 'row', gap: space.x2, marginTop: space.x3 }}>
                <Button label="Approve" variant="primary" size="sm" disabled={busy} onPress={() => void decide(approval.id, true)} />
                <Button label="Reject" variant="ghost" size="sm" disabled={busy} onPress={() => void decide(approval.id, false)} />
              </View>
            </View>
          ))
        )}
      </View>

      <View style={styles.subsection}>
        <Text variant="label">Schedules</Text>
        <Text variant="caption" tone="secondary" style={{ marginTop: 4 }}>
          Runs only after the service-role dispatcher invokes schedule.run_due. All schedules are disabled until explicitly enabled by staff.
        </Text>
        {schedules.length === 0 ? (
          <Text variant="caption" tone="secondary">No schedules defined.</Text>
        ) : (
          schedules.map((schedule) => (
            <View key={schedule.id} style={styles.card}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View>
                  <Text variant="label">{schedule.name}</Text>
                  <Text variant="caption" tone="secondary">Every {schedule.interval_minutes} min · {schedule.enabled ? 'enabled' : 'paused'}</Text>
                </View>
                <Switch value={schedule.enabled} onValueChange={() => void updateSchedule(schedule)} disabled={busy} />
              </View>
              {schedule.last_status ? <Text variant="caption" tone="tertiary" style={{ marginTop: 4 }}>Last: {schedule.last_status}</Text> : null}
            </View>
          ))
        )}
      </View>
    </View>
  );

  const renderProviders = () => (
    <View style={styles.section}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: space.x3 }}>
        <Text variant="title">AI providers</Text>
        <Button label="+ Add provider" variant="primary" size="sm" onPress={() => void setProviderForm({ open: true, editing: null, name: '', provider_type: 'gemini', endpoint: '', model: '', enabled: false, priority: 100 })} />
      </View>
      <View style={{ flexDirection: 'row', gap: space.x2, marginBottom: space.x3 }}>
        <Button label="Refresh providers" variant="ghost" size="sm" disabled={busy} onPress={() => void loadProviders()} />
      </View>
      {providers.length === 0 ? (
        <EmptyState icon="globe-outline" title="No providers configured" body="Add at least one AI provider (Gemini, OpenAI-compatible, Anthropic-compatible, or Rork) to enable AI responses." />
      ) : (
        <FlatList
          data={providers}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <View key={item.id} style={[styles.card, { borderLeftColor: item.enabled ? '#34c759' : '#8e8e93' }]}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2 }}>
                    <Text variant="label">{item.name}</Text>
                    <Text variant="caption" tone="tertiary" style={{ fontSize: 10 }}>{item.provider_type.toUpperCase()}</Text>
                  </View>
                  <Text variant="caption" tone="secondary" style={{ marginTop: 2 }}>{item.model} · priority {item.priority}</Text>
                  <Text variant="caption" tone="secondary">
                    {item.last_error ? `Last error: ${item.last_error.slice(0, 120)}` : 'No recent errors'} · {item.total_requests} requests / {item.total_failures} failures
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', gap: space.x1 }}>
                  <Switch value={item.enabled} onValueChange={() => {}} disabled={true} />
                  <Button label="Edit" variant="ghost" size="sm" onPress={() => void setProviderForm({ open: true, editing: item, name: item.name, provider_type: item.provider_type, endpoint: item.endpoint, model: item.model, enabled: item.enabled, priority: item.priority })} />
                  <Button label="Remove" variant="ghost" size="sm" onPress={() => void deleteProvider(item.id)} />
                </View>
              </View>
            </View>
          )}
        />
      )}
    </View>
  );

  const renderActivity = () => (
    <View style={styles.section}>
      <Text variant="title">Activity</Text>
      <View style={{ gap: space.x3 }}>
        <View style={styles.card}>
          <Text variant="label">DM events</Text>
          <View style={{ gap: space.x2 }}>
            {dmEvents.length === 0 ? <Text variant="caption" tone="secondary">No DM events.</Text> : dmEvents.map((e) => (
              <View key={e.id} style={styles.eventRow}>
                <Text variant="caption" tone="tertiary">{e.sender_id.slice(0, 8)}… → AI</Text>
                <Text variant="caption" tone="secondary" numberOfLines={1}>{e.body.slice(0, 80)}</Text>
                <Text variant="caption" tone={(STATUS_TONE[e.status] ?? "#8e8e93") as any}>{e.status}</Text>
              </View>
            ))}
          </View>
        </View>
        <View style={styles.card}>
          <Text variant="label">Comment mention events</Text>
          <View style={{ gap: space.x2 }}>
            {commentEvents.length === 0 ? <Text variant="caption" tone="secondary">No comment mention events.</Text> : commentEvents.map((e) => (
              <View key={e.id} style={styles.eventRow}>
                <Text variant="caption" tone="tertiary">{e.author_id.slice(0, 8)}… mentioned @hallyu.ai</Text>
                <Text variant="caption" tone="secondary" numberOfLines={1}>{e.body.slice(0, 80)}</Text>
                <Text variant="caption" tone={(STATUS_TONE[e.status] ?? "#8e8e93") as any}>{e.status}</Text>
              </View>
            ))}
          </View>
        </View>
      </View>
    </View>
  );

  const renderExecution = () => (
    <View style={styles.section}>
      <Text variant="title">Execution inspector</Text>
      <Text variant="caption" tone="secondary" style={{ marginBottom: space.x3 }}>
        Every AI task, tool call, and outcome. Honest record — failures are shown, never hidden.
      </Text>
      {tasks.length === 0 ? (
        <EmptyState icon="list-outline" title="No operator activity yet" body="Tasks appear here when members DM @hallyu.ai, mention it in comments, or staff create operator tasks." />
      ) : (
        <FlatList
          data={tasks}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <Pressable key={item.id} onPress={() => void toggleToolCalls(item.id)} style={[styles.card, { borderLeftColor: STATUS_TONE[item.status] ?? '#8e8e93' }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text variant="caption" tone="tertiary">{item.kind.toUpperCase()}</Text>
                <Text variant="caption" tone="tertiary">·</Text>
                <Text variant="caption" tone="tertiary">{item.status}</Text>
              </View>
              <Text variant="label" style={{ marginTop: 2 }} numberOfLines={2}>{item.title}</Text>
              {item.result?.answer ? (
                <Text variant="caption" tone="secondary" style={{ marginTop: 4 }}>{item.result.answer.slice(0, 400)}</Text>
              ) : null}
              {item.error ? (
                <Text variant="caption" tone="secondary" style={{ marginTop: 4, color: '#ff6b60' }}>{item.error.slice(0, 300)}</Text>
              ) : null}
              <Text variant="caption" tone="tertiary" style={{ marginTop: 4 }}>{toolCalls[item.id] ? 'Hide' : 'Show'} tool audit</Text>
              {toolCalls[item.id]?.map((call) => (
                <View key={call.id} style={styles.subsection}>
                  <Text variant="caption">#{call.seq} {call.tool} · {call.status}</Text>
                  {call.error ? <Text variant="caption" style={{ color: colors.danger }}>{call.error}</Text> : null}
                  {call.result !== null ? <Text variant="caption" tone="tertiary" numberOfLines={4}>{JSON.stringify(call.result).slice(0, 600)}</Text> : null}
                </View>
              ))}
            </Pressable>
          )}
        />
      )}
    </View>
  );

  const renderConfiguration = () => (
    <View style={styles.section}>
      <Text variant="title">Configuration</Text>
      <View style={[styles.card, { gap: space.x2 }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View>
            <Text variant="label">Publishing mode</Text>
            <Text variant="caption" tone="secondary">{ping?.publishing_mode === 'approval' ? 'Routine publishing requires staff approval.' : 'Routine publishing is autonomous.'}</Text>
          </View>
          <Button label={ping?.publishing_mode === 'approval' ? 'Switch to autonomous' : 'Switch to approval'} variant="primary" size="sm" disabled={busy} onPress={() => void changePublishingMode()} />
        </View>
        <View style={{ marginTop: space.x3 }}>
          <Text variant="label">Broadcasts</Text>
          <Text variant="caption" tone="secondary">Always require staff approval, regardless of publishing mode.</Text>
        </View>
      </View>
    </View>
  );

  const renderInspector = () => (
    <View style={styles.section}>
      <Text variant="title">Usage analytics</Text>
      {usage.length === 0 ? (
        <EmptyState icon="analytics-outline" title="No usage data yet" body="Provider usage statistics appear after the first successful AI inference call." />
      ) : (
        <FlatList
          data={usage}
          keyExtractor={(item) => `${item.provider_id}-${item.request_date}`}
          renderItem={({ item }) => (
            <View key={`${item.provider_id}-${item.request_date}`} style={styles.card}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <View>
                  <Text variant="label">{item.provider_name}</Text>
                  <Text variant="caption" tone="secondary">{item.model} · {item.request_date}</Text>
                </View>
                <View>
                  <Text variant="caption" tone="tertiary">{item.requests_count} requests · {item.failures_count} failures</Text>
                </View>
              </View>
              {item.avg_latency_ms !== null ? <Text variant="caption" tone="tertiary" style={{ marginTop: 2 }}>Avg latency: {item.avg_latency_ms.toFixed(0)}ms</Text> : null}
            </View>
          )}
        />
      )}
    </View>
  );

  const sections: Record<string, React.ReactNode> = {
    overview: renderOverview(),
    providers: renderProviders(),
    activity: renderActivity(),
    execution: renderExecution(),
    configuration: renderConfiguration(),
    inspector: renderInspector(),
  };

  const sectionLabels: Record<string, string> = {
    overview: 'Overview',
    providers: 'Providers',
    activity: 'Activity',
    execution: 'Execution inspector',
    configuration: 'Configuration',
    inspector: 'Usage analytics',
  };

  return (
    <ScrollView
      refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { void loadAll(); void loadProviders(); }} />}
      showsVerticalScrollIndicator={false}
      style={{ gap: space.x4 }}
      contentContainerStyle={{ paddingBottom: space.x6 }}
    >
      {/* Top bar: section selector */}
      <View style={styles.topBar}>
        <Text variant="label">Hallyu AI Operator</Text>
        <View style={styles.sectionTabs}>
          {Object.keys(sections).map((key) => (
            <TouchableOpacity
              key={key}
              onPress={() => { setActiveSection(key as any); haptic.light(); }}
              style={[styles.tab, activeSection === key && styles.tabActive]}
            >
              <Text variant="caption" tone={activeSection === key ? 'secondary' : 'tertiary'} style={{ color: activeSection === key ? colors.accent : colors.textTertiary }}>
                {sectionLabels[key]}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {sections[activeSection]}

      {/* Provider form modal */}
      {providerForm?.open && (
        <View style={styles.modalOverlay}>
          <View style={styles.modal}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: space.x3 }}>
              <Text variant="label">{providerForm.editing ? 'Edit provider' : 'Add provider'}</Text>
              <Pressable onPress={() => setProviderForm(null)} style={{ padding: 4 }}>
                <Ionicons name="close" size={20} color={colors.textSecondary} />
              </Pressable>
            </View>
            <TextInput
              value={providerForm.name}
              onChangeText={(v) => setProviderForm({ ...providerForm, name: v })}
              placeholder="Provider name (e.g. Gemini Primary)"
              placeholderTextColor={colors.textTertiary}
              style={styles.input}
            />
            <TextInput
              value={providerForm.provider_type}
              onChangeText={(v) => setProviderForm({ ...providerForm, provider_type: v })}
              placeholder="Provider type (gemini | openai | anthropic | rork)"
              placeholderTextColor={colors.textTertiary}
              style={styles.input}
            />
            <TextInput
              value={providerForm.endpoint}
              onChangeText={(v) => setProviderForm({ ...providerForm, endpoint: v })}
              placeholder="API base URL (e.g. https://generativelanguage.googleapis.com/v1beta)"
              placeholderTextColor={colors.textTertiary}
              style={styles.input}
            />
            <TextInput
              value={providerForm.model}
              onChangeText={(v) => setProviderForm({ ...providerForm, model: v })}
              placeholder="Model (e.g. gemini-1.5-pro)"
              placeholderTextColor={colors.textTertiary}
              style={styles.input}
            />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2, marginTop: space.x2 }}>
              <Switch value={providerForm.enabled} onValueChange={(v) => setProviderForm({ ...providerForm, enabled: v })} />
              <Text variant="caption" tone="secondary">Enabled</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2, marginTop: space.x2 }}>
              <Text variant="caption" tone="secondary">Priority (lower first)</Text>
              <TextInput
                value={String(providerForm.priority)}
                onChangeText={(v) => setProviderForm({ ...providerForm, priority: Number(v) || 100 })}
                keyboardType="numeric"
                style={{ width: 60, ...styles.input }}
              />
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: space.x2, marginTop: space.x4 }}>
              <Button label="Cancel" variant="ghost" size="sm" onPress={() => setProviderForm(null)} />
              <Button label="Save provider" variant="primary" size="sm" disabled={busy} onPress={() => void upsertProvider({
                name: providerForm.name,
                provider_type: providerForm.provider_type,
                endpoint: providerForm.endpoint,
                api_key: '', // API keys are set via Supabase secrets, not the UI
                model: providerForm.model,
                enabled: providerForm.enabled,
                priority: providerForm.priority,
              }, providerForm.editing?.id)} />
            </View>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: space.x2,
  },
  sectionTabs: {
    flexDirection: 'row',
    gap: space.x2,
  },
  tab: {
    paddingVertical: space.x2,
    paddingHorizontal: space.x3,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  tabActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  section: {
    gap: space.x3,
  },
  card: {
    backgroundColor: colors.surface1,
    borderRadius: radius.md,
    borderLeftWidth: 3,
    padding: space.x3,
    gap: 2,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: space.x2, marginTop: space.x2 },
  errorCard: { borderLeftColor: colors.danger, gap: space.x2 },
  errorHeading: { flexDirection: 'row', alignItems: 'center', gap: space.x2 },
  subsection: { marginTop: space.x2, paddingTop: space.x2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle, gap: 4 },
  input: {
    minHeight: 44,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.canvas,
    color: colors.textPrimary,
    paddingHorizontal: space.x2,
    textAlignVertical: 'top',
    marginBottom: space.x2,
  },
  eventRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space.x1,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  modalOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  modal: {
    backgroundColor: colors.surface1,
    borderRadius: radius.lg,
    padding: space.x4,
    width: '92%',
    maxHeight: '90%',
  },
});
