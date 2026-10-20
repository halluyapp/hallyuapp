import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Avatar } from '../../components/ui/Avatar';
import { Button } from '../../components/ui/Button';
import { Screen, useListPadding } from '../../components/ui/Screen';
import { ListSkeleton } from '../../components/ui/Skeleton';
import { EmptyState } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TextField } from '../../components/ui/TextField';
import { TopBar } from '../../components/ui/TopBar';
import { colors, fonts, radius, space } from '../../constants/theme';
import { fetchConversations, subscribeDirectMessages } from '../../lib/api/features';
import { useAuth } from '../../lib/auth';
import { timeAgo } from '../../lib/format';
import { haptic, useApp } from '../../lib/hooks';
import type { ConversationSummary, User } from '../../lib/model';

export default function MessagesInboxScreen() {
  const router = useRouter();
  const auth = useAuth();
  const { state, me } = useApp();
  const padding = useListPadding(false);
  const [threads, setThreads] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  const reload = useCallback(async () => {
    try {
      const data = await fetchConversations();
      setThreads(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (auth.status !== 'signedIn') {
      setLoading(false);
      return;
    }
    void reload();
    return subscribeDirectMessages(me.id, () => {
      void reload();
    });
  }, [auth.status, me.id, reload]);

  const suggestedFriends = useMemo(() => {
    const existingHandles = new Set(threads.map((t) => t.handle.toLowerCase()));
    return Object.values(state.users)
      .filter((u): u is User => Boolean(u && u.id !== me.id && !existingHandles.has(u.handle.toLowerCase())))
      .slice(0, 12);
  }, [state.users, me.id, threads]);

  const filteredThreads = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^@/, '');
    if (!q) return threads;
    return threads.filter(
      (t) => t.handle.toLowerCase().includes(q) || t.displayName.toLowerCase().includes(q),
    );
  }, [threads, query]);

  const directHandle = query.trim().replace(/^@/, '');

  if (auth.status !== 'signedIn') {
    return (
      <Screen header={<TopBar mode="stack" title="Messages" />}>
        <EmptyState
          icon="chatbubble-ellipses-outline"
          title="Direct messages"
          body="Sign in to send dramas, reviews, and live episode reactions directly to friends."
          actionLabel="Sign in"
          onAction={() => router.push('/(auth)/welcome')}
        />
      </Screen>
    );
  }

  return (
    <Screen header={<TopBar mode="stack" title="Messages" />}>
      <FlatList
        data={filteredThreads}
        keyExtractor={(item) => item.peerId}
        contentContainerStyle={padding}
        onRefresh={reload}
        refreshing={loading}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: space.margin, paddingTop: space.x3, paddingBottom: space.x2, gap: space.x3 }}>
            <TextField
              value={query}
              onChangeText={setQuery}
              placeholder="Search conversations or type @handle…"
              leading="search-outline"
              autoCapitalize="none"
              autoCorrect={false}
            />
            {directHandle.length >= 2 && !filteredThreads.some((t) => t.handle.toLowerCase() === directHandle.toLowerCase()) ? (
              <Button
                label={`Message @${directHandle}`}
                icon="paper-plane-outline"
                variant="secondary"
                size="sm"
                onPress={() => {
                  haptic.light();
                  router.push(`/messages/${directHandle}`);
                }}
              />
            ) : null}
            {suggestedFriends.length > 0 ? (
              <View style={{ gap: space.x2 }}>
                <Text variant="overline" tone="tertiary">
                  START A CHAT
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.x3 }}>
                  {suggestedFriends.map((u) => (
                    <Pressable
                      key={u.id}
                      onPress={() => {
                        haptic.light();
                        router.push(`/messages/${u.handle}`);
                      }}
                      style={{ alignItems: 'center', width: 64, gap: 4 }}
                      accessibilityRole="button"
                      accessibilityLabel={`Message ${u.displayName}`}
                    >
                      <Avatar uri={u.avatarUrl} name={u.displayName} size="md" />
                      <Text variant="caption" numberOfLines={1}>
                        {u.displayName.split(' ')[0]}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => {
              haptic.select();
              router.push(`/messages/${item.handle}`);
            }}
            style={({ pressed }) => [styles.row, pressed ? { backgroundColor: colors.surface1 } : null]}
            accessibilityRole="button"
            accessibilityLabel={`Conversation with ${item.displayName}`}
          >
            <Avatar uri={item.avatarUrl} name={item.displayName} size="lg" />
            <View style={{ flex: 1, gap: 3 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1 }}>
                  <Text variant="titleSmall" numberOfLines={1}>
                    {item.displayName}
                  </Text>
                  {item.verified ? <Ionicons name="checkmark-circle" size={14} color={colors.accentText} /> : null}
                </View>
                <Text variant="caption" tone="tertiary">
                  {timeAgo(item.lastAt)}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.x2 }}>
                <Text
                  variant="bodySmall"
                  tone={item.unreadCount > 0 ? 'primary' : 'secondary'}
                  numberOfLines={1}
                  style={[{ flex: 1 }, item.unreadCount > 0 ? { fontFamily: fonts.semibold } : null]}
                >
                  {item.sharedDramaId ? '🎬 ' : item.sharedPostId ? '💬 ' : ''}
                  {item.lastSenderId === me.id ? `You: ${item.lastBody}` : item.lastBody}
                </Text>
                {item.unreadCount > 0 ? (
                  <View style={styles.unreadPill}>
                    <Text style={styles.unreadText}>{item.unreadCount}</Text>
                  </View>
                ) : null}
              </View>
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          loading ? (
            <ListSkeleton rows={5} />
          ) : (
            <EmptyState
              icon="paper-plane-outline"
              title="No messages yet"
              body="Tap a member above or share any drama, short, or review to kick off your first watch chat."
              actionLabel="Explore dramas"
              onAction={() => router.push('/(tabs)/explore')}
            />
          )
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    paddingHorizontal: space.margin,
    paddingVertical: space.x3,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  unreadPill: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadText: {
    fontFamily: fonts.bold,
    fontSize: 11,
    color: colors.onAccent,
  },
});
