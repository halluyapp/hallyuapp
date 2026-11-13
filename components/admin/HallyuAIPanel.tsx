// Hallyu AI Operator panel — the AI's home inside the Admin Command Centre.
// Talks only to the hallyu-ai-operator edge function and the hallyu_ai_* admin RPCs; it renders
// exactly what the backend reports, including failures (spec: no fake success, no fake analytics).

import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';
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
}

interface AiApproval {
  id: string;
  task_id: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
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
}

interface AiPublication {
  id: string;
  task_id: string;
  action: string;
  title: string | null;
  body: string;
  sources: { title?: string; url?: string }[];
  status: string;
  target_id: string | null;
  error: string | null;
  created_at: string;
}

interface AiToolCall {
  id: string;
  seq: number;
  tool: string;
  status: string;
  result: unknown;
  error: string | null;
}

type Ping = {
  gemini_configured: boolean;
  rork_configured: boolean;
  primary_provider: 'gemini' | 'rork' | null;
  model: string | null;
  staff: boolean;
  tools: string[];
  publishing_mode: 'approval' | 'autonomous';
};

const STATUS_TONE: Record<string, string> = {
  completed: colors.success,
  failed: colors.danger,
  cancelled: colors.textSecondary,
  running: colors.info,
  queued: colors.textSecondary,
  awaiting_approval: colors.warning,
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
  const { me } = useApp();
  const compact = useWindowDimensions().width < 430;
  const toast = useToast();
  const [ping, setPing] = useState<Ping | null>(null);
  const [tasks, setTasks] = useState<AiTask[]>([]);
  const [approvals, setApprovals] = useState<AiApproval[]>([]);
  const [schedules, setSchedules] = useState<AiSchedule[]>([]);
  const [publications, setPublications] = useState<AiPublication[]>([]);
  const [toolCalls, setToolCalls] = useState<Record<string, AiToolCall[]>>({});
  const [lastResponse, setLastResponse] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const client = supabase;
      if (!client) throw new Error('Hallyu AI is unavailable because this build has no backend connection.');
      const [pingState, taskRows, approvalRows, scheduleRows, publicationRows] = await Promise.all([
        invoke<Ping>({ action: 'ping' }),
        client.rpc('hallyu_ai_admin_tasks', { p_limit: 30 }),
        client.rpc('hallyu_ai_admin_approvals'),
        client.rpc('hallyu_ai_admin_schedules'),
        client.rpc('hallyu_ai_admin_publications', { p_limit: 20 }),
      ]);
      const readError = taskRows.error ?? approvalRows.error ?? scheduleRows.error ?? publicationRows.error;
      if (readError) throw new Error(readError.message);
      setPing(pingState);
      setTasks((taskRows.data as AiTask[]) ?? []);
      setApprovals((approvalRows.data as AiApproval[]) ?? []);
      setSchedules((scheduleRows.data as AiSchedule[]) ?? []);
      setPublications((publicationRows.data as AiPublication[]) ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const ask = async () => {
    const prompt = question.trim();
    if (!prompt || busy) return;
    setBusy(true);
    void haptic.light();
    try {
      const answer = await invoke<{ answer?: string; status?: string; detail?: string; error?: string }>({
        action: 'chat',
        prompt,
      });
      if (answer.error) throw new Error(answer.error);
      setLastResponse(answer.answer ?? answer.detail ?? `Task status: ${answer.status ?? 'unknown'}`);
      toast.show({
        message: answer.status === 'awaiting_approval' ? answer.detail ?? 'Waiting for approval' : 'Hallyu AI replied — see the operator log below.',
        tone: 'success',
      });
      setQuestion('');
      await loadAll();
    } catch (e) {
      toast.show({ message: e instanceof Error ? e.message : 'Hallyu AI could not answer right now.', tone: 'danger' });
      await loadAll();
    } finally {
      setBusy(false);
    }
  };

  const updateSchedule = async (schedule: AiSchedule) => {
    setBusy(true);
    try {
      await invoke({ action: 'schedule.update', schedule_id: schedule.id, enabled: !schedule.enabled, interval_minutes: schedule.interval_minutes, prompt: schedule.prompt });
      toast.show({ message: schedule.enabled ? `${schedule.name} paused.` : `${schedule.name} enabled; its first run is due now.`, tone: 'success' });
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
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: space.x4 }}>
      {/* Operator status */}
      <View style={[styles.card, { borderLeftColor: ping?.primary_provider ? '#34c759' : '#ffb340' }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Ionicons name={ping?.primary_provider ? 'sparkles' : 'sparkles-outline'} size={18} color={colors.accent} />
          <Text variant="title">Hallyu AI Operator</Text>
          <View style={{ flex: 1 }} />
          {loading ? <ActivityIndicator size="small" color={colors.accent} /> : null}
        </View>
        {ping ? (
          <View style={styles.statusRow}>
            <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
              Provider: {ping.primary_provider ?? 'none configured'} · Model: {ping.model ?? '—'} · Publishing: {ping.publishing_mode === 'approval' ? 'approval required' : 'routine autonomous'} · broadcasts always need approval
            </Text>
            <Button label="Change" variant="ghost" size="sm" disabled={busy} onPress={() => void changePublishingMode()} />
          </View>
        ) : null}
        <Text variant="caption" tone="secondary" style={{ marginTop: space.x2 }}>
          {ping === null
            ? 'Checking the operator…'
            : ping.primary_provider
              ? `${ping.primary_provider.toUpperCase()} configured for ${ping.model}; ${ping.gemini_configured ? 'Gemini keys ready.' : ''}${ping.rork_configured ? ' Rork fallback ready.' : ''} ${ping.tools.length} tools are available.`
              : 'No AI provider is configured. Set GEMINI_API_KEYS or RORK_TOOLKIT_SECRET_KEY as function secrets; the panel will not simulate a response.'}
        </Text>
      </View>

      {error ? (
        <View style={[styles.card, styles.errorCard]}>
          <View style={styles.errorHeading}>
            <Ionicons name="alert-circle" size={18} color={colors.danger} />
            <Text variant="label" style={{ color: colors.danger, flex: 1 }}>AI connection error</Text>
          </View>
          <Text variant="caption" style={{ color: colors.textPrimary }}>{error}</Text>
          <Button label="Retry connection" variant="secondary" size="sm" onPress={() => void loadAll()} />
        </View>
      ) : null}

      {/* Ask the AI */}
      <View style={styles.card}>
        <Text variant="label">Ask Hallyu AI</Text>
        <Text variant="caption" tone="tertiary" style={{ marginTop: 4 }}>
          It investigates the real backend before answering. Executives can hand it operational tasks.
        </Text>
        <View style={[styles.askRow, compact && styles.askRowCompact]}>
          <TextInput
            value={question}
            onChangeText={setQuestion}
            placeholder={me.role === 'ceo' ? 'How is Hallyu performing this week?' : 'Ask about Hallyu…'}
            placeholderTextColor={colors.textTertiary}
            multiline
            maxLength={6000}
            editable={!busy}
            accessibilityLabel="Ask Hallyu AI"
            style={[styles.input, compact && styles.inputCompact]}
          />
          <Button
            label={busy ? 'Thinking…' : 'Ask Hallyu AI'}
            icon="sparkles"
            variant="primary"
            size="md"
            block={compact}
            loading={busy}
            disabled={busy || !question.trim()}
            onPress={() => void ask()}
          />
        </View>
        {lastResponse ? (
          <View style={styles.response}>
            <Text variant="overline" tone="tertiary">HALLYU AI RESPONSE</Text>
            <Text variant="body" style={{ color: colors.textPrimary }} selectable>{lastResponse}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.card}>
        <Text variant="label">Scheduled intelligence</Text>
        <Text variant="caption" tone="tertiary">Runs only after the service-role dispatcher invokes schedule.run_due. Failures pause the schedule for staff review.</Text>
        {schedules.map((schedule) => (
          <View key={schedule.id} style={styles.subsection}>
            <Text variant="label">{schedule.name}</Text>
            <Text variant="caption" tone="secondary">Every {schedule.interval_minutes} minutes · {schedule.enabled ? 'enabled' : 'paused'}{schedule.last_status ? ` · last: ${schedule.last_status}` : ''}</Text>
            <Text variant="caption" tone="tertiary" numberOfLines={3}>{schedule.prompt}</Text>
            <Button label={schedule.enabled ? 'Pause schedule' : 'Enable schedule'} variant="ghost" size="sm" disabled={busy} onPress={() => void updateSchedule(schedule)} />
          </View>
        ))}
      </View>

      <View style={styles.card}>
        <Text variant="label">Drafts and publishing</Text>
        {publications.length === 0 ? <Text variant="caption" tone="secondary">No durable drafts or AI publications yet.</Text> : publications.map((publication) => (
          <View key={publication.id} style={styles.subsection}>
            <Text variant="label">{publication.title ?? publication.action} · {publication.status}</Text>
            <Text variant="caption" tone="secondary" numberOfLines={5}>{publication.body}</Text>
            {publication.sources.map((source, index) => <Text key={`${source.url}-${index}`} variant="caption" tone="tertiary">{source.title}: {source.url}</Text>)}
            {publication.target_id ? <Text variant="caption" tone="tertiary">Published target: {publication.target_id}</Text> : null}
            {publication.error ? <Text variant="caption" style={{ color: colors.danger }}>{publication.error}</Text> : null}
          </View>
        ))}
      </View>

      {/* Approvals */}
      {approvals.length > 0 ? (
        <View style={{ gap: space.x2 }}>
          <Text variant="label">Approval needed ({approvals.length})</Text>
          {approvals.map((approval) => (
            <View key={approval.id} style={[styles.card, { borderLeftColor: '#ffb340' }]}>
              <Text variant="label">{approval.tool}</Text>
              <Text variant="caption" tone="secondary" style={{ marginTop: 4 }}>
                {JSON.stringify(approval.args).slice(0, 240)}
              </Text>
              <Text variant="caption" tone="tertiary" style={{ marginTop: 4 }}>
                {approval.reason}
              </Text>
              <View style={{ flexDirection: 'row', gap: space.x2, marginTop: space.x3 }}>
                <Button label="Approve" variant="primary" size="sm" disabled={busy} onPress={() => void decide(approval.id, true)} />
                <Button label="Reject" variant="ghost" size="sm" disabled={busy} onPress={() => void decide(approval.id, false)} />
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {/* Task log — the honest record */}
      <View style={{ gap: space.x2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text variant="label">Operator log</Text>
          <View style={{ flex: 1 }} />
          <Pressable onPress={() => void loadAll()} hitSlop={8}>
            <Ionicons name="refresh" size={16} color={colors.accent} />
          </Pressable>
        </View>
        {tasks.length === 0 && !loading ? (
          <EmptyState icon="sparkles-outline" title="No operator activity yet" body="Ask Hallyu AI something above and every step it takes will be recorded here." />
        ) : null}
        <ScrollView scrollEnabled={false} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadAll()} />}>
          {tasks.map((task) => (
            <Pressable key={task.id} onPress={() => void toggleToolCalls(task.id)} style={[styles.card, { borderLeftColor: STATUS_TONE[task.status] ?? '#8e8e93' }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text variant="caption" tone="tertiary">{task.kind.toUpperCase()}</Text>
                <Text variant="caption" tone="tertiary">·</Text>
                <Text variant="caption" tone="tertiary">{task.status}</Text>
              </View>
              <Text variant="label" style={{ marginTop: 2 }} numberOfLines={2}>
                {task.title}
              </Text>
              {task.result?.answer ? (
                <Text variant="caption" tone="secondary" style={{ marginTop: 4 }}>
                  {task.result.answer.slice(0, 400)}
                </Text>
              ) : null}
              {task.error ? (
                <Text variant="caption" tone="secondary" style={{ marginTop: 4, color: '#ff6b60' }}>
                  {task.error.slice(0, 300)}
                </Text>
              ) : null}
              <Text variant="caption" tone="tertiary" style={{ marginTop: 4 }}>{toolCalls[task.id] ? 'Hide' : 'Show'} tool audit</Text>
              {toolCalls[task.id]?.map((call) => (
                <View key={call.id} style={styles.subsection}>
                  <Text variant="caption">#{call.seq} {call.tool} · {call.status}</Text>
                  {call.error ? <Text variant="caption" style={{ color: colors.danger }}>{call.error}</Text> : null}
                  {call.result !== null ? <Text variant="caption" tone="tertiary" numberOfLines={6}>{JSON.stringify(call.result)}</Text> : null}
                </View>
              ))}
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
  askRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.x2, marginTop: space.x3 },
  askRowCompact: { flexDirection: 'column', alignItems: 'stretch' },
  response: { marginTop: space.x3, padding: space.x3, backgroundColor: colors.canvas, borderRadius: radius.sm, gap: space.x2 },
  subsection: { marginTop: space.x2, paddingTop: space.x2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle, gap: 4 },
  input: {
    flex: 1,
    minHeight: 44,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.canvas,
    color: colors.textPrimary,
    paddingHorizontal: space.x2,
    paddingTop: 12,
    textAlignVertical: 'top',
  },
  inputCompact: { minHeight: 96, width: '100%' },
});
