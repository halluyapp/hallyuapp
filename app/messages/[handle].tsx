import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DramaPickerSheet } from '../../components/create/pickers';
import { Avatar } from '../../components/ui/Avatar';
import { IconButton } from '../../components/ui/IconButton';
import { Poster } from '../../components/ui/Poster';
import { Screen } from '../../components/ui/Screen';
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
import { timeAgo } from '../../lib/format';
import { haptic, useApp, useRequireMember } from '../../lib/hooks';
import type { DirectMessage, Drama } from '../../lib/model';

export default function DirectMessageThreadScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const requireMember = useRequireMember();
  const { handle: rawHandle } = useLocalSearchParams<{ handle: string }>();
  const cleanHandle = (rawHandle ?? '').trim().replace(/^@/, '');
  const { state, me, getDrama, getPost, getUser } = useApp();

  const peer = useMemo(
    () =>
      Object.values(state.users).find(
        (u) => u.handle.toLowerCase() === cleanHandle.toLowerCase(),
      ),
    [state.users, cleanHandle],
  );

  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [attachedDrama, setAttachedDrama] = useState<Drama | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<DirectMessage>>(null);

  const loadThread = useCallback(async () => {
    if (!cleanHandle) return;
    const data = await fetchDirectMessages(cleanHandle);
    setMessages(data);
    void markConversationReadOnServer(cleanHandle);
  }, [cleanHandle]);

  useEffect(() => {
    void loadThread();
    return subscribeDirectMessages(me.id, () => {
      void loadThread();
    });
  }, [loadThread, me.id]);

  const handleSend = async () => {
    const text = draft.trim() || (attachedDrama ? `Check out ${attachedDrama.title}!` : '');
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
    setDraft('');
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

  return (
    <Screen
      header={
        <TopBar
          mode="stack"
          title={peer?.displayName ?? `@${cleanHandle}`}
          right={
            peer ? (
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
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: space.margin, gap: space.x3 }}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingVertical: space.x8, gap: space.x2 }}>
              <Avatar uri={peer?.avatarUrl} name={peer?.displayName ?? cleanHandle} size="xl" />
              <Text variant="titleSmall">{peer?.displayName ?? `@${cleanHandle}`}</Text>
              <Text variant="caption" tone="secondary" align="center">
                Send a message or tap + to share a drama recommendation.
              </Text>
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
                  <Text variant="body" style={{ color: mine ? colors.onAccent : colors.textPrimary }}>
                    {m.body}
                  </Text>
                </View>
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

        <View style={[styles.composerBar, { paddingBottom: Math.max(insets.bottom, space.x2) }]}>
          <IconButton
            icon="film-outline"
            label="Attach a drama"
            filled
            onPress={() => setPickerOpen(true)}
          />
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={`Message @${cleanHandle}…`}
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
            multiline
            maxLength={2000}
          />
          <Pressable
            onPress={() => requireMember('send messages', () => void handleSend())}
            disabled={sending || (!draft.trim() && !attachedDrama)}
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
});
