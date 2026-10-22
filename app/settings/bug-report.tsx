import { Ionicons } from '@expo/vector-icons';
import * as Application from 'expo-application';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';
import { Button } from '../../components/ui/Button';
import { Chip, ChipRow } from '../../components/ui/Chip';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { Text } from '../../components/ui/Text';
import { TextField } from '../../components/ui/TextField';
import { useToast } from '../../components/ui/Toast';
import { TopBar } from '../../components/ui/TopBar';
import { colors, radius, space } from '../../constants/theme';
import { submitSupportTicket } from '../../lib/api/features';
import { useAuth } from '../../lib/auth';
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

  const activeMeta = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[0]!;
  const version = Application.nativeApplicationVersion ?? '1.0.0';
  const build = Application.nativeBuildVersion ?? 'web';
  const deviceSummary = `${Platform.OS} ${String(Platform.Version ?? '')} · v${version} (${build}) · @${me.handle}`;

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
      toast.show({
        message: 'Received! Your report went straight to the Hallyu team.',
        tone: 'success',
      });
      router.back();
    } catch {
      // Fallback to direct mail client prefilled with fixhallyu@gmail.com if offline
      const mailUrl = `mailto:${SUPPORT_EMAIL}?cc=${encodeURIComponent(
        ADMIN_CONTACT_EMAIL,
      )}&subject=${encodeURIComponent(`[Hallyu ${category.toUpperCase()}] ${subject}`)}&body=${encodeURIComponent(
        `${body}\n\n---\n${deviceSummary}`,
      )}`;
      await Linking.openURL(mailUrl).catch(() => {});
      toast.show({ message: `Opened email draft to ${SUPPORT_EMAIL}` });
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
            value={body}
            onChangeText={setBody}
          />
          <TextField
            label="Reply email (optional)"
            placeholder="So we can let you know as soon as it’s fixed"
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
});
