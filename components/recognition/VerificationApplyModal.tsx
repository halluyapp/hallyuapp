import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { colors, radius, space } from '../../constants/theme';
import {
  fetchMyVerificationStatus,
  submitVerificationApplication,
  type MyVerificationStatus,
  type VerificationRequestRecord,
} from '../../lib/api/recognition';
import { haptic } from '../../lib/hooks';
import { Button } from '../ui/Button';
import { Chip, ChipRow } from '../ui/Chip';
import { Sheet } from '../ui/Sheet';
import { Text } from '../ui/Text';
import { TextField } from '../ui/TextField';
import { useToast } from '../ui/Toast';
import { VerificationSeal } from './VerificationSeal';

const CATEGORIES: { key: VerificationRequestRecord['category']; label: string }[] = [
  { key: 'creator', label: 'Creator' },
  { key: 'journalist', label: 'Critic / Press' },
  { key: 'community_leader', label: 'Community Lead' },
  { key: 'public_figure', label: 'Public Figure' },
  { key: 'official_brand', label: 'Official Partner' },
];

export function VerificationApplySheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const [status, setStatus] = useState<MyVerificationStatus | null>(null);
  const [category, setCategory] = useState<VerificationRequestRecord['category']>('creator');
  const [statement, setStatement] = useState('');
  const [linkOne, setLinkOne] = useState('');
  const [linkTwo, setLinkTwo] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const res = await fetchMyVerificationStatus();
    setStatus(res);
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const handleSubmit = async () => {
    if (statement.trim().length < 10 || submitting) return;
    setSubmitting(true);
    try {
      await submitVerificationApplication({
        requestedTier: 'blue',
        category,
        statement: statement.trim(),
        evidenceLinks: [linkOne, linkTwo].filter((l) => l.trim().length > 0),
      });
      haptic.success();
      setStatement('');
      setLinkOne('');
      setLinkTwo('');
      toast.show({
        message: 'Verification request submitted for admin review',
        tone: 'success',
      });
      await load();
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Unable to submit request',
        tone: 'danger',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet visible={open} onClose={onClose} title="Account Verification">
      <View style={{ gap: space.x3, paddingBottom: space.x4 }}>
        {/* Tier Guide */}
        <View style={styles.guideBox}>
          <View style={styles.tierRow}>
            <VerificationSeal tier="blue" size={22} />
            <View style={{ flex: 1 }}>
              <Text variant="titleSmall">Blue Checkmark — Authentic Identity</Text>
              <Text variant="caption" tone="secondary">
                Verified creators, drama/anime critics, community leaders, and notable public figures. Never sold.
              </Text>
            </View>
          </View>
          <View style={styles.tierRow}>
            <VerificationSeal tier="red" size={22} />
            <View style={{ flex: 1 }}>
              <Text variant="titleSmall">Red Checkmark — Official Authority</Text>
              <Text variant="caption" tone="secondary">
                Reserved strictly for Hallyu founders, executive staff, and official platform authority accounts.
              </Text>
            </View>
          </View>
        </View>

        {status?.tier && status.tier !== 'none' ? (
          <View style={styles.statusCard}>
            <VerificationSeal tier={status.tier} size={28} showPill />
            <Text variant="titleSmall" style={{ marginTop: space.x2 }}>
              Your account holds active {status.tier.toUpperCase()} verification
            </Text>
            {status.verificationNote ? (
              <Text variant="caption" tone="secondary">
                {status.verificationNote}
              </Text>
            ) : null}
          </View>
        ) : status?.request?.status === 'pending' ? (
          <View style={styles.statusCard}>
            <Text variant="overline" tone="accent">
              APPLICATION PENDING REVIEW
            </Text>
            <Text variant="bodySmall" tone="secondary">
              Submitted {new Date(status.request.createdAt).toLocaleDateString()} · Category:{' '}
              {status.request.category.replace('_', ' ')}
            </Text>
            <Text variant="caption" tone="tertiary">
              “{status.request.statement}”
            </Text>
          </View>
        ) : (
          <>
            {status?.request?.status === 'rejected' ? (
              <View style={[styles.statusCard, { borderColor: 'rgba(239, 68, 68, 0.35)' }]}>
                <Text variant="overline" style={{ color: colors.danger }}>
                  PREVIOUS APPLICATION REVIEW NOTE
                </Text>
                <Text variant="caption" tone="secondary">
                  {status.request.reviewReason ?? 'Not approved yet — you may submit updated proof below.'}
                </Text>
              </View>
            ) : null}

            <Text variant="overline" tone="secondary">
              SELECT IDENTITY CATEGORY
            </Text>
            <ChipRow>
              {CATEGORIES.map((c) => (
                <Chip
                  key={c.key}
                  label={c.label}
                  size="sm"
                  selected={category === c.key}
                  onPress={() => setCategory(c.key)}
                />
              ))}
            </ChipRow>

            <TextField
              label="Why should your identity be verified?"
              placeholder="Share your creator channel, editorial body of work, or community leadership role (min 10 chars)..."
              multiline
              value={statement}
              onChangeText={setStatement}
            />

            <TextField
              label="Primary Proof Link (Optional)"
              placeholder="https://youtube.com/@... or official site"
              autoCapitalize="none"
              autoCorrect={false}
              value={linkOne}
              onChangeText={setLinkOne}
            />

            <TextField
              label="Secondary Social / Press Link (Optional)"
              placeholder="https://instagram.com/... or portfolio"
              autoCapitalize="none"
              autoCorrect={false}
              value={linkTwo}
              onChangeText={setLinkTwo}
            />

            <Button
              label="Submit Verification Request"
              icon="shield-checkmark-outline"
              loading={submitting}
              disabled={statement.trim().length < 10}
              onPress={() => void handleSubmit()}
              block
            />
          </>
        )}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  guideBox: {
    backgroundColor: colors.surface1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: space.x3,
    gap: space.x3,
  },
  tierRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.x3,
  },
  statusCard: {
    backgroundColor: colors.surface1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: space.x4,
    gap: 6,
  },
});
