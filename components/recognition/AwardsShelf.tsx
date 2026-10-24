import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { colors, radius, space } from '../../constants/theme';
import {
  fetchUserRecognition,
  setFeaturedBadgesOnServer,
  type RecognitionLaunchConfig,
} from '../../lib/api/recognition';
import { haptic, useApp } from '../../lib/hooks';
import type { BadgeCategory, BadgeDefinition, User, UserAward } from '../../lib/model';
import { getState } from '../../lib/store';
import { adoptLocal } from '../../lib/sync';
import { Button } from '../ui/Button';
import { Chip, ChipRow } from '../ui/Chip';
import { Sheet } from '../ui/Sheet';
import { Text } from '../ui/Text';
import { useToast } from '../ui/Toast';
import { BadgeCrest } from './BadgeCrest';

const CATEGORY_TABS: { key: 'all' | BadgeCategory; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'early_member', label: 'Early-Member' },
  { key: 'participation', label: 'Participation' },
  { key: 'content', label: 'Content' },
  { key: 'community', label: 'Community' },
];

const RARITY_LABELS: Record<string, string> = {
  mythic: 'MYTHIC',
  legendary: 'LEGENDARY',
  epic: 'EPIC',
  rare: 'RARE',
  standard: 'STANDARD',
};

function formatCountdown(targetIso: string): { launched: boolean; label: string } {
  const diffMs = Date.parse(targetIso) - Date.now();
  if (Number.isNaN(diffMs) || diffMs <= 0) {
    return { launched: true, label: 'Early-member launch clock LIVE now' };
  }
  const totalSec = Math.floor(diffMs / 1000);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return {
    launched: false,
    label: `Launch awards open in ${hrs}h ${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`,
  };
}

