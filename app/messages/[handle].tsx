import AsyncStorage from '@react-native-async-storage/async-storage';
import { SpokenMessage } from '../../components/operator/SpokenMessage';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, AppState, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DramaPickerSheet } from '../../components/create/pickers';
import { VerificationSeal } from '../../components/recognition/VerificationSeal';
import { Avatar } from '../../components/ui/Avatar';
import { IconButton } from '../../components/ui/IconButton';
import { Markdown } from '../../components/ui/Markdown';
import { Poster } from '../../components/ui/Poster';
import { Screen } from '../../components/ui/Screen';
import { Sheet } from '../../components/ui/Sheet';
import { Text } from '../../components/ui/Text';
import { useToast } from '../../components/ui/Toast';
import { TopBar } from '../../components/ui/TopBar';
import { colors, radius, space } from '../../constants/theme';
import {
  fetchDirectMessages,
  markConversationReadOnServer,
  sendDirectMessage,
  subscribeDirectMessages,
} from '../../lib/api/features';
import { fetchProfileByHandle } from '../../lib/api/feed';
import { operatorApi, type OperatorActiveModelInfo, type OperatorModelOption } from '../../lib/api/operator';
import { cancelVoiceNote, startVoiceNote, stopVoiceNote, voiceApi } from '../../lib/api/voice';
import { useAuth } from '../../lib/auth';
import { timeAgo } from '../../lib/format';
import { haptic, useApp, useRequireMember } from '../../lib/hooks';
import type { DirectMessage, Drama, User } from '../../lib/model';
import { hasAdminAccess } from '../../lib/roles';

