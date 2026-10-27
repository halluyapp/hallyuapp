import React, { useId, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { colors, radius, space } from '../../constants/theme';
import { resolveVerificationTier, VerificationTier } from '../../lib/model';
import { Button } from '../ui/Button';
import { Text } from '../ui/Text';

/**
 * Precision 12-lobe scalloped rosette path in a 24x24 viewBox.
 * Generated symmetrically around center (12, 12) so every scale (14px post meta up to 44px inspector)
 * renders razor-sharp on Web SVG, iOS CoreGraphics, and Android Canvas.
 */
function buildScallopedSealPath(cx = 12, cy = 12, outerR = 10.9, innerR = 9.05, lobes = 12): string {
  const step = (Math.PI * 2) / lobes;
  const parts: string[] = [];
  for (let i = 0; i < lobes; i += 1) {
    const a0 = i * step - Math.PI / 2;
    const aMid = a0 + step * 0.5;
    const a1 = a0 + step;
    const x0 = cx + innerR * Math.cos(a0);
    const y0 = cy + innerR * Math.sin(a0);
    const xCtrl = cx + (outerR + 0.85) * Math.cos(aMid);
    const yCtrl = cy + (outerR + 0.85) * Math.sin(aMid);
    const x1 = cx + innerR * Math.cos(a1);
    const y1 = cy + innerR * Math.sin(a1);
    if (i === 0) {
      parts.push(`M ${x0.toFixed(2)} ${y0.toFixed(2)}`);
    }
    parts.push(`Q ${xCtrl.toFixed(2)} ${yCtrl.toFixed(2)} ${x1.toFixed(2)} ${y1.toFixed(2)}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

const SEAL_PATH = buildScallopedSealPath();

const SEAL_PALETTE = {
  blue: {
    start: '#38BDF8',
    mid: '#2563EB',
    end: '#1D4ED8',
    ring: 'rgba(255,255,255,0.34)',
    pillBg: 'rgba(37, 99, 235, 0.16)',
    pillBorder: 'rgba(56, 189, 248, 0.42)',
    pillText: '#60A5FA',
    shortLabel: 'Verified',
    title: 'Authentic Verified Account',
    summary:
      'Confirmed authentic identity of a notable creator, critic, community leader, or public figure on Hallyu.',
  },
  red: {
    start: '#FB7185',
    mid: '#E11D48',
    end: '#9F1239',
    ring: 'rgba(255,241,242,0.44)',
    pillBg: 'rgba(225, 29, 72, 0.18)',
    pillBorder: 'rgba(251, 113, 133, 0.48)',
    pillText: '#FB7185',
    shortLabel: 'Official',
    title: 'Official Hallyu Authority',
    summary:
      'Reserved exclusively for official Hallyu executive leadership, platform founders, and authoritative system accounts.',
  },
} as const;

export interface VerificationSealProps {
  tier?: VerificationTier | string | null;
  verified?: boolean;
  size?: number;
  showPill?: boolean;
  interactive?: boolean;
  note?: string | null;
  handle?: string;
}

export function VerificationSeal({
  tier,
  verified,
  size = 16,
  showPill = false,
  interactive = false,
  note,
  handle,
}: VerificationSealProps) {
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [infoOpen, setInfoOpen] = useState(false);
  const resolved = resolveVerificationTier({ verified, verificationTier: tier });

  if (resolved === 'none') return null;

  const palette = SEAL_PALETTE[resolved];
  const gradId = `verifGrad_${resolved}_${rawId}`;

  const sealGraphic = (
    <View style={[styles.inlineWrap, showPill ? [styles.pill, { backgroundColor: palette.pillBg, borderColor: palette.pillBorder }] : null]}>
      <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityLabel={palette.title}>
        <Defs>
          <LinearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor={palette.start} />
            <Stop offset="52%" stopColor={palette.mid} />
            <Stop offset="100%" stopColor={palette.end} />
          </LinearGradient>
        </Defs>
        <Path d={SEAL_PATH} fill={`url(#${gradId})`} />
        <Circle cx="12" cy="12" r="7.5" fill="none" stroke={palette.ring} strokeWidth="0.85" />
        <Path
          d="M 8.55 12.25 L 10.95 14.65 L 15.65 9.65"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth="2.35"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
      {showPill ? (
        <Text
          variant="caption"
          style={{
            color: palette.pillText,
            fontWeight: '700',
            fontSize: 11,
            letterSpacing: 0.25,
          }}
        >
          {palette.shortLabel}
        </Text>
      ) : null}
    </View>
  );

  if (!interactive) {
    return sealGraphic;
  }

  return (
    <>
      <Pressable
        onPress={() => setInfoOpen(true)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`${palette.title}${handle ? ` (@${handle})` : ''}`}
      >
        {sealGraphic}
      </Pressable>

      <Modal
        visible={infoOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setInfoOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setInfoOpen(false)}>
          <Pressable style={styles.dialogCard} onPress={(e) => e.stopPropagation()}>
            <View style={{ alignItems: 'center', gap: space.x3 }}>
              <VerificationSeal tier={resolved} size={46} />
              <Text variant="title" align="center">
                {palette.title}
              </Text>
              {handle ? (
                <Text variant="caption" style={{ color: palette.pillText, fontWeight: '700' }}>
                  @{handle}
                </Text>
              ) : null}
              <Text variant="bodySmall" tone="secondary" align="center">
                {palette.summary}
              </Text>
              {note ? (
                <View style={styles.noteBox}>
                  <Text variant="overline" tone="tertiary">
                    VERIFICATION RECORD
                  </Text>
                  <Text variant="caption" tone="secondary">
                    {note}
                  </Text>
                </View>
              ) : null}
              <Button
                label="Done"
                variant="secondary"
                size="sm"
                onPress={() => setInfoOpen(false)}
                block
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  inlineWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.margin,
  },
  dialogCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.surface2,
    borderRadius: radius.xl,
    padding: space.x5,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  noteBox: {
    width: '100%',
    backgroundColor: colors.surface1,
    borderRadius: radius.md,
    padding: space.x3,
    gap: 4,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
});
