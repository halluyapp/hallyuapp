import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';
import { colors, fonts, radius, space } from '../../constants/theme';
import { sendDirectMessage } from '../../lib/api/features';
import { dramaFandom } from '../../lib/fandoms';
import { haptic, useApp, useRequireMember } from '../../lib/hooks';
import type { Drama, Post, User } from '../../lib/model';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';
import { Poster } from '../ui/Poster';
import { Sheet } from '../ui/Sheet';
import { Text } from '../ui/Text';
import { TextField } from '../ui/TextField';
import { useToast } from '../ui/Toast';

export interface ShareCardModalProps {
  visible: boolean;
  onClose: () => void;
  drama?: Drama;
  post?: Post;
  author?: User;
  profileUser?: User;
}

/**
 * Editorial Visual Share Card + Instant 1-Tap Send-to-Friend in Hallyu Direct Messages.
 * Combines Phase 2 (Story-ready dark cinema card preview) and Phase 3 (Send to friend inside Hallyu).
 */
export function ShareCardModal({
  visible,
  onClose,
  drama,
  post,
  author,
  profileUser,
}: ShareCardModalProps) {
  const router = useRouter();
  const toast = useToast();
  const requireMember = useRequireMember();
  const { state, me } = useApp();
  const [recipientQuery, setRecipientQuery] = useState('');
  const [note, setNote] = useState('');
  const [sendingTo, setSendingTo] = useState<string | null>(null);

  const world = drama ? dramaFandom(drama) : undefined;
  const accentColor = world?.tint ?? colors.accent;

  const friends = useMemo(() => {
    const followed = state.follows.users
      .map((id) => state.users[id])
      .filter((u): u is User => Boolean(u && u.id !== me.id));
    const others = Object.values(state.users).filter(
      (u) => u.id !== me.id && !state.follows.users.includes(u.id),
    );
    const pool = [...followed, ...others];
    const q = recipientQuery.trim().toLowerCase().replace(/^@/, '');
    if (!q) return pool.slice(0, 12);
    return pool
      .filter(
        (u) =>
          u.handle.toLowerCase().includes(q) ||
          u.displayName.toLowerCase().includes(q),
      )
      .slice(0, 12);
  }, [state.follows.users, state.users, me.id, recipientQuery]);

  const shareText = useMemo(() => {
    if (profileUser) {
      return `${profileUser.displayName} (@${profileUser.handle}) on Hallyu — check out my Top 4 & Watch DNA! https://hallyu.app/u/${profileUser.handle}`;
    }
    if (post) {
      const label = drama ? `${drama.title}${post.rating ? ` ★ ${post.rating.toFixed(1)}/10` : ''}` : 'Hallyu';
      const quote = post.verdict || post.title || post.body.slice(0, 160);
      return `${label}\n"${quote}" — @${author?.handle ?? me.handle} on Hallyu\nhttps://hallyu.app/post/${post.id}`;
    }
    if (drama) {
      return `${drama.title} (${drama.year})${drama.rating ? ` · ★ ${drama.rating.toFixed(1)}` : ''} on Hallyu\nhttps://hallyu.app/drama/${drama.id}`;
    }
    return 'Hallyu — Where fandoms watch together';
  }, [profileUser, post, drama, author, me.handle]);

  const handleCopy = async () => {
    await Clipboard.setStringAsync(shareText);
    haptic.light();
    toast.show({ message: 'Copied share card link', icon: 'checkmark-circle', tone: 'success' });
    onClose();
  };

  const handleSystemShare = async () => {
    haptic.light();
    await Share.share({ message: shareText });
  };

  const handleSendToHandle = async (handle: string) => {
    const clean = handle.trim().replace(/^@/, '');
    if (!clean || sendingTo) return;
    setSendingTo(clean);
    try {
      const defaultMsg =
        note.trim() ||
        (post
          ? post.verdict || post.title || `Check out this post${drama ? ` on ${drama.title}` : ''}`
          : drama
            ? `Have you watched ${drama.title}?`
            : profileUser
              ? `Check out @${profileUser.handle}'s profile!`
              : 'Look at this on Hallyu');
      await sendDirectMessage(clean, defaultMsg, {
        sharedDramaId: drama?.id,
        sharedPostId: post?.id,
      });
      haptic.success();
      toast.show({
        message: `Sent to @${clean}`,
        icon: 'paper-plane-outline',
        tone: 'success',
        actionLabel: 'Open chat',
        onAction: () => router.push(`/messages/${clean}`),
      });
      setNote('');
      onClose();
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : `Could not send to @${clean}`,
        tone: 'danger',
      });
    } finally {
      setSendingTo(null);
    }
  };

  const typedHandle = recipientQuery.trim().replace(/^@/, '');

  return (
    <Sheet visible={visible} onClose={onClose} title="Share card & send">
      <View style={{ gap: space.x4 }}>
        {/* Cinema Visual Story Card Preview */}
        <LinearGradient
          colors={[`${accentColor}38`, colors.surface1, '#07070A']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.cardPreview}
        >
          <View style={styles.cardHeader}>
            <View style={[styles.brandPill, { borderColor: `${accentColor}66` }]}>
              <View style={[styles.brandDot, { backgroundColor: accentColor }]} />
              <Text variant="overline" style={{ color: colors.textPrimary, letterSpacing: 1.2 }}>
                HALLYU {world ? `· ${world.label.toUpperCase()}` : ''}
              </Text>
            </View>
            {post?.rating || drama?.rating ? (
              <View style={styles.ratingBadge}>
                <Ionicons name="star" size={12} color={colors.warm} />
                <Text variant="label" style={{ color: colors.warm }}>
                  {(post?.rating ?? drama?.rating ?? 0).toFixed(1)}
                </Text>
              </View>
            ) : null}
          </View>

          <View style={styles.cardBody}>
            {drama ? <Poster drama={drama} width={74} rounded={radius.sm} /> : null}
            <View style={{ flex: 1, gap: 6 }}>
              <Text variant="title" numberOfLines={2}>
                {profileUser
                  ? profileUser.displayName
                  : post?.title || post?.verdict || drama?.title || 'Hallyu'}
              </Text>
              <Text variant="body" tone="secondary" numberOfLines={3} style={{ fontSize: 13, lineHeight: 18 }}>
                {profileUser
                  ? profileUser.bio || `${profileUser.favoriteGenres.slice(0, 3).join(' · ') || 'Cinema & Drama Fan'}`
                  : post
                    ? post.body
                    : drama?.synopsis || `${drama?.year ?? ''} · ${(drama?.genres ?? []).slice(0, 3).join(' · ')}`}
              </Text>
              <Text variant="caption" tone="tertiary">
                @{profileUser?.handle ?? author?.handle ?? me.handle}
              </Text>
            </View>
          </View>
        </LinearGradient>

        {/* Send directly to a friend in Hallyu DMs */}
        <View style={{ gap: space.x2 }}>
          <Text variant="overline" tone="tertiary">
            SEND IN HALLYU DIRECT MESSAGES
          </Text>
          <TextField
            value={recipientQuery}
            onChangeText={setRecipientQuery}
            placeholder="Search friend or type @handle…"
            leading="at-outline"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextField
            value={note}
            onChangeText={setNote}
            placeholder="Add a quick note (optional)…"
          />

          {friends.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.x3, paddingVertical: space.x1 }}>
              {friends.map((u) => (
                <Pressable
                  key={u.id}
                  onPress={() => requireMember('send messages', () => void handleSendToHandle(u.handle))}
                  style={styles.friendItem}
                  accessibilityRole="button"
                  accessibilityLabel={`Send to ${u.displayName}`}
                >
                  <Avatar uri={u.avatarUrl} name={u.displayName} size="md" />
                  <Text variant="caption" numberOfLines={1} style={{ maxWidth: 68, fontFamily: fonts.medium }}>
                    {u.displayName.split(' ')[0]}
                  </Text>
                  <View style={styles.sendMini}>
                    <Text variant="caption" style={{ color: colors.onAccent, fontSize: 11, fontFamily: fonts.semibold }}>
                      {sendingTo === u.handle ? '…' : 'Send'}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}

          {typedHandle.length >= 2 && !friends.some((f) => f.handle.toLowerCase() === typedHandle.toLowerCase()) ? (
            <Button
              label={sendingTo === typedHandle ? `Sending to @${typedHandle}…` : `Send directly to @${typedHandle}`}
              variant="secondary"
              icon="paper-plane-outline"
              onPress={() => requireMember('send messages', () => void handleSendToHandle(typedHandle))}
            />
          ) : null}
        </View>

        {/* External Share Actions */}
        <View style={styles.actionsRow}>
          <Button label="Share card" icon="share-social-outline" onPress={handleSystemShare} style={{ flex: 1 }} />
          <Button label="Copy link" variant="secondary" icon="copy-outline" onPress={handleCopy} style={{ flex: 1 }} />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  cardPreview: {
    borderRadius: radius.lg,
    padding: space.x4,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    gap: space.x3,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brandPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.x2 + 2,
    paddingVertical: 4,
    borderRadius: radius.full,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: StyleSheet.hairlineWidth,
  },
  brandDot: { width: 6, height: 6, borderRadius: 3 },
  ratingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.x2,
    paddingVertical: 3,
    borderRadius: radius.full,
    backgroundColor: colors.warmSoft,
  },
  cardBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
  },
  friendItem: {
    alignItems: 'center',
    gap: 5,
    width: 72,
  },
  sendMini: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: space.x2,
  },
});
