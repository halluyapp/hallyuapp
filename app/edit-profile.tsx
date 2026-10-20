import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { DramaPickerSheet } from '../components/create/pickers';
import { Avatar } from '../components/ui/Avatar';
import { Button } from '../components/ui/Button';
import { Chip, ChipRow } from '../components/ui/Chip';
import { Poster } from '../components/ui/Poster';
import { ScrollScreen, Screen } from '../components/ui/Screen';
import { Text } from '../components/ui/Text';
import { TextField } from '../components/ui/TextField';
import { useToast } from '../components/ui/Toast';
import { TopBar } from '../components/ui/TopBar';
import { colors, radius, sizes, space } from '../constants/theme';
import { supabase } from '../lib/api/client';
import { hasSession } from '../lib/api/social';
import { FANDOMS } from '../lib/fandoms';
import { haptic, useApp } from '../lib/hooks';
import { FandomId } from '../lib/model';
import { GENRES, LIMITS } from '../lib/model';

/** Edit profile — name, handle, bio, avatar, favourite genres, four favourite dramas, private toggle. */
export default function EditProfile() {
  const router = useRouter();
  const toast = useToast();
  const { me, dispatch, getDrama } = useApp();
  const [displayName, setDisplayName] = useState(me.displayName);
  const [handle, setHandle] = useState(me.handle);
  const [bio, setBio] = useState(me.bio ?? '');
  const [avatarUrl, setAvatarUrl] = useState(me.avatarUrl);
  const [bannerUrl, setBannerUrl] = useState(me.bannerUrl);
  const [bannerPicker, setBannerPicker] = useState(false);
  const [fandoms, setFandoms] = useState<FandomId[]>(me.fandoms ?? []);
  const [genres, setGenres] = useState<string[]>(me.favoriteGenres);
  const [favorites, setFavorites] = useState<string[]>(me.favoriteDramaIds.slice(0, 4));
  const [isPrivate, setPrivate] = useState(!!me.isPrivate);
  const [picker, setPicker] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleClean = handle.trim().toLowerCase().replace(/^@/, '');
  const handleError = handleClean.length < 3 ? 'At least 3 characters.' : handleClean.length > 20 ? 'Keep it under 20 characters.' : !/^[a-z0-9_]+$/.test(handleClean) ? 'Lowercase letters, numbers and underscores only.' : null;
  const nameError = displayName.trim().length < 2 ? 'Add a display name.' : null;
  const valid = !handleError && !nameError && !saving;

  const pickAvatar = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return toast.show({ message: 'Allow photo access to change your picture.', tone: 'danger' });
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [1, 1], quality: 0.8 });
    if (!res.canceled) setAvatarUrl(res.assets[0]!.uri);
  };

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      if (handleClean !== me.handle.toLowerCase() && supabase && hasSession()) {
        const { data: available, error } = await supabase.rpc('handle_is_available', { p_handle: handleClean });
        if (!error && available === false) {
          toast.show({ message: `@${handleClean} is already taken.`, tone: 'danger' });
          setSaving(false);
          return;
        }
      }
      dispatch({ type: 'profile', patch: { displayName: displayName.trim(), handle: handleClean, bio: bio.trim() || undefined, avatarUrl, bannerUrl, fandoms, favoriteGenres: genres, favoriteDramaIds: favorites, isPrivate } });
      dispatch({ type: 'onboarding', patch: { fandoms } });
      haptic.success();
      toast.show({ message: 'Profile updated', icon: 'checkmark-circle', tone: 'success' });
      router.back();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen header={<TopBar mode="modal" title="Edit profile" right={<Button label="Save" size="sm" onPress={save} disabled={!valid} />} />}>
      <ScrollScreen keyboard column padded>
        <Pressable
          onPress={() => setBannerPicker(true)}
          style={{
            height: 108,
            borderRadius: radius.md,
            backgroundColor: colors.surface2,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.borderStrong,
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: space.x3,
            overflow: 'hidden',
          }}
          accessibilityRole="button"
          accessibilityLabel="Choose profile cover backdrop drama"
        >
          <Ionicons name="sparkles-outline" size={20} color={colors.accent} />
          <Text variant="label" tone="accent" style={{ marginTop: 4 }}>
            {bannerUrl ? 'Change drama cover backdrop' : 'Pick a drama cover backdrop'}
          </Text>
          <Text variant="caption" tone="tertiary">
            Lights up the top of your profile
          </Text>
        </Pressable>
        <Pressable onPress={pickAvatar} style={styles.avatarWrap} accessibilityRole="button" accessibilityLabel="Change profile picture">
          <Avatar uri={avatarUrl} name={displayName || me.displayName} size="xl" />
          <View style={styles.camera}>
            <Ionicons name="camera" size={14} color={colors.onAccent} />
          </View>
          <Text variant="label" tone="accent" style={{ marginTop: space.x2 }}>
            Change photo
          </Text>
        </Pressable>
        <View style={{ gap: space.x4 }}>
          <TextField label="Display name" value={displayName} onChangeText={(t) => setDisplayName(t.slice(0, LIMITS.displayName))} counter={LIMITS.displayName} error={nameError} autoCapitalize="words" />
          <TextField label="Handle" value={handle} onChangeText={(t) => setHandle(t.replace(/\s/g, ''))} leading="at-outline" autoCapitalize="none" autoCorrect={false} error={handleError} hint="hallyu.app/u/your-handle" />
          <TextField label="Bio" value={bio} onChangeText={(t) => setBio(t.slice(0, LIMITS.bio))} counter={LIMITS.bio} multiline multilineHeight={88} placeholder="What you watch, what you love, who you cry over." />
          <View>
            <Text variant="label" style={{ marginBottom: space.x2 }}>
              Your worlds
            </Text>
            <ChipRow>
              {FANDOMS.map((f) => (
                <Chip
                  key={f.id}
                  label={`${f.flag} ${f.label}`}
                  size="sm"
                  selected={fandoms.includes(f.id)}
                  onPress={() => setFandoms((p) => (p.includes(f.id) ? p.filter((x) => x !== f.id) : [...p, f.id]))}
                />
              ))}
            </ChipRow>
          </View>
          <View>
            <Text variant="label" style={{ marginBottom: space.x2 }}>
              Favourite genres
            </Text>
            <ChipRow>
              {GENRES.map((g) => (
                <Chip key={g} label={g} size="sm" selected={genres.includes(g)} onPress={() => setGenres((p) => (p.includes(g) ? p.filter((x) => x !== g) : [...p, g]))} />
              ))}
            </ChipRow>
          </View>
          <View>
            <Text variant="label" style={{ marginBottom: space.x2 }}>
              Favourite dramas · {favorites.length}/4
            </Text>
            <View style={{ flexDirection: 'row', gap: space.gutter }}>
              {favorites.map((id) => {
                const d = getDrama(id);
                return d ? (
                  <Pressable key={id} onPress={() => setFavorites((p) => p.filter((x) => x !== id))} accessibilityRole="button" accessibilityLabel={`Remove ${d.title} from favourites`}>
                    <Poster drama={d} width={sizes.poster.s} />
                    <View style={styles.remove}>
                      <Ionicons name="close" size={12} color={colors.onMedia} />
                    </View>
                  </Pressable>
                ) : null;
              })}
              {favorites.length < 4 ? (
                <Pressable onPress={() => setPicker(true)} style={styles.slot} accessibilityRole="button" accessibilityLabel="Add a favourite drama">
                  <Ionicons name="add" size={22} color={colors.textTertiary} />
                </Pressable>
              ) : null}
            </View>
          </View>
          <Pressable onPress={() => setPrivate((p) => !p)} style={styles.privacy} accessibilityRole="switch" accessibilityState={{ checked: isPrivate }}>
            <Ionicons name={isPrivate ? 'lock-closed' : 'globe-outline'} size={20} color={colors.textSecondary} />
            <View style={{ flex: 1 }}>
              <Text variant="body">{isPrivate ? 'Private profile' : 'Public profile'}</Text>
              <Text variant="caption" tone="secondary">
                {isPrivate ? 'Only approved followers see your posts and shelves.' : 'Anyone can see your posts, shelves and watchlist.'}
              </Text>
            </View>
            <Ionicons name={isPrivate ? 'toggle' : 'toggle-outline'} size={32} color={isPrivate ? colors.accent : colors.textTertiary} />
          </Pressable>
        </View>
      </ScrollScreen>
      <DramaPickerSheet visible={picker} onClose={() => setPicker(false)} title="Add a favourite" onPick={(d) => setFavorites((p) => (p.includes(d.id) || p.length >= 4 ? p : [...p, d.id]))} />
      <DramaPickerSheet
        visible={bannerPicker}
        onClose={() => setBannerPicker(false)}
        title="Choose profile cover backdrop"
        onPick={(d) => {
          setBannerUrl(d.backdropUrl ?? d.posterUrl);
          setBannerPicker(false);
          toast.show({ message: `Cover set to ${d.title}`, icon: 'image-outline', tone: 'success' });
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatarWrap: { alignItems: 'center', marginVertical: space.x5 },
  camera: { position: 'absolute', top: 62, right: '50%', marginRight: -44, width: 26, height: 26, borderRadius: 13, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.canvas },
  slot: { width: sizes.poster.s, aspectRatio: 2 / 3, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.borderSubtle, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' },
  remove: { position: 'absolute', top: 4, right: 4, width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(10,10,10,0.75)', alignItems: 'center', justifyContent: 'center' },
  privacy: { flexDirection: 'row', alignItems: 'center', gap: space.x3, padding: space.x4, borderRadius: radius.md, backgroundColor: colors.surface1 },
});
