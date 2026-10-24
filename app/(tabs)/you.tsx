import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ProfileView } from '../../components/profile/ProfileView';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { Screen } from '../../components/ui/Screen';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { colors, radius, space } from '../../constants/theme';
import { useAuth } from '../../lib/auth';
import { useApp } from '../../lib/hooks';

/** You — your profile as others see it, plus your shelves and the way into Settings. */
export default function You() {
  const router = useRouter();
  const auth = useAuth();
  const { me, state } = useApp();
  const drafts = state.drafts.length;

  if (auth.status !== 'signedIn') {
    return (
      <Screen header={<TopBar mode="root" title="You" large right={<IconButton icon="settings-outline" label="Settings" onPress={() => router.push('/settings')} />} />}>
        <View style={styles.guest}>
          <View style={styles.mark}>
            <Ionicons name="person-outline" size={28} color={colors.textPrimary} />
          </View>
          <Text variant="headline" align="center" style={{ marginTop: space.x4 }}>
            Make Hallyu yours
          </Text>
          <Text variant="body" tone="secondary" align="center" style={{ marginTop: space.x2 }}>
            Track what you watch, keep spoilers away, follow your fandoms and post with your people.
          </Text>
          <View style={{ gap: space.x2, marginTop: space.x6, width: '100%' }}>
            <Button label="Create account" size="lg" block onPress={() => router.push('/(auth)/sign-up')} />
            <Button label="Sign in" variant="secondary" size="lg" block onPress={() => router.push('/(auth)/sign-in')} />
          </View>
          <Text variant="caption" tone="tertiary" align="center" style={{ marginTop: space.x4 }}>
            Guest mode keeps working. Nothing you browse is lost when you join.
          </Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      header={
        <TopBar
          mode="root"
          title={`@${me.handle}`}
          right={
            <>
              {drafts ? (
                <Pressable onPress={() => router.push('/drafts')} style={styles.drafts} accessibilityRole="button" accessibilityLabel={`${drafts} drafts`}>
                  <Ionicons name="document-text-outline" size={16} color={colors.textPrimary} />
                  <Text variant="label">{drafts}</Text>
                </Pressable>
              ) : null}
              <IconButton icon="calendar-outline" label="Diary" onPress={() => router.push('/diary')} />
              <IconButton icon="library-outline" label="Book shelf" onPress={() => router.push('/shelf')} />
              <IconButton icon="tv-outline" label="Watchlist" onPress={() => router.push('/watchlist')} />
              <IconButton icon="bookmark-outline" label="Saved posts" onPress={() => router.push('/saved')} />
              <IconButton icon="settings-outline" label="Settings" onPress={() => router.push('/settings')} />
            </>
          }
        />
      }
    >
      <ProfileView user={me} isMe />
    </Screen>
  );
}

const styles = StyleSheet.create({
  guest: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.x8, maxWidth: 480, alignSelf: 'center', width: '100%' },
  mark: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  drafts: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 32, paddingHorizontal: 10, borderRadius: radius.full, backgroundColor: colors.surface2 },
});
