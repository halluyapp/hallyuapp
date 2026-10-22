import { useLocalSearchParams } from 'expo-router';
import React from 'react';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { space } from '../../constants/theme';
import { ADMIN_CONTACT_EMAIL, SUPPORT_EMAIL } from '../../lib/links';

const DOCS = {
  privacy: {
    title: 'Privacy Policy',
    sections: [
      [
        'What we collect',
        'Your email address, username (@handle), display profile, watchlist entries, collections, posts, comments, reactions, direct messages, and device push tokens needed to deliver notifications you opt into. Hallyu never sells personal data.',
      ],
      [
        'Device permissions & push alerts',
        'Notification tokens (Android FCM and Apple/Web Push) are used solely to deliver episode alerts, replies, direct messages, and community announcements you choose to receive.',
      ],
      [
        'Catalog & metadata',
        'Show, film, episode, and cast metadata is sourced from TMDB and synchronized with Hallyu community rooms.',
      ],
      [
        'Data export & account deletion',
        `You can export a full JSON archive of your account or permanently delete your account anytime inside Settings → Account, or by emailing ${SUPPORT_EMAIL}.`,
      ],
      [
        'Official privacy contact',
        `Primary Support & Privacy Desk: ${SUPPORT_EMAIL} · Administration: ${ADMIN_CONTACT_EMAIL}`,
      ],
    ],
  },
  terms: {
    title: 'Terms of Service',
    sections: [
      [
        'Eligibility & account security',
        'You must be 13 years of age or older to hold a Hallyu account. Keep your login credentials secure; you are responsible for activity published under your @handle.',
      ],
      [
        'Community conduct & spoilers',
        'You retain ownership of your reviews, edits, and posts while granting Hallyu a worldwide license to display them across Hallyu apps and web share cards. Tag major plot spoilers respectfully; harassment, hate speech, piracy links, and non-consensual content are removed and may result in account suspension.',
      ],
      [
        'Catalog attribution',
        'Show and film information is provided via third-party sources including TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.',
      ],
      [
        'Contact & notices',
        `Questions regarding these terms may be sent anytime to ${SUPPORT_EMAIL} or ${ADMIN_CONTACT_EMAIL}.`,
      ],
    ],
  },
} as const;

export default function Legal() {
  const { doc } = useLocalSearchParams<{ doc?: keyof typeof DOCS }>();
  const d = DOCS[doc === 'terms' ? 'terms' : 'privacy'];
  return (
    <Screen header={<TopBar mode="stack" title={d.title} />}>
      <ScrollScreen column padded>
        {d.sections.map(([h, b]) => (
          <React.Fragment key={h}>
            <Text variant="titleSmall" style={{ marginTop: space.x5 }}>
              {h}
            </Text>
            <Text variant="body" tone="secondary" style={{ marginTop: 4 }}>
              {b}
            </Text>
          </React.Fragment>
        ))}
        <Text variant="caption" tone="tertiary" style={{ marginVertical: space.x8 }}>
          Effective October 2026 · Hallyu Community Platform
        </Text>
      </ScrollScreen>
    </Screen>
  );
}
