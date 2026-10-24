import React, { useMemo, useState } from 'react';
import { LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop, Text as SvgText, G, Ellipse } from 'react-native-svg';
import { haptic } from '../../lib/hooks';
import { colors, radius, space } from '../../constants/theme';

/**
 * 2.5D book shelf drawn with react-native-svg: a recessed back panel, spines with a light edge and
 * a shaded edge for depth, and a wooden plank with a contact shadow. Flat illustration, not 3D.
 * Taps are handled by transparent hit areas placed over each spine.
 */
import type { ShelfSpine } from '../../lib/shelfLayout';
import { packSpines } from '../../lib/shelfLayout';

export type { ShelfSpine };

interface Props {
  spines: ShelfSpine[];
  onPress: (id: string) => void;
  minRowHeight?: number;
}

const SPINE_HEIGHT = 140;
const SPINE_GAP = 2;
const PLANK = 12;
const GAP = SPINE_GAP;

export function BookShelfSvg({ spines, onPress, minRowHeight = SPINE_HEIGHT + PLANK + 16 }: Props) {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.floor(e.nativeEvent.layout.width));
  const padX = space.x2;
  const lines = useMemo(() => (width > 0 ? packSpines(spines, width - padX * 2) : []), [spines, width, padX]);

  return (
    <View onLayout={onLayout} style={{ minHeight: minRowHeight }}>
      {width > 0
        ? lines.map((line, li) => {
            const height = SPINE_HEIGHT + PLANK + 8;
            let x = padX;
            return (
              <View key={li} style={{ width, height, marginBottom: space.x2 }}>
                <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
                  <Defs>
                    <LinearGradient id={`wood${li}`} x1="0" y1="0" x2="0" y2="1">
                      <Stop offset="0" stopColor="#8B5E3C" />
                      <Stop offset="1" stopColor="#5C3B22" />
                    </LinearGradient>
                    <LinearGradient id={`back${li}`} x1="0" y1="0" x2="0" y2="1">
                      <Stop offset="0" stopColor="#1A1410" />
                      <Stop offset="1" stopColor="#0E0A07" />
                    </LinearGradient>
                  </Defs>
                  {/* recessed back panel */}
                  <Rect x={0} y={0} width={width} height={SPINE_HEIGHT + 4} fill={`url(#back${li})`} />
                  {line.map((s, i) => {
                    const sx = padX + line.slice(0, i).reduce((sum, p) => sum + p.width + GAP, 0);
                    const selected = s.selected;
                    return (
                      <G key={s.id}>
                        <Rect x={sx} y={8} width={s.width} height={SPINE_HEIGHT} rx={3} fill={s.color} />
                        {/* light edge on the left, shade on the right: the 2.5D depth cue */}
                        <Rect x={sx} y={8} width={Math.max(1, s.width * 0.12)} height={SPINE_HEIGHT} fill="#FFFFFF" fillOpacity={0.18} />
                        <Rect x={sx + s.width - Math.max(1, s.width * 0.14)} y={8} width={Math.max(1, s.width * 0.14)} height={SPINE_HEIGHT} fill="#000000" fillOpacity={0.28} />
                        {selected ? <Rect x={sx} y={8} width={s.width} height={SPINE_HEIGHT} rx={3} fill="none" stroke={colors.textPrimary} strokeWidth={2} /> : null}
                        <SvgText
                          x={sx + s.width / 2}
                          y={8 + SPINE_HEIGHT / 2}
                          fill="#FFFFFF"
                          fontSize={11}
                          textAnchor="middle"
                          transform={`rotate(-90 ${sx + s.width / 2} ${8 + SPINE_HEIGHT / 2})`}
                        >
                          {s.title.length > 22 ? `${s.title.slice(0, 21)}…` : s.title}
                        </SvgText>
                      </G>
                    );
                  })}
                  {/* plank with a contact shadow */}
                  <Ellipse cx={width / 2} cy={SPINE_HEIGHT + 8 + PLANK + 2} rx={width / 2 - 6} ry={3} fill="#000000" fillOpacity={0.35} />
                  <Rect x={0} y={SPINE_HEIGHT + 8} width={width} height={PLANK} rx={2} fill={`url(#wood${li})`} />
                  <Rect x={0} y={SPINE_HEIGHT + 8} width={width} height={2} fill="#FFFFFF" fillOpacity={0.12} />
                </Svg>
                {/* transparent hit areas over each spine */}
                {line.map((s) => {
                  const left = x;
                  x += s.width + GAP;
                  return (
                    <Pressable
                      key={`hit-${s.id}`}
                      onPress={() => {
                        haptic.light();
                        onPress(s.id);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={s.title}
                      style={{ position: 'absolute', left, top: 8, width: s.width, height: SPINE_HEIGHT, borderRadius: radius.sm }}
                    />
                  );
                })}
              </View>
            );
          })
        : null}
    </View>
  );
}
