import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';
import { Button } from '../../components/ui/Button';
import { Chip, ChipRow } from '../../components/ui/Chip';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { Text } from '../../components/ui/Text';
import { TextField } from '../../components/ui/TextField';
import { useToast } from '../../components/ui/Toast';
import { TopBar } from '../../components/ui/TopBar';
import { colors, radius, space } from '../../constants/theme';
import { reportError } from '../../lib/analytics';
import {
  fetchSupportTickets,
  submitSupportTicket,
  type SupportTicketRecord,
} from '../../lib/api/features';
import { getInstalledBuildCode, getInstalledVersionLabel } from '../../lib/appUpdater';
import { useAuth } from '../../lib/auth';
import { timeAgo } from '../../lib/format';
import { haptic, useApp } from '../../lib/hooks';
import { ADMIN_CONTACT_EMAIL, SUPPORT_EMAIL } from '../../lib/links';

type Category = 'bug' | 'missing_title' | 'feature' | 'account';

const CATEGORIES: { id: Category; label: string; icon: keyof typeof Ionicons.glyphMap; placeholder: string }[] = [
  {
    id: 'bug',
    label: 'Bug Report',
    icon: 'bug-outline',
    placeholder: 'What happened, which screen were you on, and what did you expect instead?',
  },
  {
    id: 'missing_title',
    label: 'Missing Show / Movie',
    icon: 'film-outline',
    placeholder: 'Title name, release year, and K-Drama / C-Drama / Anime / Cinema category...',
  },
  {
    id: 'feature',
    label: 'Suggest a Feature',
    icon: 'sparkles-outline',
    placeholder: 'Tell us what would make Hallyu even better for you and your friends...',
  },
  {
    id: 'account',
    label: 'Account Help',
    icon: 'shield-checkmark-outline',
    placeholder: 'How can the Hallyu team help with your account?',
  },
];