export default function DirectMessageThreadScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const requireMember = useRequireMember();
  const auth = useAuth();
  const { handle: rawHandle } = useLocalSearchParams<{ handle: string }>();
  const cleanHandle = (rawHandle ?? '').trim().replace(/^@/, '');
  const { state, me, getDrama, getPost, getUser } = useApp();
  const isOperator = cleanHandle.toLowerCase() === 'hallyu.ai';

  const [loadedPeer, setLoadedPeer] = useState<User | null>(null);
  useEffect(() => { let alive = true; setLoadedPeer(null); void fetchProfileByHandle(cleanHandle).then(data => { if (alive) setLoadedPeer(data?.user ?? null); }).catch(() => {}); return () => { alive = false; }; }, [cleanHandle]);
  const peer = useMemo(
    () =>
      loadedPeer ?? Object.values(state.users).find(
        (u) => u.handle.toLowerCase() === cleanHandle.toLowerCase(),
      ),
    [state.users, cleanHandle, loadedPeer],
  );

  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [threadError, setThreadError] = useState('');
  const threadRequest = useRef(0);
  const [draft, setDraft] = useState('');
  const [attachedDrama, setAttachedDrama] = useState<Drama | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [voicePhase, setVoicePhase] = useState<'idle' | 'recording' | 'sending'>('idle');
  const voiceRequest = useRef<AbortController | null>(null);
  const [spokenEnabled, setSpokenEnabled] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(`nari-spoken:${me.id}`).then((value) => { if (active) setSpokenEnabled(value === 'true'); });
    if (isOperator) void voiceApi.status().then((status) => { if (active) setVoiceAvailable(status.configured && status.contract_version === 2); }).catch(() => {});
    return () => { active = false; };
  }, [isOperator, me.id]);
  useEffect(() => {
    if (voicePhase !== 'recording') return;
    const timer = setTimeout(() => { void cancelVoiceNote(); setVoicePhase('idle'); toast.show({ message: 'Recording limit reached. Please record a shorter note.', tone: 'danger' }); }, 59000);
    return () => clearTimeout(timer);
  }, [voicePhase, toast]);
  const listRef = useRef<FlatList<DirectMessage>>(null);

  // Nari Model & Provider selection
  const [activeModel, setActiveModel] = useState<OperatorActiveModelInfo | null>(null);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [availableModels, setAvailableModels] = useState<OperatorModelOption[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelSwitching, setModelSwitching] = useState(false);
  const canSwitchModel = hasAdminAccess(me.role);

  const loadActiveModel = useCallback(async () => {
    if (!isOperator) return;
    try {
      const res = await operatorApi.activeModel();
      if (res?.active) {
        setActiveModel(res.active);
      }
    } catch {
      // Non-admin or offline fallback
    }
  }, [isOperator]);

  useEffect(() => {
    if (isOperator) {
      void loadActiveModel();
    }
  }, [isOperator, loadActiveModel]);

  const openModelSelector = async () => {
    setModelSheetOpen(true);
    setModelLoading(true);
    try {
      const res = await operatorApi.models();
      if (res?.models) {
        setAvailableModels(res.models);
      }
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Could not fetch model options',
        tone: 'danger',
      });
    } finally {
      setModelLoading(false);
    }
  };

  const handleSelectModel = async (provider: string, model: string) => {
    if (!canSwitchModel) {
      toast.show({ message: 'Administrator authority required to switch Nari model.', tone: 'default' });
      return;
    }
    setModelSwitching(true);
    haptic.medium();
    try {
      await operatorApi.setActiveModel(provider, model);
      toast.show({
        message: `Switched Nari model to ${provider.toUpperCase()}: ${model}`,
        tone: 'success',
      });
      await loadActiveModel();
      setModelSheetOpen(false);
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Failed to switch model',
        tone: 'danger',
      });
    } finally {
      setModelSwitching(false);
    }
  };

  const [awaitingWorkerNotice, setAwaitingWorkerNotice] = useState(false);

  const loadThread = useCallback(async () => {
    if (!cleanHandle) return;
    const request = ++threadRequest.current;
    try {
      const data = await fetchDirectMessages(cleanHandle);
      if (request !== threadRequest.current) return;
      setThreadError('');
      setMessages(previous => [...data, ...previous.filter(m => m.id.startsWith('local-'))]);
      void markConversationReadOnServer(cleanHandle);
    } catch (error) {
      if (request === threadRequest.current) setThreadError(error instanceof Error ? error.message : 'Conversation could not load.');
    }
  }, [cleanHandle]);

  useEffect(() => {
    const refresh = () => { void loadThread().catch(() => setAwaitingWorkerNotice(true)); };
    refresh();
    const appState = AppState.addEventListener('change', state => { if (state === 'active') refresh(); });
    // Realtime can disconnect on Android/background tabs; bounded polling recovers replies.
    const poll = setInterval(refresh, isOperator ? 5000 : 15000);
    const unsubscribe = subscribeDirectMessages(me.id, () => {
      refresh();
    });
    return () => { threadRequest.current++; unsubscribe(); clearInterval(poll); appState.remove(); };
  }, [loadThread, me.id, isOperator]);

  // Detect if the user sent the latest DM to Nari and no reply has arrived after 15 seconds,
  // surfacing an honest pending/check notice without fabricating any reply.
  useEffect(() => {
    if (!isOperator || messages.length === 0) {
      setAwaitingWorkerNotice(false);
      return;
    }
    const last = messages[messages.length - 1];
    if (last.senderId !== me.id) {
      setAwaitingWorkerNotice(false);
      return;
    }
    const elapsed = Date.now() - new Date(last.createdAt).getTime();
    if (elapsed >= 15_000) {
      setAwaitingWorkerNotice(true);
      return;
    }
    setAwaitingWorkerNotice(false);
    const timer = setTimeout(() => setAwaitingWorkerNotice(true), Math.max(1000, 15_000 - elapsed));
    return () => clearTimeout(timer);
  }, [isOperator, messages, me.id]);

  const sendTextOrAttachment = async (overrideText?: string) => {
    const text = (overrideText ?? draft).trim() || (attachedDrama ? `Check out ${attachedDrama.title}!` : '');
    if (!text || sending) return;
    setSending(true);
    haptic.light();
    const optimistic: DirectMessage = {
      id: `local-${Date.now()}`,
      senderId: me.id,
      recipientId: peer?.id ?? 'peer',
      body: text,
      sharedDramaId: attachedDrama?.id,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    if (overrideText === undefined) setDraft('');
    const sharedId = attachedDrama?.id;
    setAttachedDrama(null);

    try {
      const saved = await sendDirectMessage(cleanHandle, text, { sharedDramaId: sharedId });
      if (saved) {
        setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? saved : m)));
      }
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      toast.show({
        message: err instanceof Error ? err.message : 'Message failed to send',
        tone: 'danger',
      });
    } finally {
      setSending(false);
    }
  };

  const handleSend = () => sendTextOrAttachment();

  // Voice notes exist for the Nari thread: the Edge Function transcribes the clip and hands the
  // turn to this same DM, so Nari's answer arrives here through the ordinary subscription.
  const handleVoice = async () => {
    if (voicePhase === 'sending') return;
    if (voicePhase === 'idle') {
      try {
        await startVoiceNote();
        haptic.medium();
        setVoicePhase('recording');
      } catch (err) {
        toast.show({
          message: err instanceof Error ? err.message : 'Could not start recording',
          tone: 'danger',
        });
      }
      return;
    }

    setVoicePhase('sending');
    haptic.light();
    try {
      const clip = await stopVoiceNote();
      voiceRequest.current = new AbortController();
      const result = await voiceApi.transcribe(clip.audioBase64, clip.mimeType, voiceRequest.current.signal);
      if (result.transcript) {
        setDraft(result.transcript);
        toast.show({ message: 'Transcript ready. Edit it, then tap Send.', tone: 'success' });
      }
      await loadThread();
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'The voice note could not be sent',
        tone: 'danger',
      });
    } finally {
      setVoicePhase('idle');
    }
  };

  const handleCancelVoice = async () => {
    voiceRequest.current?.abort();
    await cancelVoiceNote();
    setVoicePhase('idle');
  };

  useEffect(() => () => {
    voiceRequest.current?.abort();
    void cancelVoiceNote();
  }, []);

  return (
    <Screen
      header={
        <TopBar
          mode="stack"
          title={isOperator ? 'Nari' : peer?.displayName ?? `@${cleanHandle}`}
          center={isOperator ? <View style={{ alignItems: 'center', gap: 3 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Avatar uri={peer?.avatarUrl} fallbackSource={require('../../public/nari-avatar.png')} name="Nari" size={28} /><Text variant="title">Nari</Text><VerificationSeal tier={peer?.verificationTier} verified={peer?.verified} size={18} /></View><Text variant="caption" tone="secondary">Official AI assistant</Text></View> : undefined}
          subtitle={
            isOperator
              ? activeModel
                ? `Nari · ${activeModel.label} (${activeModel.model_id})`
                : 'Nari · AI Staff Operator'
              : undefined
          }
          right={
            isOperator ? (
              <Pressable
                onPress={() => {
                  haptic.select();
                  void openModelSelector();
                }}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Nari model and provider settings"
                style={styles.modelHeaderBadge}
              >
                <Ionicons name="sparkles" size={13} color={colors.accent} />
                <Text variant="caption" style={{ color: colors.accent, fontWeight: '700', fontSize: 12 }}>
                  {activeModel?.label ?? 'Model'}
                </Text>
              </Pressable>
            ) : peer ? (
              <Pressable onPress={() => router.push(`/user/${peer.handle}`)} hitSlop={8} accessibilityRole="link">
                <Avatar uri={peer.avatarUrl} name={peer.displayName} size="sm" />
              </Pressable>
            ) : undefined
          }
        />
      }
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={56}
      >
        {!!threadError && <View style={styles.waitBanner}><Text variant="caption" style={{ flex: 1 }}>Could not refresh replies: {threadError}</Text><Pressable accessibilityRole="button" accessibilityLabel="Retry conversation" onPress={() => void loadThread()}><Text tone="accent">Retry</Text></Pressable></View>}
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: space.margin, gap: space.x3 }}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingVertical: space.x8, gap: space.x3 }}>
              <Avatar uri={peer?.avatarUrl} fallbackSource={isOperator ? require('../../public/nari-avatar.png') : undefined} name={isOperator ? 'Nari' : peer?.displayName ?? cleanHandle} size="xl" />
              <Text variant="titleSmall">{peer?.displayName ?? `@${cleanHandle}`}</Text>
              <Text variant="caption" tone="secondary" align="center" style={{ maxWidth: 320 }}>
                {isOperator
                  ? 'Nari is Hallyu’s official AI staff operator. Ask for K-drama recommendations, fandom pulse, or executive operations.'
                  : 'Send a message or tap the film icon to share a drama recommendation.'}
              </Text>
              {isOperator ? (
                <View style={styles.starterGrid}>
                  {[
                    'Recommend a top-rated K-drama to start tonight',
                    'What worlds and dramas are trending on Hallyu right now?',
                    ...(canSwitchModel ? ['Summarize platform pulse and open moderation reports'] : []),
                  ].map((prompt) => (
                    <Pressable
                      key={prompt}
                      onPress={() => requireMember('message Nari', () => void sendTextOrAttachment(prompt))}
                      accessibilityRole="button"
                      accessibilityLabel={`Ask Nari: ${prompt}`}
                      style={styles.starterChip}
                    >
                      <Ionicons name="sparkles-outline" size={14} color={colors.accent} />
                      <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
                        {prompt}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          }
          renderItem={({ item: m }) => {
            const mine = m.senderId === me.id;
            const sharedDrama = m.sharedDramaId ? getDrama(m.sharedDramaId) : undefined;
            const sharedPost = m.sharedPostId ? getPost(m.sharedPostId) : undefined;
            const postAuthor = sharedPost ? getUser(sharedPost.authorId) : undefined;

            return (
              <View style={[styles.bubbleWrap, mine ? styles.bubbleWrapMine : styles.bubbleWrapTheirs]}>
                {sharedDrama ? (
                  <Pressable
                    onPress={() => router.push(`/drama/${sharedDrama.id}`)}
                    style={styles.embedCard}
                    accessibilityRole="link"
                    accessibilityLabel={`Open ${sharedDrama.title}`}
                  >
                    <Poster drama={sharedDrama} width={44} rounded={radius.xs} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text variant="overline" tone="accent">
                        SHARED TITLE
                      </Text>
                      <Text variant="titleSmall" numberOfLines={1}>
                        {sharedDrama.title}
                      </Text>
                      <Text variant="caption" tone="secondary" numberOfLines={1}>
                        {sharedDrama.year}
                        {sharedDrama.rating ? ` · ★ ${sharedDrama.rating.toFixed(1)}` : ''}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
                  </Pressable>
                ) : null}

                {sharedPost ? (
                  <Pressable
                    onPress={() => router.push(`/post/${sharedPost.id}`)}
                    style={styles.embedCard}
                    accessibilityRole="link"
                    accessibilityLabel="Open shared post"
                  >
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text variant="overline" tone="accent">
                        POST BY @{postAuthor?.handle ?? 'member'}
                      </Text>
                      <Text variant="bodySmall" numberOfLines={2}>
                        {sharedPost.verdict || sharedPost.title || sharedPost.body}
                      </Text>
                    </View>
                    <Ionicons name="open-outline" size={16} color={colors.textTertiary} />
                  </Pressable>
                ) : null}

                <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                  {!mine && isOperator ? (
                    <Markdown source={m.body} />
                  ) : (
                    <Text variant="body" style={{ color: mine ? colors.onAccent : colors.textPrimary }}>
                      {m.body}
                    </Text>
                  )}
                </View>
                {!mine && isOperator && spokenEnabled && voiceAvailable && <SpokenMessage messageId={m.id} />}
                <Text variant="caption" tone="tertiary" style={{ fontSize: 10, marginHorizontal: 4 }}>
                  {timeAgo(m.createdAt)}
                </Text>
              </View>
            );
          }}
        />

        {attachedDrama ? (
          <View style={styles.attachPreview}>
            <Poster drama={attachedDrama} width={28} rounded={4} />
            <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>
              Sharing {attachedDrama.title}
            </Text>
            <IconButton icon="close" size={16} label="Remove attached drama" onPress={() => setAttachedDrama(null)} />
          </View>
        ) : null}

        {isOperator && voiceAvailable && <Pressable accessibilityRole="switch" accessibilityState={{ checked: spokenEnabled }} accessibilityLabel="Spoken response controls" onPress={() => {
          setSpokenEnabled(!spokenEnabled); void AsyncStorage.setItem(`nari-spoken:${me.id}`, String(!spokenEnabled));
        }}><Text variant="caption">Spoken responses: {spokenEnabled ? 'on' : 'off'} · Voice notes, not live calls</Text></Pressable>}
        {voicePhase === 'sending' && <Pressable onPress={() => void handleCancelVoice()} accessibilityRole="button"><Text variant="caption">Cancel transcription</Text></Pressable>}
        {voicePhase === 'recording' ? (
          <View style={styles.voiceBanner}>
            <Ionicons name="mic" size={14} color={colors.danger} />
            <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
              Recording… tap stop to hand this to Nari.
            </Text>
            <Pressable
              onPress={() => void handleCancelVoice()}
              accessibilityRole="button"
              accessibilityLabel="Cancel voice note"
            >
              <Text variant="caption" tone="accent">
                Cancel
              </Text>
            </Pressable>
          </View>
        ) : null}

        {isOperator && awaitingWorkerNotice ? (
          <View style={styles.waitBanner}>
            <Ionicons name="time-outline" size={14} color={colors.warm} />
            <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
              Waiting for Nari’s background worker to reply. Your message is saved in the queue.
            </Text>
            <Pressable onPress={() => void loadThread()} accessibilityRole="button" accessibilityLabel="Refresh Nari replies">
              <Text variant="caption" tone="accent">
                Check now
              </Text>
            </Pressable>
            {canSwitchModel ? (
              <Pressable onPress={() => router.push('/admin')} accessibilityRole="button" accessibilityLabel="Open Operator Control Centre">
                <Text variant="caption" tone="secondary" style={{ marginLeft: 8 }}>
                  Console
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <View style={[styles.composerBar, { paddingBottom: Math.max(insets.bottom, space.x2) }]}>
          <IconButton
            icon="film-outline"
            label="Attach a drama"
            filled
            onPress={() => setPickerOpen(true)}
          />
          {isOperator ? (
            <IconButton
              icon={voicePhase === 'recording' ? 'stop' : 'mic-outline'}
              label={voicePhase === 'recording' ? 'Transcribe voice note' : 'Record a voice note for Nari'}
              tone={voicePhase === 'recording' ? 'danger' : 'default'}
              filled
              disabled={auth.status === 'loading' || voicePhase === 'sending'}
              onPress={() => requireMember('send voice notes', () => void handleVoice())}
            />
          ) : null}
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={`Message @${cleanHandle}…`}
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
            multiline
            maxLength={2000}
            onKeyPress={(e) => {
              if (Platform.OS === 'web') {
                const native = e.nativeEvent as { key?: string; shiftKey?: boolean };
                if (native.key === 'Enter' && !native.shiftKey) {
                  e.preventDefault();
                  requireMember('send messages', () => void handleSend());
                }
              }
            }}
          />
          <Pressable
            onPress={() => requireMember('send messages', () => void handleSend())}
            disabled={auth.status === 'loading' || sending || (!draft.trim() && !attachedDrama)}
            style={[
              styles.sendBtn,
              !draft.trim() && !attachedDrama ? { opacity: 0.4 } : null,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Send message"
          >
            <Ionicons name="paper-plane" size={18} color={colors.onAccent} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      {isOperator ? (
        <Sheet
          visible={modelSheetOpen}
          onClose={() => setModelSheetOpen(false)}
          title="Nari Intelligence & Model"
          subtitle={
            canSwitchModel
              ? 'Select active model provider for Nari operations'
              : 'Active model and provider specifications'
          }
        >
          <View style={{ gap: space.x3, paddingBottom: insets.bottom + space.x4 }}>
            <View style={styles.providerNotice}>
              <Ionicons name="shield-checkmark-outline" size={16} color={colors.accent} />
              <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
                Zero cross-provider fallback: Nari preserves provider-isolated credit accounting. Active model changes apply to all subsequent turns.
              </Text>
            </View>

            {modelLoading ? (
              <Text variant="body" tone="secondary" align="center" style={{ paddingVertical: space.x4 }}>
                Loading provider options...
              </Text>
            ) : (
              availableModels.map((opt) => {
                const isActiveProvider = activeModel?.provider === opt.provider;
                return (
                  <View key={opt.provider} style={styles.providerCard}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2 }}>
                        <Ionicons
                          name={isActiveProvider ? 'radio-button-on' : 'radio-button-off'}
                          size={18}
                          color={isActiveProvider ? colors.accent : colors.textTertiary}
                        />
                        <Text variant="titleSmall" style={{ fontWeight: '700' }}>
                          {opt.label}
                        </Text>
                      </View>
                      <View
                        style={[
                          styles.healthChip,
                          {
                            backgroundColor:
                              opt.health === 'healthy' || opt.health === 'ok'
                                ? 'rgba(52, 211, 153, 0.12)'
                                : 'rgba(251, 191, 36, 0.12)',
                          },
                        ]}
                      >
                        <Text
                          variant="caption"
                          style={{
                            color:
                              opt.health === 'healthy' || opt.health === 'ok' ? colors.success : colors.warning,
                            fontSize: 11,
                            fontWeight: '600',
                          }}
                        >
                          {opt.health.toUpperCase()}
                        </Text>
                      </View>
                    </View>

                    <Text variant="caption" tone="tertiary">
                      Available routes:
                    </Text>

                    <View style={{ gap: space.x2 }}>
                      {opt.models.map((mod) => {
                        const isCurrent = isActiveProvider && activeModel?.model_id === mod;
                        return (
                          <Pressable
                            key={mod}
                            disabled={!canSwitchModel || modelSwitching}
                            onPress={() => handleSelectModel(opt.provider, mod)}
                            style={[styles.modelRow, isCurrent && styles.modelRowSelected]}
                          >
                            <View style={{ flex: 1 }}>
                              <Text variant="body" style={{ fontWeight: isCurrent ? '700' : '500' }}>
                                {mod}
                              </Text>
                              <Text variant="caption" tone="secondary">
                                {opt.provider === 'coarena'
                                  ? 'Coarena verified gateway'
                                  : 'APINEX direct inference route'}
                              </Text>
                            </View>
                            {isCurrent ? (
                              <View style={styles.activeTag}>
                                <Text variant="caption" style={{ color: colors.accent, fontWeight: '700' }}>
                                  ACTIVE
                                </Text>
                              </View>
                            ) : canSwitchModel ? (
                              <Text variant="caption" tone="secondary">
                                Tap to switch
                              </Text>
                            ) : null}
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                );
              })
            )}
          </View>
        </Sheet>
      ) : null}

      <DramaPickerSheet
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Recommend a title in chat"
        onPick={(d) => {
          setAttachedDrama(d);
          setPickerOpen(false);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  bubbleWrap: { maxWidth: '82%', gap: 4 },
  bubbleWrapMine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  bubbleWrapTheirs: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  embedCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    padding: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    minWidth: 220,
  },
  bubble: {
    paddingHorizontal: space.x3 + 2,
    paddingVertical: space.x2 + 2,
    borderRadius: radius.lg,
  },
  bubbleMine: {
    backgroundColor: colors.accent,
    borderBottomRightRadius: 4,
  },
  bubbleTheirs: {
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderBottomLeftRadius: 4,
  },
  attachPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
    paddingHorizontal: space.margin,
    paddingVertical: space.x2,
    backgroundColor: colors.surface1,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  voiceBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
    paddingHorizontal: space.margin,
    paddingVertical: 6,
    backgroundColor: colors.surface1,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  composerBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.x2,
    paddingHorizontal: space.margin,
    paddingTop: space.x2,
    backgroundColor: colors.canvas,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 110,
    paddingHorizontal: space.x3,
    paddingVertical: 10,
    borderRadius: radius.lg,
    backgroundColor: colors.surface2,
    color: colors.textPrimary,
    fontSize: 15,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modelHeaderBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.x2,
    paddingVertical: 4,
    borderRadius: radius.full,
    backgroundColor: 'rgba(225, 29, 72, 0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(225, 29, 72, 0.3)',
  },
  providerNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.x2,
    backgroundColor: colors.surface2,
    padding: space.x3,
    borderRadius: radius.md,
  },
  providerCard: {
    backgroundColor: colors.surface1,
    padding: space.x3,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    gap: space.x2,
  },
  healthChip: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: space.x2,
    borderRadius: radius.sm,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  modelRowSelected: {
    borderColor: colors.accent,
    backgroundColor: 'rgba(225, 29, 72, 0.08)',
  },
  activeTag: {
    backgroundColor: 'rgba(225, 29, 72, 0.18)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  starterGrid: {
    width: '100%',
    maxWidth: 420,
    gap: space.x2,
    marginTop: space.x2,
  },
  starterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
    paddingHorizontal: space.x3,
    paddingVertical: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  waitBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
    paddingHorizontal: space.margin,
    paddingVertical: 6,
    backgroundColor: colors.surface1,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
});
