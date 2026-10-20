import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { colors, fonts, radius, space } from '../../constants/theme';
import { votePollOnServer } from '../../lib/api/features';
import { hasSession } from '../../lib/api/social';
import { compact } from '../../lib/format';
import { haptic, useApp, useRequireMember } from '../../lib/hooks';
import type { PostPoll } from '../../lib/model';
import { Text } from '../ui/Text';
import { useToast } from '../ui/Toast';

export function PollBlock({ postId, poll }: { postId: string; poll: PostPoll }) {
  const { dispatch } = useApp();
  const requireMember = useRequireMember();
  const toast = useToast();
  const [voting, setVoting] = useState(false);

  const hasVoted = typeof poll.myVote === 'number' && poll.myVote >= 0;
  const isClosed = Boolean(poll.closesAt && new Date(poll.closesAt).getTime() <= Date.now());
  const showResults = hasVoted || isClosed;
  const maxVotes = Math.max(1, ...poll.counts);

  const castVote = async (index: number) => {
    if (voting || isClosed) return;
    haptic.light();
    dispatch({ type: 'votePoll', postId, optionIndex: index });
    if (!hasSession()) return;
    setVoting(true);
    try {
      const synced = await votePollOnServer(postId, index);
      if (synced) {
        dispatch({ type: 'votePoll', postId, optionIndex: index, serverPoll: synced });
      }
    } catch {
      toast.show({ message: 'Could not sync poll vote right now', tone: 'danger' });
    } finally {
      setVoting(false);
    }
  };

  return (
    <View style={styles.card} accessibilityLabel={`Poll: ${poll.question}`}>
      <View style={styles.head}>
        <View style={styles.badge}>
          <Ionicons name="stats-chart" size={11} color={colors.accent} />
          <Text variant="overline" tone="accent">
            POLL
          </Text>
        </View>
        <Text variant="caption" tone="tertiary">
          {compact(poll.totalVotes)} {poll.totalVotes === 1 ? 'vote' : 'votes'}
          {isClosed ? ' · Final' : hasVoted ? ' · Tap another to switch' : ''}
        </Text>
      </View>

      {poll.question && poll.question !== 'Vote below' ? (
        <Text variant="titleSmall" style={{ lineHeight: 20 }}>
          {poll.question}
        </Text>
      ) : null}

      <View style={{ gap: space.x2 }}>
        {poll.options.map((opt, idx) => {
          const count = poll.counts[idx] ?? 0;
          const pct = poll.totalVotes > 0 ? Math.round((count / poll.totalVotes) * 100) : 0;
          const selected = poll.myVote === idx;
          const leading = showResults && count > 0 && count === maxVotes;

          return (
            <Pressable
              key={`${idx}-${opt}`}
              disabled={isClosed}
              onPress={() => requireMember('vote in polls', () => void castVote(idx))}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`${opt}${showResults ? `, ${pct}%` : ''}`}
              style={({ pressed }) => [
                styles.option,
                selected ? styles.optionSelected : null,
                pressed ? { opacity: 0.85 } : null,
              ]}
            >
              {showResults ? (
                <View
                  pointerEvents="none"
                  style={[
                    styles.fill,
                    {
                      width: `${Math.max(pct, selected ? 6 : 2)}%`,
                      backgroundColor: selected
                        ? colors.accentSoft
                        : leading
                          ? 'rgba(255,255,255,0.11)'
                          : 'rgba(255,255,255,0.055)',
                    },
                  ]}
                />
              ) : null}
              <View style={styles.optionRow}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2, flex: 1 }}>
                  <Ionicons
                    name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                    size={16}
                    color={selected ? colors.accent : colors.textTertiary}
                  />
                  <Text
                    variant="body"
                    numberOfLines={2}
                    style={[
                      { flex: 1, fontSize: 14, lineHeight: 19 },
                      selected ? { fontFamily: fonts.semibold, color: colors.textPrimary } : null,
                    ]}
                  >
                    {opt}
                  </Text>
                </View>
                {showResults ? (
                  <Text
                    variant="label"
                    style={{
                      color: selected ? colors.accent : leading ? colors.textPrimary : colors.textSecondary,
                    }}
                  >
                    {pct}%
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: space.x3,
    padding: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    gap: space.x3,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: space.x2,
    paddingVertical: 3,
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
  },
  option: {
    position: 'relative',
    minHeight: 42,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surface2,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  optionSelected: {
    borderColor: colors.accent,
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: radius.sm,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.x2,
    paddingHorizontal: space.x3,
    paddingVertical: 10,
  },
});
