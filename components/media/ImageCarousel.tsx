import { Image } from 'expo-image';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, NativeScrollEvent, NativeSyntheticEvent, Pressable, StyleSheet, View } from 'react-native';
import { colors, radius, space } from '../../constants/theme';
import { normalizeMediaUrl } from '../../lib/api/client';
import { refreshSignedUrl } from '../../lib/api/media';
import { Text } from '../ui/Text';

type Img = string | number;

interface Props {
  images: Img[];
  imagePaths?: string[];
  width: number;
  /** Height of the frame; defaults to 4:5 for multi-image and 5:4-ish for a single image. */
  height?: number;
  onPressImage?: (index: number) => void;
  initialIndex?: number;
  rounded?: number;
}

function SlideImage({
  source,
  storagePath,
  width,
  height,
}: {
  source: Img;
  storagePath?: string;
  width: number;
  height: number;
}) {
  const isRawStoragePath = typeof source === 'string' && /^(u|avatars|catalog)\//.test(source);
  const initialUri =
    typeof source === 'string' && !isRawStoragePath ? normalizeMediaUrl(source) : undefined;
  const [liveUri, setLiveUri] = useState<string | undefined>(initialUri);
  const [retried, setRetried] = useState(false);
  const [failed, setFailed] = useState(false);

  const attemptRefresh = useCallback(
    (force = false) => {
      const target = storagePath ?? (typeof source === 'string' ? source : null);
      if (!target) {
        setFailed(true);
        return;
      }
      void refreshSignedUrl(target, force).then((fresh) => {
        if (fresh) {
          setLiveUri(fresh);
          setFailed(false);
        } else {
          setFailed(true);
        }
      });
    },
    [storagePath, source],
  );

  useEffect(() => {
    setLiveUri(initialUri);
    setRetried(false);
    setFailed(false);
    if (!initialUri && (isRawStoragePath || storagePath)) {
      setRetried(true);
      attemptRefresh(false);
    }
  }, [initialUri, isRawStoragePath, storagePath, attemptRefresh]);

  if (typeof source !== 'string') {
    return (
      <Image
        source={source}
        style={{ width, height, backgroundColor: colors.surface2 }}
        contentFit="cover"
        transition={200}
      />
    );
  }

  if (failed || !liveUri) {
    return (
      <Pressable
        onPress={() => {
          setFailed(false);
          attemptRefresh(true);
        }}
        accessibilityRole="button"
        accessibilityLabel="Image couldn't load — tap to retry"
        style={{
          width,
          height,
          backgroundColor: colors.surface2,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: space.x4,
        }}
      >
        <Text variant="caption" tone="secondary" align="center">
          {failed ? 'Image couldn’t load · Tap to retry' : 'Loading media…'}
        </Text>
      </Pressable>
    );
  }

  return (
    <Image
      source={{ uri: liveUri }}
      style={{ width, height, backgroundColor: colors.surface2 }}
      contentFit="cover"
      transition={200}
      cachePolicy="memory-disk"
      recyclingKey={liveUri}
      onError={() => {
        if (retried) {
          setFailed(true);
          return;
        }
        setRetried(true);
        attemptRefresh(false);
      }}
    />
  );
}

/**
 * Swipeable photo slides for posts: one image at a time, snap paging, a "2 / 4" counter and dots.
 * A single image is just the image. Tapping opens the full-screen viewer at that slide.
 */
export function ImageCarousel({
  images,
  imagePaths,
  width,
  height,
  onPressImage,
  initialIndex = 0,
  rounded = radius.md,
}: Props) {
  const multi = images.length > 1;
  const h = height ?? Math.round(width * (multi ? 1.05 : 0.8));
  const [index, setIndex] = useState(initialIndex);
  const listRef = useRef<FlatList<Img>>(null);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const i = Math.round(e.nativeEvent.contentOffset.x / width);
      if (i !== index && i >= 0 && i < images.length) setIndex(i);
    },
    [width, index, images.length],
  );

  const renderItem = useCallback(
    ({ item, index: i }: { item: Img; index: number }) => (
      <Pressable
        onPress={() => onPressImage?.(i)}
        accessibilityRole="imagebutton"
        accessibilityLabel={`Image ${i + 1} of ${images.length}`}
        style={{ width, height: h }}
      >
        <SlideImage source={item} storagePath={imagePaths?.[i]} width={width} height={h} />
      </Pressable>
    ),
    [width, h, images.length, imagePaths, onPressImage],
  );

  if (!multi) {
    return <View style={[styles.frame, { width, height: h, borderRadius: rounded }]}>{renderItem({ item: images[0]!, index: 0 })}</View>;
  }

  return (
    <View style={[styles.frame, { width, height: h, borderRadius: rounded }]}>
      <FlatList
        ref={listRef}
        data={images}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(_, i) => String(i)}
        renderItem={renderItem}
        onScroll={onScroll}
        scrollEventThrottle={32}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        initialScrollIndex={initialIndex}
        nestedScrollEnabled
        decelerationRate="fast"
        accessibilityRole="adjustable"
        accessibilityLabel={`${images.length} images, swipe to browse`}
      />
      <View style={styles.counter} pointerEvents="none">
        <Text variant="caption" tone="onMedia" numeric>
          {index + 1} / {images.length}
        </Text>
      </View>
      <View style={styles.dots} pointerEvents="none">
        {images.map((_, i) => (
          <View key={i} style={[styles.dot, i === index && styles.dotOn]} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden', backgroundColor: colors.surface2, marginTop: space.x1 },
  counter: {
    position: 'absolute',
    top: space.x2,
    right: space.x2,
    paddingHorizontal: 8,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(10,10,10,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dots: { position: 'absolute', bottom: space.x2, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 5 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.45)' },
  dotOn: { backgroundColor: colors.onMedia, width: 14 },
});
