import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Button } from '../components/ui/Button';
import { ScrollScreen, Screen } from '../components/ui/Screen';
import { Text } from '../components/ui/Text';
import { TextField } from '../components/ui/TextField';
import { useToast } from '../components/ui/Toast';
import { TopBar } from '../components/ui/TopBar';
import { colors, radius, space } from '../constants/theme';
import { haptic, useApp } from '../lib/hooks';

type Kind = 'post' | 'comment' | 'user' | 'drama' | 'collection';

const REASONS: Record<Kind, { key: string; label: string; hint?: string }[]> = {
  post: [
    { key: 'spoiler', label: 'Untagged spoiler', hint: 'Reveals plot without a spoiler level' },
    { key: 'harassment', label: 'Harassment or bullying' },
    { key: 'hate', label: 'Hate speech' },
    { key: 'explicit', label: 'Sexual or graphic content' },
    { key: 'spam', label: 'Spam or scam' },
    { key: 'piracy', label: 'Piracy link' },
    { key: 'misinfo', label: 'False information about a person' },
    { key: 'other', label: 'Something else' },
  ],
  comment: [
    { key: 'spoiler', label: 'Untagged spoiler' },
    { key: 'harassment', label: 'Harassment or bullying' },
    { key: 'hate', label: 'Hate speech' },
    { key: 'explicit', label: 'Sexual or graphic content' },
    { key: 'spam', label: 'Spam' },
    { key: 'other', label: 'Something else' },
  ],
  user: [
    { key: 'impersonation', label: 'Pretending to be someone else' },
    { key: 'harassment', label: 'Harassing people' },
    { key: 'spam', label: 'Spam account' },
    { key: 'underage', label: 'May be under 13' },
    { key: 'other', label: 'Something else' },
  ],
  drama: [
    { key: 'wrong', label: 'Wrong information', hint: 'Title, cast, episodes, dates' },
    { key: 'duplicate', label: 'Duplicate entry' },
    { key: 'image', label: 'Inappropriate image' },
    { key: 'other', label: 'Something else' },
  ],
  collection: [
    { key: 'title', label: 'Offensive title or description' },
    { key: 'spam', label: 'Spam' },
    { key: 'other', label: 'Something else' },
  ],
};

/** Report flow (Play UGC policy): reason → optional detail → confirmation with block offer. */
export default function Report() {
  const router = useRouter();
  const toast = useToast();
  const { targetId, kind: kindParam } = useLocalSearchParams<{ targetId: string; kind: Kind }>();
  const kind: Kind = (['post', 'comment', 'user', 'drama', 'collection'] as Kind[]).includes(kindParam) ? kindParam : 'post';
  const { state, dispatch, getUser, getPost } = useApp();
  const [reason, setReason] = useState<string | null>(null);
  const [detail, setDetail] = useState('');
  const [done, setDone] = useState(false);
  const already = state.reported.includes(targetId);
  const offender = kind === 'user' ? getUser(targetId) : kind === 'post' ? getUser(getPost(targetId)?.authorId ?? '') : undefined;

  const submit = () => {
    dispatch({
      type: 'report',
      id: targetId,
      targetType: kind,
      reason: reason ?? 'other',
      detail: detail.trim() || undefined,
    });
    haptic.success();
    setDone(true);
  };

  if (done || already) {
    return (
      <Screen header={<TopBar mode="modal" title="Report" />}>
        <View style={styles.done}>
          <View style={styles.check}>
            <Ionicons name="checkmark" size={28} color={colors.onAccent} />
          </View>
          <Text variant="headline" align="center" style={{ marginTop: space.x4 }}>
            {already && !done ? 'Already reported' : 'Thanks — we’ve got it'}
          </Text>
          <Text variant="body" tone="secondary" align="center" style={{ marginTop: space.x2 }}>
            Reports are reviewed by people, usually within 24 hours. We’ll act if it breaks the guidelines and you won’t be told who reported.
          </Text>
          {offender && offender.id !== state.profile.id && !state.blockedUsers.includes(offender.id) ? (
            <Button label={`Block @${offender.handle}`} variant="secondary" style={{ marginTop: space.x6 }} onPress={() => { dispatch({ type: 'block', userId: offender.id, on: true }); toast.show({ message: `Blocked @${offender.handle}` }); if (router.canGoBack()) router.back(); else router.replace('/(tabs)'); }} />
          ) : null}
          <Button label="Done" style={{ marginTop: space.x2 }} onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen header={<TopBar mode="modal" title={`Report ${kind}`} />}>
      <ScrollScreen keyboard column padded>
        <Text variant="titleLarge" style={{ marginTop: space.x2 }}>
          What’s wrong with this {kind}?
        </Text>
        <Text variant="bodySmall" tone="secondary" style={{ marginTop: 4, marginBottom: space.x4 }}>
          Your report is anonymous.
        </Text>
        <View style={{ gap: space.x2 }}>
          {REASONS[kind].map((r) => {
            const on = reason === r.key;
            return (
              <Pressable key={r.key} onPress={() => { haptic.select(); setReason(r.key); }} style={[styles.reason, on ? styles.reasonOn : null]} accessibilityRole="radio" accessibilityState={{ checked: on }}>
                <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={20} color={on ? colors.accentText : colors.textTertiary} />
                <View style={{ flex: 1 }}>
                  <Text variant="body">{r.label}</Text>
                  {r.hint ? (
                    <Text variant="caption" tone="secondary">
                      {r.hint}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </View>
        {reason ? <TextField label="Anything else? (optional)" value={detail} onChangeText={setDetail} multiline multilineHeight={96} counter={500} placeholder={reason === 'spoiler' ? 'Which episode does it spoil?' : 'Details help reviewers act faster.'} containerStyle={{ marginTop: space.x5 }} /> : null}
        <Button label="Submit report" size="lg" block disabled={!reason} onPress={submit} style={{ marginTop: space.x6 }} />
        <Text variant="caption" tone="tertiary" align="center" style={{ marginTop: space.x3 }}>
          False reports waste reviewers’ time and may limit your account.
        </Text>
      </ScrollScreen>
    </Screen>
  );
}

const styles = StyleSheet.create({
  reason: { flexDirection: 'row', alignItems: 'center', gap: space.x3, padding: space.x3, borderRadius: radius.md, backgroundColor: colors.surface1, borderWidth: 1, borderColor: 'transparent' },
  reasonOn: { borderColor: colors.borderStrong, backgroundColor: colors.surface2 },
  done: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.x8, maxWidth: 480, alignSelf: 'center', width: '100%' },
  check: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.success, alignItems: 'center', justifyContent: 'center' },
});
