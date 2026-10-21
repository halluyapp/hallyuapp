import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { Button } from '../components/ui/Button';
import { Chip, ChipRow } from '../components/ui/Chip';
import { Screen } from '../components/ui/Screen';
import { Sheet } from '../components/ui/Sheet';
import { EmptyState } from '../components/ui/States';
import { Text } from '../components/ui/Text';
import { TextField } from '../components/ui/TextField';
import { useToast } from '../components/ui/Toast';
import { TopBar } from '../components/ui/TopBar';
import { colors, radius, space } from '../constants/theme';
import { supabase } from '../lib/api/client';
import { createCommunityRoom } from '../lib/api/features';
import { FANDOMS, fandomById } from '../lib/fandoms';
import { compact } from '../lib/format';
import { haptic, useApp, useRequireMember } from '../lib/hooks';
import type { Community, FandomId } from '../lib/model';
import { withAlpha } from '../lib/motion';

export default function CommunitiesScreen() {
  const router = useRouter();
  const toast = useToast();
  const requireMember = useRequireMember();
  const { state, dispatch } = useApp();
  const [worldFilter, setWorldFilter] = useState<'all' | FandomId>('all');
  const [liveRooms, setLiveRooms] = useState<Community[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [roomDesc, setRoomDesc] = useState('');
  const [roomFandom, setRoomFandom] = useState<FandomId>('kdrama');
  const [creating, setCreating] = useState(false);

  const loadRooms = useCallback(async () => {
    setLoading(true);
    try {
      if (!supabase) return;
      const { data } = await supabase
        .from('communities')
        .select('id, name, fandom, description, cover_tone, cover_url, drama_id, member_count, post_count, is_official, created_at')
        .order('member_count', { ascending: false })
        .limit(60);
      if (data) {
        const mapped: Community[] = data.map((row) => ({
          id: row.id,
          name: row.name,
          fandom: (row.fandom as FandomId) ?? 'kdrama',
          description: row.description ?? '',
          coverTone: row.cover_tone ?? '#E11D48',
          coverUrl: row.cover_url ?? undefined,
          dramaId: row.drama_id ?? undefined,
          memberCount: row.member_count ?? 0,
          postCount: row.post_count ?? 0,
          isOfficial: Boolean(row.is_official),
          createdAt: row.created_at ?? new Date().toISOString(),
        }));
        setLiveRooms(mapped);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);

  const rooms = useMemo(() => {
    const merged = new Map<string, Community>();
    for (const c of state.communities) merged.set(c.id, c);
    for (const c of liveRooms) merged.set(c.id, c);
    const list = [...merged.values()];
    return worldFilter === 'all' ? list : list.filter((c) => c.fandom === worldFilter);
  }, [state.communities, liveRooms, worldFilter]);

  const handleCreate = async () => {
    if (roomName.trim().length < 3 || creating) return;
    setCreating(true);
    try {
      const f = fandomById(roomFandom);
      const created = await createCommunityRoom({
        name: roomName,
        fandom: roomFandom,
        description: roomDesc,
        coverTone: f.tint,
      });
      dispatch({ type: 'joinCommunity', id: created.id, on: true });
      haptic.success();
      setCreateOpen(false);
      setRoomName('');
      setRoomDesc('');
      toast.show({ message: `Created "${created.name}"`, icon: 'checkmark-circle', tone: 'success' });
      router.push(`/community/${created.id}`);
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Could not create community',
        tone: 'danger',
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <Screen
      header={
        <TopBar
          mode="stack"
          title="Fandom Rooms"
          right={
            <Button
              label="Create"
              size="sm"
              icon="add"
              onPress={() => requireMember('create a community room', () => setCreateOpen(true))}
            />
          }
        />
      }
    >
      <View style={{ paddingVertical: space.x2 }}>
        <ChipRow>
          <Chip label="All Worlds" size="sm" selected={worldFilter === 'all'} onPress={() => setWorldFilter('all')} />
          {FANDOMS.map((f) => (
            <Chip
              key={f.id}
              label={`${f.flag} ${f.short}`}
              size="sm"
              selected={worldFilter === f.id}
              onPress={() => setWorldFilter(f.id)}
            />
          ))}
        </ChipRow>
      </View>

      <FlatList
        data={rooms}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={loadRooms} tintColor={colors.accent} />}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          !loading ? (
            <EmptyState
              icon="people-outline"
              title="No fandom rooms yet"
              body="Start a room for your favorite world, airing series, or late-night rewatch club."
              actionLabel="Start a room"
              onAction={() => requireMember('create a community room', () => setCreateOpen(true))}
            />
          ) : null
        }
        renderItem={({ item }) => {
          const world = fandomById(item.fandom);
          const joined = state.joinedCommunities.includes(item.id);
          return (
            <Pressable
              onPress={() => router.push(`/community/${item.id}`)}
              style={({ pressed }) => [styles.roomCard, pressed ? { opacity: 0.92 } : null]}
            >
              <LinearGradient
                colors={[withAlpha(item.coverTone || world.tint, 0.28), colors.surface2]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.roomInner}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x3 }}>
                  <View style={[styles.badge, { backgroundColor: withAlpha(world.tint, 0.2), borderColor: world.tint }]}>
                    <Text style={{ fontSize: 20 }}>{world.flag}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text variant="titleSmall" numberOfLines={1} style={{ flexShrink: 1 }}>
                        {item.name}
                      </Text>
                      {item.isOfficial ? <Ionicons name="checkmark-circle" size={15} color={world.tint} /> : null}
                    </View>
                    <Text variant="caption" style={{ color: world.tint }}>
                      {world.label} · {compact(Math.max(item.memberCount, joined ? 1 : 0))} members
                    </Text>
                  </View>
                  <Button
                    label={joined ? 'Joined' : 'Join'}
                    variant={joined ? 'secondary' : 'primary'}
                    size="sm"
                    onPress={() =>
                      requireMember('join a community room', () => {
                        haptic.select();
                        dispatch({ type: 'joinCommunity', id: item.id, on: !joined });
                      })
                    }
                  />
                </View>
                {item.description ? (
                  <Text variant="bodySmall" tone="secondary" numberOfLines={2}>
                    {item.description}
                  </Text>
                ) : null}
              </LinearGradient>
            </Pressable>
          );
        }}
      />

      <Sheet
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Start a Fandom Room"
        subtitle="Create a home for theories, watch parties, and edits"
      >
        <View style={{ gap: space.x4 }}>
          <View>
            <Text variant="label" style={{ marginBottom: space.x2 }}>
              Choose World
            </Text>
            <ChipRow>
              {FANDOMS.map((f) => (
                <Chip
                  key={f.id}
                  label={`${f.flag} ${f.short}`}
                  size="sm"
                  selected={roomFandom === f.id}
                  onPress={() => setRoomFandom(f.id)}
                />
              ))}
            </ChipRow>
          </View>
          <TextField
            label="Room name"
            placeholder="e.g. Weekend K-Drama Finale Club"
            value={roomName}
            onChangeText={(t) => setRoomName(t.slice(0, 60))}
            counter={60}
          />
          <TextField
            label="What happens in this room?"
            placeholder="Live episode threads, OST picks, spoiler-tagged theories..."
            value={roomDesc}
            onChangeText={(t) => setRoomDesc(t.slice(0, 240))}
            multiline
            multilineHeight={80}
            counter={240}
          />
          <Button
            label={creating ? 'Creating room…' : 'Create Room'}
            icon="sparkles-outline"
            onPress={handleCreate}
            loading={creating}
            disabled={roomName.trim().length < 3}
            block
          />
        </View>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: {
    padding: space.margin,
    gap: space.x3,
    paddingBottom: space.x8,
  },
  roomCard: {
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  roomInner: {
    padding: space.x4,
    gap: space.x3,
  },
  badge: {
    width: 44,
    height: 44,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
