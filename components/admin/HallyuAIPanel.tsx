// Hallyu AI Operator panel — the AI's home inside the Admin Command Centre.
// Talks only to the hallyu-ai-operator edge function and the hallyu_ai_* admin RPCs; it renders
// exactly what the backend reports, including failures (spec: no fake success, no fake analytics).

import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';
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

type Ping = {
  model_configured: boolean;
  model: string;
  staff: boolean;
  tools: string[];
};

const STATUS_TONE: Record<string, string> = {
  completed: colors.success,
  failed: colors.danger,
  cancelled: colors.textSecondary,
  running: colors.info,
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

export function HallyuAIPanel() {
  const { me } = useApp();
  const toast = useToast();
  const [ping, setPing] = useState<Ping | null>(null);
  const [tasks, setTasks] = useState<AiTask[]>([]);
  const [approvals, setApprovals] = useState<AiApproval[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!supabase) throw new Error('This build has no backend connection.');
      const client = supabase;
      const [pingState, taskRows, approvalRows] = await Promise.all([
        invoke<Ping>({ action: 'ping' }),
        client.rpc('hallyu_ai_admin_tasks', { p_limit: 30 }),
        client.rpc('hallyu_ai_admin_approvals'),
      ]);
      setPing(pingState);
      setTasks((taskRows.data as AiTask[]) ?? []);
      setApprovals((approvalRows.data as AiApproval[]) ?? []);
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
    haptic.light();
    try {
      const answer = await invoke<{ answer?: string; status?: string; detail?: string; error?: string }>({
        action: 'chat',
        prompt,
      });
      if (answer.error) throw new Error(answer.error);
      toast.show({
        message: answer.status === 'awaiting_approval' ? answer.detail ?? 'Waiting for approval' : 'Hallyu AI replied — see the operator log below.',
        tone: 'success',
      });
      setQuestion('');
      await loadAll();
    } catch (e) {
      toast.show({
        message: e instanceof Error ? e.message : 'Hallyu AI could not answer right now.',
        tone: 'danger',
      });
      await loadAll();
    } finally {
      setBusy(false);
    }
  };

  const decide = async (approvalId: string, approve: boolean) => {
    setBusy(true);
    haptic.medium();
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
      <View style={[styles.card, { borderLeftColor: ping?.model_configured ? '#34c759' : '#ffb340' }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Ionicons name={ping?.model_configured ? 'sparkles' : 'sparkles-outline'} size={18} color={colors.accent} />
          <Text variant="title">Hallyu AI Operator</Text>
          <View style={{ flex: 1 }} />
          {loading ? <ActivityIndicator size="small" color={colors.accent} /> : null}
        </View>
        <Text variant="caption" tone="secondary" style={{ marginTop: space.x2 }}>
          {ping === null
            ? 'Checking the operator…'
            : ping.model_configured
              ? `Online — model ${ping.model} · tools: ${ping.tools.join(', ')}`
              : 'Connected, but Rork AI Cloud is not reachable from the backend yet (the RORK_TOOLKIT_SECRET_KEY function secret is missing). On a Rork-managed backend it is provisioned automatically; otherwise set it once with `supabase secrets set`. This panel will not pretend otherwise.'}
        </Text>
      </View>

      {error ? (
        <View style={[styles.card, { borderLeftColor: '#ff453a' }]}>
          <Text variant="caption" tone="secondary">{error}</Text>
        </View>
      ) : null}

      {/* Ask the AI */}
      <View style={styles.card}>
        <Text variant="label">Ask Hallyu AI</Text>
        <Text variant="caption" tone="tertiary" style={{ marginTop: 4 }}>
          It investigates the real backend before answering. Executives can hand it operational tasks.
        </Text>
        <View style={{ flexDirection: 'row', gap: space.x2, marginTop: space.x3 }}>
          <TextInput
            value={question}
            onChangeText={setQuestion}
            placeholder={me.role === 'ceo' ? 'How is Hallyu performing this week?' : 'Ask about Hallyu…'}
            placeholderTextColor={colors.textTertiary}
            multiline
            style={styles.input}
          />
          <Button label={busy ? 'Thinking…' : 'Ask'} variant="primary" size="sm" disabled={busy || !question.trim()} onPress={() => void ask()} />
        </View>
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
            <View key={task.id} style={[styles.card, { borderLeftColor: STATUS_TONE[task.status] ?? '#8e8e93' }]}>
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
            </View>
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
});
