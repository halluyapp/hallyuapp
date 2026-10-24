import { useRouter } from 'expo-router';
import React from 'react';
import { Linking } from 'react-native';
import { SettingsGroup, SettingsRow } from '../../components/settings/Rows';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { TopBar } from '../../components/ui/TopBar';
import { ADMIN_CONTACT_EMAIL, SUPPORT_EMAIL } from '../../lib/links';

export default function Help() {
  const router = useRouter();
  const mail = (to: string, subject: string) =>
    Linking.openURL(`mailto:${to}?subject=${encodeURIComponent(subject)}`).catch(() => {});

  return (
    <Screen header={<TopBar mode="stack" title="Help & Support" />}>
      <ScrollScreen>
        <SettingsGroup title="In-App Fast Track">
          <SettingsRow
            icon="bug-outline"
            label="Report a bug"
            detail="Send directly to the Hallyu team with device diagnostics"
            onPress={() =>
              router.push({ pathname: '/settings/bug-report', params: { category: 'bug' } })
            }
          />
          <SettingsRow
            icon="film-outline"
            label="Request a missing show or movie"
            detail="Tell us any K-Drama, C-Drama, Anime, or film to add immediately"
            onPress={() =>
              router.push({
                pathname: '/settings/bug-report',
                params: { category: 'missing_title' },
              })
            }
          />
          <SettingsRow
            icon="bulb-outline"
            label="Suggest a feature"
            detail="Share ideas for Watch Parties, Fandom Rooms, or profiles"
            onPress={() =>
              router.push({ pathname: '/settings/bug-report', params: { category: 'feature' } })
            }
          />
        </SettingsGroup>

        <SettingsGroup title="Quick Answers">
          <SettingsRow
            icon="eye-off-outline"
            label="How does automatic spoiler protection work?"
            detail="Hallyu hides episode discussions beyond your watchlist progress."
            onPress={() => router.push('/settings/content')}
          />
          <SettingsRow
            icon="flame-outline"
            label="When do Live Watch Parties & Rooms open?"
            detail="Synchronized rooms open automatically in your local timezone."
            onPress={() => router.push('/events')}
          />
          <SettingsRow
            icon="rocket-outline"
            label="How do app updates work?"
            detail="Install signed updates directly inside Settings → App Updates."
            onPress={() => router.push('/settings/updates')}
          />
        </SettingsGroup>

        <SettingsGroup title="Official Contact">
          <SettingsRow
            icon="mail-outline"
            label="Hallyu Support Desk"
            value={SUPPORT_EMAIL}
            onPress={() => mail(SUPPORT_EMAIL, 'Hallyu Support Inquiry')}
          />
          <SettingsRow
            icon="shield-outline"
            label="Creator & Partnerships Desk"
            value={ADMIN_CONTACT_EMAIL}
            onPress={() => mail(ADMIN_CONTACT_EMAIL, 'Hallyu Creator / Partnership Inquiry')}
          />
        </SettingsGroup>
      </ScrollScreen>
    </Screen>
  );
}
