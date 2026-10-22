import React from 'react';
import { View } from 'react-native';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { space } from '../../constants/theme';
import { SUPPORT_EMAIL } from '../../lib/links';

const RULES: { title: string; body: string }[] = [
  {
    title: 'Tag your spoilers',
    body: 'Anything past the premiere needs a spoiler level — episode, season, or ending. Untagged spoilers are veiled or removed so every member can watch at their own pace.',
  },
  {
    title: 'Debate the story, respect the person',
    body: 'Critique plots and hot takes passionately, never people. Harassment, hate speech, threats, and targeted pile-ons result in immediate account removal.',
  },
  {
    title: 'Respect cast & creators as human beings',
    body: 'Celebrate and critique performances freely. Defamation, invasive private-life rumors, and appearance harassment have no place on Hallyu.',
  },
  {
    title: 'No piracy links',
    body: 'Do not post links to unlicensed streams or downloads. Share official platforms and synchronized Episode Watch Rooms instead.',
  },
  {
    title: 'Keep Hallyu welcoming across every fandom world',
    body: 'K-Drama, C-Drama, Anime, and Cinema fans share one roof here. Fan-war spam and explicit/graphic imagery are removed.',
  },
  {
    title: 'Authentic accounts only',
    body: 'Impersonating actors, studios, creators, or Hallyu staff is prohibited.',
  },
  {
    title: 'Fast human moderation',
    body: `Community reports are anonymous and reviewed promptly by Hallyu staff (${SUPPORT_EMAIL}).`,
  },
];

export default function Guidelines() {
  return (
    <Screen header={<TopBar mode="stack" title="Community Guidelines" />}>
      <ScrollScreen column padded>
        <Text variant="body" tone="secondary" style={{ marginTop: space.x2, marginBottom: space.x6 }}>
          Hallyu brings K-Drama, C-Drama, Anime, and global cinema fans together every episode
          night. Seven simple rules keep every room electric and spoiler-safe.
        </Text>
        {RULES.map((r, i) => (
          <View key={r.title} style={{ marginBottom: space.x5 }}>
            <Text variant="titleSmall">
              {i + 1}. {r.title}
            </Text>
            <Text variant="body" tone="secondary" style={{ marginTop: 4 }}>
              {r.body}
            </Text>
          </View>
        ))}
        <Text variant="caption" tone="tertiary" style={{ marginBottom: space.x8 }}>
          Effective October 2026 · Hallyu Community Platform
        </Text>
      </ScrollScreen>
    </Screen>
  );
}