export default function BugReportScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ category?: string; subject?: string; route?: string }>();
  const toast = useToast();
  const auth = useAuth();
  const { me } = useApp();

  const initialCat: Category =
    params.category === 'missing_title' ||
    params.category === 'feature' ||
    params.category === 'account'
      ? params.category
      : 'bug';

  const [category, setCategory] = useState<Category>(initialCat);
  const [subject, setSubject] = useState(params.subject ?? '');
  const [body, setBody] = useState('');
  const [contactEmail, setContactEmail] = useState(auth.user?.email ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [myTickets, setMyTickets] = useState<SupportTicketRecord[]>([]);

  const activeMeta = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[0]!;
  const version = getInstalledVersionLabel();
  const build = Platform.OS === 'web' ? 'web' : String(getInstalledBuildCode());
  const deviceSummary = `${Platform.OS} ${String(Platform.Version ?? '')} · v${version} (${build}) · @${me.handle}`;

  const loadMyTickets = useCallback(async () => {
    if (auth.status !== 'signedIn') return;
    const rows = await fetchSupportTickets('all').catch(() => []);
    setMyTickets(
      me.role === 'admin' || me.role === 'moderator'
        ? rows.filter((r) => r.reporter?.handle === me.handle || r.reporterEmail === auth.user?.email)
        : rows,
    );
  }, [auth.status, auth.user?.email, me.handle, me.role]);

  useEffect(() => {
    void loadMyTickets();
  }, [loadMyTickets]);

  const handleSubmit = async () => {
    if (!subject.trim() || !body.trim() || submitting) return;
    setSubmitting(true);
    try {
      await submitSupportTicket({
        category,
        subject: subject.trim(),
        description: body.trim(),
        reporterEmail: contactEmail.trim() || auth.user?.email || '',
        appVersion: `${version} (${build})`,
        platform: Platform.OS,
        routeName: params.route ?? '/settings/bug-report',
        diagnostics: {
          deviceSummary,
          userAgent:
            Platform.OS === 'web' && typeof navigator !== 'undefined'
              ? navigator.userAgent
              : Platform.OS,
        },
      });
      haptic.success();
      setSubject('');
      setBody('');
      await loadMyTickets();
      toast.show({
        message: 'Received! Your report is logged in Admin Studio and admins were notified.',
        tone: 'success',
      });
      if (me.role === 'admin' || me.role === 'moderator') {
        router.push({ pathname: '/settings/moderation', params: { tab: 'support' } });
      }
    } catch (err) {
      reportError('support.submitTicket', err);
      const mailUrl = `mailto:${SUPPORT_EMAIL}?cc=${encodeURIComponent(
        ADMIN_CONTACT_EMAIL,
      )}&subject=${encodeURIComponent(`[Hallyu ${category.toUpperCase()}] ${subject}`)}&body=${encodeURIComponent(
        `${body}\n\n---\n${deviceSummary}`,
      )}`;
      await Linking.openURL(mailUrl).catch(() => {});
      toast.show({ message: `Offline fallback: opened email draft to ${SUPPORT_EMAIL}` });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen header={<TopBar mode="stack" title="Report a Bug or Feedback" />}>
      <ScrollScreen keyboard padded column>
        <View style={styles.banner}>
          <Ionicons name="flash-outline" size={20} color={colors.accent} />
          <View style={{ flex: 1 }}>
            <Text variant="label">Direct line to Hallyu Support</Text>
            <Text variant="caption" tone="secondary">
              Submissions land immediately in the Hallyu Admin Inbox and notify our team. You can
              also email {SUPPORT_EMAIL} anytime.
            </Text>
          </View>
        </View>

        <Text variant="overline" tone="secondary" style={{ marginTop: space.x4, marginBottom: space.x2 }}>
          WHAT CAN WE HELP WITH?
        </Text>
        <ChipRow>
          {CATEGORIES.map((c) => (
            <Chip
              key={c.id}
              label={c.label}
              icon={c.icon}
              size="sm"
              selected={category === c.id}
              onPress={() => setCategory(c.id)}
            />
          ))}
        </ChipRow>

        <View style={{ gap: space.x3, marginTop: space.x4 }}>
          <TextField
            label="Summary"
            placeholder={
              category === 'missing_title'
                ? 'Show or movie title (e.g. Judge from Hell)'
                : 'Short summary'
            }
            value={subject}
            onChangeText={setSubject}
          />
          <TextField
            label="Details"
            placeholder={activeMeta.placeholder}
            multiline
            multilineHeight={132}
            value={body}
            onChangeText={setBody}
          />
          <TextField
            label="Reply email (optional)"
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            value={contactEmail}
            onChangeText={setContactEmail}
          />

          <View style={styles.diagBox}>
            <Ionicons name="hardware-chip-outline" size={16} color={colors.textTertiary} />
            <Text variant="caption" tone="tertiary" style={{ flex: 1 }}>
              Diagnostic snapshot attached automatically: {deviceSummary}
            </Text>
          </View>

          <Button
            label="Send Report"
            icon="paper-plane-outline"
            block
            loading={submitting}
            disabled={!subject.trim() || !body.trim()}
            onPress={() => void handleSubmit()}
          />
        </View>

        {myTickets.length > 0 ? (
          <View style={{ gap: space.x2, marginTop: space.x6 }}>
            <Text variant="overline" tone="secondary">
              YOUR SUBMITTED REPORTS ({myTickets.length})
            </Text>
            {myTickets.slice(0, 6).map((t) => (
              <View key={t.id} style={styles.ticketRow}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                  <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>
                    {t.subject}
                  </Text>
                  <Text
                    variant="overline"
                    style={{
                      color:
                        t.status === 'resolved'
                          ? '#10B981'
                          : t.status === 'investigating'
                            ? '#F59E0B'
                            : colors.accent,
                    }}
                  >
                    {t.status.toUpperCase()}
                  </Text>
                </View>
                <Text variant="caption" tone="secondary" numberOfLines={2}>
                  {t.description}
                </Text>
                {t.staffNote ? (
                  <Text variant="caption" style={{ color: '#10B981', marginTop: 2 }}>
                    Team note: {t.staffNote}
                  </Text>
                ) : null}
                <Text variant="caption" tone="tertiary">
                  {t.category.toUpperCase()} · {timeAgo(t.createdAt)}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollScreen>
    </Screen>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    marginTop: space.x2,
    padding: space.x4,
    borderRadius: radius.lg,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: 'rgba(225,29,72,0.28)',
  },
  diagBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  ticketRow: {
    gap: 4,
    padding: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
});
