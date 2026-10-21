import { Image } from 'expo-image';
import React, { useEffect, useState } from 'react';
import { StyleProp, View, ViewStyle } from 'react-native';
import { colors, fonts, sizes } from '../../constants/theme';
import { normalizeMediaUrl } from '../../lib/api/client';
import { refreshSignedUrl } from '../../lib/api/media';
import { initials } from '../../lib/format';
import { Text } from './Text';

interface AvatarProps {
  uri?: string;
  avatarPath?: string;
  name: string;
  size?: keyof typeof sizes.avatar | number;
  ring?: boolean; // accent ring (e.g. live / story)
  style?: StyleProp<ViewStyle>;
}

const HUES = ['#3B2F4A', '#2F3A2A', '#3A2A2A', '#2A3A3A', '#3F352A', '#2A3340', '#4A2F3A'];

export function Avatar({ uri, avatarPath, name, size = 'md', ring, style }: AvatarProps) {
  const px = typeof size === 'number' ? size : sizes.avatar[size];
  const resolvedInput = normalizeMediaUrl(uri);
  const [liveUri, setLiveUri] = useState<string | undefined>(resolvedInput);
  const [retried, setRetried] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setLiveUri(resolvedInput);
    setRetried(false);
    setFailed(false);
  }, [resolvedInput, avatarPath]);

  const handleError = () => {
    if (!retried) {
      setRetried(true);
      void refreshSignedUrl(avatarPath ?? resolvedInput).then((fresh) => {
        if (fresh) {
          setLiveUri(fresh);
          setFailed(false);
        } else {
          setFailed(true);
        }
      });
      return;
    }
    setFailed(true);
  };

  const bg = HUES[name.length % HUES.length];
  const fontSize = Math.max(10, Math.round(px * 0.38));
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={`${name} avatar`}
      style={[
        { width: px, height: px, borderRadius: px / 2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
        ring ? { borderWidth: 2, borderColor: colors.accent } : null,
        style,
      ]}
    >
      {liveUri && !failed ? (
        <Image
          source={{ uri: liveUri }}
          style={{ width: px, height: px }}
          contentFit="cover"
          transition={160}
          onError={handleError}
          cachePolicy="memory-disk"
          recyclingKey={liveUri}
        />
      ) : (
        <Text style={{ fontFamily: fonts.semibold, fontSize, lineHeight: fontSize + 4, color: colors.textPrimary }}>{initials(name)}</Text>
      )}
    </View>
  );
}
