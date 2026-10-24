import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { colors, radius, space } from '../../constants/theme';
import {
  fetchVideoAccessStatus,
  requestVideoCreatorAccess,
  type VideoAccessStatus,
} from '../../lib/api/features';
import { haptic, useApp } from '../../lib/hooks';
import { withAlpha } from '../../lib/motion';
import { Button } from '../ui/Button';
import { Sheet } from '../ui/Sheet';
import { Text } from '../ui/Text';
import { TextField } from '../ui/TextField';
import { useToast } from '../ui/Toast';

export interface VideoAccessSheetProps {
  visible: boolean;
  onClose: () => void;
  initialStatus?: VideoAccessStatus | null;
  onStatusChange?: (status: VideoAccessStatus) => void;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

export function VideoAccessSheet({
  visible,
  onClose,
  initialStatus,
  onStatusChange,
}: VideoAccessSheetProps) {
  const router = useRouter();
  const toast = useToast();
  const { me } = useApp();
  const [status, setStatus] = useState<VideoAccessStatus | null>(initialStatus ?? null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (initialStatus) setStatus(initialStatus);
  }, [initialStatus]);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    void fetchVideoAccessStatus()
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        onStatusChange?.(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [visible, onStatusChange]);

  const submitRequest = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await requestVideoCreatorAccess(note);
      haptic.success();
      const fresh = await fetchVideoAccessStatus();
      setStatus(fresh);
      onStatusChange?.(fresh);
      setNote('');
      toast.show({
        message: 'Creator access request submitted — you will be notified as soon as it is approved.',
        icon: 'checkmark-circle',
        tone: 'success',
      });
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Could not send request right now.',
        tone: 'danger',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const isStaff = me.role === 'admin' || me.role === 'moderator';
  const usedRatio =
    status && status.monthlyBudget > 0
      ? Math.min(1, Math.max(0, status.usedThisMonth / status.monthlyBudget))
      : 0;

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={status?.allowed ? 'Creator Video Pass Active' : 'Publish Shorts & Video Clips'}
      subtitle={
        status?.allowed
          ? `@${me.handle} · verified video creator quota`
          : 'Creator approval keeps Hallyu fast, crisp, and piracy-free'
      }
    >
      <View style={{ gap: space.x4 }}>
        <LinearGradient
          colors={[withAlpha(colors.accent, 0.24), colors.surface3]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.heroCard}
        >
          <View style={styles.heroHeader}>
            <View style={styles.badgeIcon}>
              <Ionicons
                name={status?.allowed ? 'videocam' : 'sparkles'}
                size={20}
                color={colors.onAccent}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="titleSmall">
                {status?.allowed
                  ? 'You can upload Shorts & HD post clips'
                  : status?.status === 'pending'
                    ? 'Your request is in review'
                    : 'Request Hallyu Creator Access'}
              </Text>
              <Text variant="caption" tone="secondary" style={{ marginTop: 2 }}>
                {status?.allowed
                  ? `${formatBytes(status.usedThisMonth)} used of ${formatBytes(status.monthlyBudget)} monthly allowance`
                  : 'Vertical Shorts (3–60s) · Timeline clips up to 2:20 · Auto cover watermark'}
              </Text>
            </View>
          </View>

          {status?.allowed ? (
            <View style={styles.meterTrack}>
              <View style={[styles.meterFill, { width: `${Math.max(4, usedRatio * 100)}%` }]} />
            </View>
          ) : null}
        </LinearGradient>

        {status?.allowed ? (
          <Button label="Done" onPress={onClose} block />
        ) : status?.status === 'pending' ? (
          <View style={styles.pendingBox}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2 }}>
              <Ionicons name="time-outline" size={18} color={colors.warning} />
              <Text variant="label" style={{ color: colors.warning }}>
                Pending moderator review
              </Text>
            </View>
            <Text variant="bodySmall" tone="secondary" style={{ marginTop: space.x1 }}>
              {status.requestNote
                ? `Your note: "${status.requestNote}"`
                : 'Our moderation team reviews creator requests daily and sends an instant notification once approved.'}
            </Text>
            <View style={{ marginTop: space.x3 }}>
              <Button label="Got it" variant="secondary" onPress={onClose} block />
            </View>
          </View>
        ) : (
          <>
            <View style={styles.perksList}>
              <View style={styles.perkRow}>
                <Ionicons name="film-outline" size={18} color={colors.accentText} />
                <Text variant="bodySmall" tone="secondary" style={{ flex: 1 }}>
                  Share fan edits, scene reactions, trailer breakdowns, and OST moments.
                </Text>
              </View>
              <View style={styles.perkRow}>
                <Ionicons name="shield-checkmark-outline" size={18} color={colors.accentText} />
                <Text variant="bodySmall" tone="secondary" style={{ flex: 1 }}>
                  Automatic episode spoiler shields keep fellow viewers safe.
                </Text>
              </View>
            </View>

            {status?.status === 'declined' && status.decisionNote ? (
              <View style={styles.declinedNote}>
                <Text variant="caption" tone="secondary">
                  Last review note: {status.decisionNote}
                </Text>
              </View>
            ) : null}

            <TextField
              label="What kind of edits or clips do you want to share? (optional)"
              placeholder="e.g. K-Drama scene reactions, anime AMVs, episode recaps..."
              value={note}
              onChangeText={(t) => setNote(t.slice(0, 300))}
              multiline
              multilineHeight={80}
              counter={300}
            />

            <Button
              label={submitting ? 'Sending request…' : 'Request Video Creator Access'}
              icon="videocam-outline"
              onPress={submitRequest}
              loading={submitting}
              block
            />
          </>
        )}

        {isStaff ? (
          <Button
            label="Open Admin & Creator Studio"
            variant="ghost"
            size="sm"
            icon="shield-half-outline"
            onPress={() => {
              onClose();
              router.push('/settings/moderation');
            }}
            block
          />
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  heroCard: {
    borderRadius: radius.md,
    padding: space.x4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    gap: space.x3,
  },
  heroHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
  },
  badgeIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  meterTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surface1,
    overflow: 'hidden',
  },
  meterFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  perksList: {
    gap: space.x2,
  },
  perkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
  },
  pendingBox: {
    padding: space.x4,
    borderRadius: radius.md,
    backgroundColor: colors.surface3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  declinedNote: {
    padding: space.x3,
    borderRadius: radius.sm,
    backgroundColor: colors.surface3,
  },
});