export function AwardsShelf({ user, isMe }: { user: User; isMe: boolean }) {
  const toast = useToast();
  const { me } = useApp();
  const [catalog, setCatalog] = useState<BadgeDefinition[]>([]);
  const [config, setConfig] = useState<RecognitionLaunchConfig | null>(null);
  const [serverAwards, setServerAwards] = useState<UserAward[] | null>(null);
  const [featuredIds, setFeaturedIds] = useState<string[]>(user.featuredBadgeIds ?? []);
  const [selectedAward, setSelectedAward] = useState<UserAward | null>(null);
  const [selectedCatalogDef, setSelectedCatalogDef] = useState<BadgeDefinition | null>(null);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [catFilter, setCatFilter] = useState<'all' | BadgeCategory>('all');
  const [savingPin, setSavingPin] = useState(false);
  const [, setTick] = useState(0);

  const loadRecognition = useCallback(async () => {
    if (!user.id || user.handle === 'guest' || user.handle === 'you') return;
    const bundle = await fetchUserRecognition(user.id).catch(() => null);
    if (!bundle) return;
    setCatalog(bundle.catalog);
    setConfig(bundle.config);
    setServerAwards(bundle.awards);
    setFeaturedIds(bundle.featuredBadgeIds);
  }, [user.id, user.handle]);

  useEffect(() => {
    void loadRecognition();
  }, [loadRecognition]);

  useEffect(() => {
    if (!config || Date.parse(config.launchStartsAt) <= Date.now()) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [config]);

  const awards = useMemo(
    () => serverAwards ?? user.awards ?? [],
    [serverAwards, user.awards],
  );

  const earnedByBadgeId = useMemo(() => {
    const map = new Map<string, UserAward>();
    for (const a of awards) map.set(a.badgeId, a);
    return map;
  }, [awards]);

  const showcaseAwards = useMemo(() => {
    if (!awards.length) return [];
    const pinned = featuredIds
      .map((id) => earnedByBadgeId.get(id))
      .filter((a): a is UserAward => Boolean(a));
    if (pinned.length >= 4) return pinned.slice(0, 4);
    const seen = new Set(pinned.map((p) => p.badgeId));
    const rest = awards.filter((a) => !seen.has(a.badgeId));
    return [...pinned, ...rest].slice(0, 4);
  }, [awards, featuredIds, earnedByBadgeId]);

  const togglePin = async (badgeId: string) => {
    if (!isMe || savingPin) return;
    setSavingPin(true);
    try {
      const currentlyPinned = featuredIds.includes(badgeId);
      const next = currentlyPinned
        ? featuredIds.filter((id) => id !== badgeId)
        : [badgeId, ...featuredIds.filter((id) => id !== badgeId)].slice(0, 4);
      const saved = await setFeaturedBadgesOnServer(next);
      setFeaturedIds(saved);
      const snap = getState();
      const updatedMe: User = { ...snap.profile, featuredBadgeIds: saved };
      adoptLocal({
        type: 'hydrate',
        state: {
          profile: updatedMe,
          users: { ...snap.users, [me.id]: updatedMe },
        },
      });
      haptic.success();
      toast.show({
        message: currentlyPinned ? 'Removed from profile showcase' : 'Pinned to profile showcase',
        tone: 'success',
      });
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Unable to update pinned badges',
        tone: 'danger',
      });
    } finally {
      setSavingPin(false);
    }
  };

  if (!awards.length && !isMe && catalog.length === 0) {
    return null;
  }

  const countdown = config ? formatCountdown(config.launchStartsAt) : null;
  const filteredCatalog = catalog.filter(
    (b) => (catFilter === 'all' ? b.category !== 'executive' || earnedByBadgeId.has(b.id) : b.category === catFilter),
  );

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text variant="overline" tone="accent">
            RECOGNITION & ACHIEVEMENTS
          </Text>
          {awards.length > 0 ? (
            <View style={styles.countPill}>
              <Text variant="caption" style={{ fontSize: 11, fontWeight: '700', color: colors.textPrimary }}>
                {awards.length}
              </Text>
            </View>
          ) : null}
        </View>
        <Pressable
          onPress={() => {
            haptic.light();
            setVaultOpen(true);
          }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Open achievements catalog"
        >
          <Text variant="caption" tone="accent">
            {awards.length > 0 ? `View all (${awards.length}) →` : 'Badge catalog →'}
          </Text>
        </Pressable>
      </View>

      {countdown && !countdown.launched && isMe ? (
        <Pressable onPress={() => setVaultOpen(true)} style={styles.launchBanner}>
          <Ionicons name="time-outline" size={15} color="#F59E0B" />
          <Text variant="caption" style={{ color: '#FDE68A', fontWeight: '600', flex: 1 }}>
            {countdown.label}
          </Text>
        </Pressable>
      ) : null}

      {showcaseAwards.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.cardsScroll}
        >
          {showcaseAwards.map((award) => {
            const isPinned = featuredIds.includes(award.badgeId);
            return (
              <Pressable
                key={award.awardId || award.badgeId}
                onPress={() => {
                  haptic.light();
                  setSelectedCatalogDef(null);
                  setSelectedAward(award);
                }}
                style={[
                  styles.badgeCard,
                  { borderColor: `${award.accentHex}48` },
                ]}
                accessibilityRole="button"
                accessibilityLabel={`${award.name}${award.serialNumber != null ? ` #${award.serialNumber}` : ''}`}
              >
                {isPinned && isMe ? (
                  <View style={styles.pinDot}>
                    <Ionicons name="pin" size={10} color={colors.textSecondary} />
                  </View>
                ) : null}
                <BadgeCrest
                  iconKey={award.iconKey}
                  accentHex={award.accentHex}
                  rarity={award.rarity}
                  serialNumber={award.serialNumber}
                  size={48}
                />
                <Text variant="label" numberOfLines={1} align="center" style={{ marginTop: 4 }}>
                  {award.name}
                </Text>
                <Text variant="caption" tone="tertiary" numberOfLines={1} align="center" style={{ fontSize: 10 }}>
                  {award.serialNumber != null ? `Slot #${award.serialNumber}` : award.subtitle}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : (
        <Pressable onPress={() => setVaultOpen(true)} style={styles.emptyCard}>
          <BadgeCrest iconKey="spark_quill" accentHex="#F59E0B" rarity="rare" size={38} locked />
          <View style={{ flex: 1 }}>
            <Text variant="titleSmall">
              {isMe ? 'Unlock your first Hallyu crest' : 'No crests unlocked yet'}
            </Text>
            <Text variant="caption" tone="secondary">
              {isMe
                ? 'Explore Early-Member, Participation, Content & Community milestones.'
                : 'Tap to inspect Hallyu community badges and rarity tiers.'}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
        </Pressable>
      )}

      {/* Individual Badge Inspector Modal */}
      <Modal
        visible={Boolean(selectedAward || selectedCatalogDef)}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setSelectedAward(null);
          setSelectedCatalogDef(null);
        }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            setSelectedAward(null);
            setSelectedCatalogDef(null);
          }}
        >
          <Pressable style={styles.inspectorCard} onPress={(e) => e.stopPropagation()}>
            {selectedAward ? (
              <View style={{ alignItems: 'center', gap: space.x3 }}>
                <BadgeCrest
                  iconKey={selectedAward.iconKey}
                  accentHex={selectedAward.accentHex}
                  rarity={selectedAward.rarity}
                  serialNumber={selectedAward.serialNumber}
                  size={76}
                />
                <View style={styles.rarityPill}>
                  <Text
                    variant="overline"
                    style={{ color: selectedAward.accentHex, letterSpacing: 1 }}
                  >
                    {RARITY_LABELS[selectedAward.rarity] ?? 'RARE'} ·{' '}
                    {selectedAward.category.replace('_', ' ').toUpperCase()}
                  </Text>
                </View>
                <Text variant="headline" align="center">
                  {selectedAward.name}
                  {selectedAward.serialNumber != null ? ` #${selectedAward.serialNumber}` : ''}
                </Text>
                {selectedAward.subtitle ? (
                  <Text variant="caption" tone="accent" align="center">
                    {selectedAward.subtitle}
                  </Text>
                ) : null}
                <Text variant="bodySmall" tone="secondary" align="center">
                  {selectedAward.description}
                </Text>
                <View style={styles.metaBox}>
                  <Text variant="caption" tone="secondary">
                    Awarded {new Date(selectedAward.awardedAt).toLocaleDateString()}
                    {selectedAward.maxSupply ? ` · Limited Edition (${selectedAward.maxSupply} max)` : ''}
                  </Text>
                  {selectedAward.awardNote ? (
                    <Text variant="caption" tone="tertiary">
                      {selectedAward.awardNote}
                    </Text>
                  ) : null}
                </View>
                <View style={{ flexDirection: 'row', gap: space.x2, width: '100%' }}>
                  {isMe ? (
                    <Button
                      label={featuredIds.includes(selectedAward.badgeId) ? 'Unpin' : 'Pin to Profile'}
                      variant="secondary"
                      size="sm"
                      icon={featuredIds.includes(selectedAward.badgeId) ? 'close-outline' : 'pin-outline'}
                      loading={savingPin}
                      onPress={() => void togglePin(selectedAward.badgeId)}
                      style={{ flex: 1 }}
                    />
                  ) : null}
                  <Button
                    label="Close"
                    size="sm"
                    onPress={() => setSelectedAward(null)}
                    style={{ flex: 1 }}
                  />
                </View>
              </View>
            ) : selectedCatalogDef ? (
              <View style={{ alignItems: 'center', gap: space.x3 }}>
                <BadgeCrest
                  iconKey={selectedCatalogDef.iconKey}
                  accentHex={selectedCatalogDef.accentHex}
                  rarity={selectedCatalogDef.rarity}
                  size={74}
                  locked={!earnedByBadgeId.has(selectedCatalogDef.id)}
                />
                <Text variant="overline" tone="secondary">
                  {RARITY_LABELS[selectedCatalogDef.rarity] ?? 'RARE'} ·{' '}
                  {selectedCatalogDef.category.replace('_', ' ').toUpperCase()}
                </Text>
                <Text variant="headline" align="center">
                  {selectedCatalogDef.name}
                </Text>
                <Text variant="bodySmall" tone="secondary" align="center">
                  {selectedCatalogDef.description}
                </Text>
                <View style={styles.metaBox}>
                  <Text variant="caption" tone="secondary">
                    {selectedCatalogDef.maxSupply
                      ? `Claimed globally: ${selectedCatalogDef.claimedCount ?? 0} / ${selectedCatalogDef.maxSupply}`
                      : `Unlocked by ${selectedCatalogDef.claimedCount ?? 0} member(s)`}
                  </Text>
                </View>
                <Button
                  label="Close"
                  variant="secondary"
                  size="sm"
                  onPress={() => setSelectedCatalogDef(null)}
                  block
                />
              </View>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Full Categorized Badges & Early-Member Vault Sheet */}
      <Sheet
        visible={vaultOpen}
        onClose={() => setVaultOpen(false)}
        title={`${isMe ? 'Your' : `${user.displayName}'s`} Recognition Vault`}
      >
        <View style={{ gap: space.x3, paddingBottom: space.x4 }}>
          {countdown ? (
            <View style={styles.launchBanner}>
              <Ionicons
                name={countdown.launched ? 'flash' : 'time-outline'}
                size={15}
                color="#F59E0B"
              />
              <Text variant="caption" style={{ color: '#FDE68A', flex: 1 }}>
                {countdown.label} · Founding Ten Cap: {config?.foundingTenCap ?? 10} · Founding Member Cap:{' '}
                {config?.foundingMemberCap ?? 250}
              </Text>
            </View>
          ) : null}

          <ChipRow>
            {CATEGORY_TABS.map((t) => (
              <Chip
                key={t.key}
                label={t.label}
                size="sm"
                selected={catFilter === t.key}
                onPress={() => setCatFilter(t.key)}
              />
            ))}
          </ChipRow>

          <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: space.x2 }}>
            {filteredCatalog.map((def) => {
              const earned = earnedByBadgeId.get(def.id);
              return (
                <Pressable
                  key={def.id}
                  onPress={() => {
                    setVaultOpen(false);
                    if (earned) {
                      setSelectedCatalogDef(null);
                      setSelectedAward(earned);
                    } else {
                      setSelectedAward(null);
                      setSelectedCatalogDef(def);
                    }
                  }}
                  style={[
                    styles.catalogRow,
                    earned ? { borderColor: `${def.accentHex}66`, backgroundColor: colors.surface2 } : null,
                  ]}
                >
                  <BadgeCrest
                    iconKey={def.iconKey}
                    accentHex={def.accentHex}
                    rarity={def.rarity}
                    serialNumber={earned?.serialNumber}
                    size={46}
                    locked={!earned}
                  />
                  <View style={{ flex: 1, gap: 2 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text variant="titleSmall" numberOfLines={1}>
                        {def.name}
                        {earned?.serialNumber != null ? ` #${earned.serialNumber}` : ''}
                      </Text>
                      {earned ? (
                        <Ionicons name="checkmark-circle" size={14} color={colors.success} />
                      ) : null}
                    </View>
                    <Text variant="caption" tone="secondary" numberOfLines={2}>
                      {def.description}
                    </Text>
                    <Text variant="caption" tone="tertiary" style={{ fontSize: 11 }}>
                      {RARITY_LABELS[def.rarity]} ·{' '}
                      {def.maxSupply
                        ? `${def.claimedCount ?? 0}/${def.maxSupply} claimed`
                        : `${def.claimedCount ?? 0} earned`}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: space.x4,
    gap: space.x2,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.margin,
  },
  countPill: {
    backgroundColor: colors.surface2,
    borderRadius: radius.full,
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  launchBanner: {
    marginHorizontal: space.margin,
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    borderColor: 'rgba(245, 158, 11, 0.35)',
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.x3,
    paddingVertical: space.x2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cardsScroll: {
    paddingHorizontal: space.margin,
    gap: space.x2,
  },
  badgeCard: {
    width: 112,
    backgroundColor: colors.surface1,
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingVertical: space.x3,
    paddingHorizontal: space.x2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinDot: {
    position: 'absolute',
    top: 7,
    right: 7,
  },
  emptyCard: {
    marginHorizontal: space.margin,
    padding: space.x3,
    backgroundColor: colors.surface1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.margin,
  },
  inspectorCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.surface2,
    borderRadius: radius.xl,
    padding: space.x5,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  rarityPill: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radius.full,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  metaBox: {
    width: '100%',
    backgroundColor: colors.surface1,
    borderRadius: radius.md,
    padding: space.x3,
    gap: 4,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    alignItems: 'center',
  },
  catalogRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    padding: space.x3,
    borderRadius: radius.lg,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
});
