import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { colors, space } from '../../constants/theme';
import { compact } from '../../lib/format';
import { useApp } from '../../lib/hooks';
import { User } from '../../lib/model';
import { FollowButton } from '../drama/FollowButton';
import { Avatar } from '../ui/Avatar';
import { Tap } from '../ui/Tap';
import { Text } from '../ui/Text';
import { VerificationSeal } from '../recognition/VerificationSeal';

interface UserRowProps {
  user: User;
  reason?: string;
  style?: StyleProp<ViewStyle>;
  showFollow?: boolean;
  right?: React.ReactNode;
}

function UserRowBase({ user, reason, style, showFollow = true, right }: UserRowProps) {
  const router = useRouter();
  const { me } = useApp();
  return (
    <Tap onPress={() => router.push(`/user/${user.handle}`)} accessibilityRole="button" accessibilityLabel={`${user.displayName}, @${user.handle}`} style={[styles.row, style]}>
      <Avatar uri={user.avatarUrl} name={user.displayName} size="md" />
      <View style={{ flex: 1 }}>
        <View style={styles.name}>
          <Text variant="titleSmall" numberOfLines={1}>
            {user.displayName}
          </Text>
          <VerificationSeal tier={user.verificationTier} verified={user.verified} size={15} />
          {user.isPrivate ? <Ionicons name="lock-closed" size={12} color={colors.textTertiary} /> : null}
        </View>
        <Text variant="caption" tone="secondary" numberOfLines={1}>
          {reason ?? `@${user.handle} · ${compact(user.followers)} followers`}
        </Text>
      </View>
      {right ?? (showFollow && user.id !== me.id ? <FollowButton kind="users" id={user.id} name={user.displayName} /> : null)}
    </Tap>
  );
}

/** Card for "People to follow" rails. */
export function UserCard({ user, reason }: { user: User; reason?: string }) {
  const router = useRouter();
  return (
    <View style={styles.card}>
      <Tap onPress={() => router.push(`/user/${user.handle}`)} accessibilityRole="button" accessibilityLabel={user.displayName} style={{ alignItems: 'center' }}>
        <Avatar uri={user.avatarUrl} name={user.displayName} size="lg" />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: space.x2 }}>
          <Text variant="titleSmall" numberOfLines={1}>
            {user.displayName}
          </Text>
          <VerificationSeal tier={user.verificationTier} verified={user.verified} size={14} />
        </View>
        <Text variant="caption" tone="tertiary" numberOfLines={2} align="center">
          {reason ?? `@${user.handle}`}
        </Text>
      </Tap>
      <FollowButton kind="users" id={user.id} name={user.displayName} block style={{ marginTop: space.x3 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.x3, paddingVertical: space.x2 },
  name: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  card: { width: 156, backgroundColor: colors.surface1, borderRadius: 16, padding: space.x4, alignItems: 'stretch' },
});

/** Memoised: with tracked store getters, a card re-renders only when its own data changes. */
export const UserRow = React.memo(UserRowBase);
