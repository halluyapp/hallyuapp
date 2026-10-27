import React, { useId } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  Polygon,
  Rect,
  Stop,
} from 'react-native-svg';
import type { BadgeRarity } from '../../lib/model';
import { Text } from '../ui/Text';

export interface BadgeCrestProps {
  iconKey: string;
  accentHex?: string;
  rarity?: BadgeRarity;
  serialNumber?: number | null;
  size?: number;
  locked?: boolean;
}

function renderInnerEmblem(iconKey: string, strokeColor: string) {
  switch (iconKey) {
    case 'founder_seal':
      // Architectural 'H' monolith crowned by a sovereign diamond star
      return (
        <G>
          <Polygon
            points="32,14 34.4,18.2 38.8,19 35.4,22 36.2,26.4 32,24.2 27.8,26.4 28.6,22 25.2,19 29.6,18.2"
            fill={strokeColor}
          />
          <Path
            d="M 22 29 L 22 47 M 42 29 L 42 47 M 22 38 L 42 38 M 19 29 L 25 29 M 39 29 L 45 29 M 19 47 L 25 47 M 39 47 L 45 47"
            stroke={strokeColor}
            strokeWidth="2.8"
            strokeLinecap="round"
          />
        </G>
      );

    case 'first_arrival':
    case 'crown_star':
      // First Arrival (#1): Three-peak sovereign crown + radiant apex star
      return (
        <G>
          <Polygon
            points="32,14 33.9,18 38.2,18.5 35,21.5 35.8,25.8 32,23.7 28.2,25.8 29,21.5 25.8,18.5 30.1,18"
            fill={strokeColor}
          />
          <Path
            d="M 18 44 L 20.5 29 L 27.5 35.5 L 32 27.5 L 36.5 35.5 L 43.5 29 L 46 44 Z"
            fill="none"
            stroke={strokeColor}
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          <Line x1="18" y1="48" x2="46" y2="48" stroke={strokeColor} strokeWidth="2.5" strokeLinecap="round" />
        </G>
      );

    case 'founding_ten':
    case 'laurel_shield':
      // Founding Ten (#1-#10): Heraldic crest flanked by twin laurel arcs + center star
      return (
        <G>
          <Path
            d="M 32 17 L 44 22 L 44 33 C 44 41 38.5 46.2 32 49 C 25.5 46.2 20 41 20 33 L 20 22 Z"
            fill="none"
            stroke={strokeColor}
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
          <Polygon
            points="32,24.5 34,29 38.8,29.5 35.2,32.8 36.2,37.5 32,35 27.8,37.5 28.8,32.8 25.2,29.5 30,29"
            fill={strokeColor}
          />
          <Path
            d="M 15.5 39 C 13.5 33 14.5 25.5 18.5 20.5"
            fill="none"
            stroke={strokeColor}
            strokeWidth="1.9"
            strokeLinecap="round"
          />
          <Path
            d="M 48.5 39 C 50.5 33 49.5 25.5 45.5 20.5"
            fill="none"
            stroke={strokeColor}
            strokeWidth="1.9"
            strokeLinecap="round"
          />
        </G>
      );

    case 'founding_member':
    case 'pillar_flame':
      // Founding Member: Classical fluted Ionic pillar + twin flame crown
      return (
        <G>
          <Path
            d="M 32 14 C 36.5 19 37.5 23.5 34.5 27 C 32.8 29 29.5 29 28.5 26 C 27 22.5 29.2 18 32 14 Z"
            fill={strokeColor}
          />
          <Rect x="22" y="30" width="20" height="3.5" rx="1.5" fill={strokeColor} />
          <Line x1="25.5" y1="34" x2="25.5" y2="45" stroke={strokeColor} strokeWidth="2.4" strokeLinecap="round" />
          <Line x1="32" y1="34" x2="32" y2="45" stroke={strokeColor} strokeWidth="2.4" strokeLinecap="round" />
          <Line x1="38.5" y1="34" x2="38.5" y2="45" stroke={strokeColor} strokeWidth="2.4" strokeLinecap="round" />
          <Rect x="20" y="45.5" width="24" height="3.8" rx="1.5" fill={strokeColor} />
        </G>
      );

    case 'day_one':
    case 'sunrise_horizon':
      // Day One: Rising dawn solar arc + 5 precision rays above horizon
      return (
        <G>
          <Path d="M 21 39 A 11 11 0 0 1 43 39" fill="none" stroke={strokeColor} strokeWidth="2.6" strokeLinecap="round" />
          <Line x1="16" y1="39.5" x2="48" y2="39.5" stroke={strokeColor} strokeWidth="2.5" strokeLinecap="round" />
          <Line x1="22" y1="45" x2="42" y2="45" stroke={strokeColor} strokeWidth="2" strokeLinecap="round" opacity="0.8" />
          <Line x1="32" y1="17" x2="32" y2="23" stroke={strokeColor} strokeWidth="2.4" strokeLinecap="round" />
          <Line x1="20" y1="22" x2="24" y2="26" stroke={strokeColor} strokeWidth="2.3" strokeLinecap="round" />
          <Line x1="44" y1="22" x2="40" y2="26" stroke={strokeColor} strokeWidth="2.3" strokeLinecap="round" />
        </G>
      );

    case 'premiere_night':
    case 'spark_quill':
      // Premiere Regular / Spark: Precision 4-point star + center gem
      return (
        <G>
          <Path
            d="M 32 15 L 35.8 28.2 L 49 32 L 35.8 35.8 L 32 49 L 28.2 35.8 L 15 32 L 28.2 28.2 Z"
            fill="none"
            stroke={strokeColor}
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
          <Circle cx="32" cy="32" r="3.4" fill={strokeColor} />
        </G>
      );

    case 'first_voice':
    case 'thread_weave':
      // First Voice: Dialogue frame crest
      return (
        <G>
          <Path
            d="M 19 23 C 19 19.7 21.7 17 25 17 L 39 17 C 42.3 17 45 19.7 45 23 L 45 33 C 45 36.3 42.3 39 39 39 L 29 39 L 21 45 L 22.5 39 C 20.4 38.1 19 35.8 19 33 Z"
            fill="none"
            stroke={strokeColor}
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
          <Line x1="25" y1="25.5" x2="39" y2="25.5" stroke={strokeColor} strokeWidth="2.3" strokeLinecap="round" />
          <Line x1="25" y1="31.5" x2="35" y2="31.5" stroke={strokeColor} strokeWidth="2.3" strokeLinecap="round" />
        </G>
      );

    case 'circle_member':
    case 'lantern_circle':
      // Fandom Circle: Traditional warm lantern geometry
      return (
        <G>
          <Line x1="26" y1="17" x2="38" y2="17" stroke={strokeColor} strokeWidth="2.4" strokeLinecap="round" />
          <Rect x="21" y="21" width="22" height="21" rx="8" fill="none" stroke={strokeColor} strokeWidth="2.5" />
          <Line x1="32" y1="21" x2="32" y2="42" stroke={strokeColor} strokeWidth="2" />
          <Line x1="22" y1="31.5" x2="42" y2="31.5" stroke={strokeColor} strokeWidth="1.9" />
          <Line x1="27" y1="46.5" x2="37" y2="46.5" stroke={strokeColor} strokeWidth="2.4" strokeLinecap="round" />
        </G>
      );

    case 'season_finisher':
    case 'quill_scroll':
      // Season Finisher: Fountain nib diamond crest
      return (
        <G>
          <Path
            d="M 44 17 L 47 20 L 35 43 L 21 45 L 23 31 Z"
            fill="none"
            stroke={strokeColor}
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
          <Line x1="21" y1="45" x2="31.5" y2="34.5" stroke={strokeColor} strokeWidth="2.2" strokeLinecap="round" />
          <Circle cx="33" cy="33" r="2.5" fill={strokeColor} />
        </G>
      );

    case 'scene_critic':
    case 'cinema_lens':
      // Scene Critic: Cinema lens aperture ring + 6 iris blades
      return (
        <G>
          <Circle cx="32" cy="32" r="14.5" fill="none" stroke={strokeColor} strokeWidth="2.5" />
          <Circle cx="32" cy="32" r="6" fill="none" stroke={strokeColor} strokeWidth="2.2" />
          <Line x1="32" y1="17.5" x2="37.2" y2="26.8" stroke={strokeColor} strokeWidth="1.9" />
          <Line x1="44.5" y1="24.8" x2="37.2" y2="35.2" stroke={strokeColor} strokeWidth="1.9" />
          <Line x1="44.5" y1="39.2" x2="32" y2="38" stroke={strokeColor} strokeWidth="1.9" />
          <Line x1="32" y1="46.5" x2="26.8" y2="37.2" stroke={strokeColor} strokeWidth="1.9" />
          <Line x1="19.5" y1="39.2" x2="26.8" y2="28.8" stroke={strokeColor} strokeWidth="1.9" />
          <Line x1="19.5" y1="24.8" x2="32" y2="26" stroke={strokeColor} strokeWidth="1.9" />
        </G>
      );

    case 'watchlist_curator':
    case 'curated_vault':
      // Watchlist Curator: Layered archival folio plates
      return (
        <G>
          <Polygon points="32,17 47,24.5 32,32 17,24.5" fill="none" stroke={strokeColor} strokeWidth="2.4" strokeLinejoin="round" />
          <Path d="M 17 31.5 L 32 39 L 47 31.5" fill="none" stroke={strokeColor} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          <Path d="M 17 38.5 L 32 46 L 47 38.5" fill="none" stroke={strokeColor} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </G>
      );

    case 'pulse_maker':
    case 'constellation_orbit':
      // Pulse Maker: Connected constellation triangle + orbital ring
      return (
        <G>
          <Circle cx="32" cy="32" r="13.5" fill="none" stroke={strokeColor} strokeWidth="1.7" strokeDasharray="4 3" />
          <Polygon points="32,18 44,39 20,39" fill="none" stroke={strokeColor} strokeWidth="2.1" strokeLinejoin="round" />
          <Circle cx="32" cy="18" r="3.2" fill={strokeColor} />
          <Circle cx="44" cy="39" r="3.2" fill={strokeColor} />
          <Circle cx="20" cy="39" r="3.2" fill={strokeColor} />
        </G>
      );

    case 'world_passport':
    case 'compass_worlds':
      // World Passport: 4-world cardinal rose (K-Drama, C-Drama, Anime, Hollywood)
      return (
        <G>
          <Circle cx="32" cy="32" r="14.5" fill="none" stroke={strokeColor} strokeWidth="2.1" />
          <Polygon
            points="32,15 35.5,28.5 49,32 35.5,35.5 32,49 28.5,35.5 15,32 28.5,28.5"
            fill="none"
            stroke={strokeColor}
            strokeWidth="2.1"
            strokeLinejoin="round"
          />
          <Circle cx="32" cy="32" r="3" fill={strokeColor} />
        </G>
      );

    case 'rising_voice':
    case 'beacon_tower':
      // Rising Voice: Signal tower + twin broadcast waves
      return (
        <G>
          <Circle cx="32" cy="24" r="3.4" fill={strokeColor} />
          <Path d="M 25 19.5 A 9 9 0 0 0 25 28.5" fill="none" stroke={strokeColor} strokeWidth="2.2" strokeLinecap="round" />
          <Path d="M 39 19.5 A 9 9 0 0 1 39 28.5" fill="none" stroke={strokeColor} strokeWidth="2.2" strokeLinecap="round" />
          <Path d="M 20.5 15.5 A 14.5 14.5 0 0 0 20.5 32.5" fill="none" stroke={strokeColor} strokeWidth="2" strokeLinecap="round" />
          <Path d="M 43.5 15.5 A 14.5 14.5 0 0 1 43.5 32.5" fill="none" stroke={strokeColor} strokeWidth="2" strokeLinecap="round" />
          <Path d="M 32 28 L 24 47 M 32 28 L 40 47 M 26.5 40.5 L 37.5 40.5" stroke={strokeColor} strokeWidth="2.4" strokeLinecap="round" />
        </G>
      );

    case 'community_pillar':
    case 'shield_crest':
    default:
      // Community Vanguard / Custom badge shield crest
      return (
        <G>
          <Path
            d="M 32 16 L 45 21.5 L 45 33 C 45 41.2 39.2 46.8 32 49.5 C 24.8 46.8 19 41.2 19 33 L 19 21.5 Z"
            fill="none"
            stroke={strokeColor}
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          <Path
            d="M 26.5 32.5 L 30.5 36.5 L 38 28.5"
            fill="none"
            stroke={strokeColor}
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </G>
      );
  }
}

export function BadgeCrest({
  iconKey,
  accentHex = '#E11D48',
  rarity = 'rare',
  serialNumber,
  size = 52,
  locked = false,
}: BadgeCrestProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const primary = locked ? '#52525E' : accentHex;
  const strokeColor = locked ? '#8E8E9E' : '#FFFFFF';
  const rimColor =
    locked
      ? 'rgba(255,255,255,0.12)'
      : rarity === 'mythic'
        ? '#FDE68A'
        : rarity === 'legendary'
          ? '#FCD34D'
          : rarity === 'epic'
            ? 'rgba(255,255,255,0.65)'
            : 'rgba(255,255,255,0.38)';

  const outerGrad = `crestOuter_${uid}`;
  const coreGrad = `crestCore_${uid}`;

  return (
    <View style={{ width: size, height: size + (serialNumber != null ? Math.round(size * 0.16) : 0), alignItems: 'center' }}>
      <Svg width={size} height={size} viewBox="0 0 64 64">
        <Defs>
          <LinearGradient id={outerGrad} x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor={primary} stopOpacity={locked ? '0.28' : '0.96'} />
            <Stop offset="100%" stopColor="#14141C" stopOpacity="0.98" />
          </LinearGradient>
          <LinearGradient id={coreGrad} x1="15%" y1="5%" x2="85%" y2="95%">
            <Stop offset="0%" stopColor={primary} stopOpacity={locked ? '0.22' : '0.44'} />
            <Stop offset="100%" stopColor="#0D0D13" stopOpacity="0.96" />
          </LinearGradient>
        </Defs>

        {rarity === 'mythic' || rarity === 'legendary' ? (
          <Polygon
            points="32,2 53.2,10.8 62,32 53.2,53.2 32,62 10.8,53.2 2,32 10.8,10.8"
            fill={`url(#${outerGrad})`}
            stroke={rimColor}
            strokeWidth="2.2"
          />
        ) : rarity === 'epic' ? (
          <Polygon
            points="32,3 57,17.5 57,46.5 32,61 7,46.5 7,17.5"
            fill={`url(#${outerGrad})`}
            stroke={rimColor}
            strokeWidth="2"
          />
        ) : (
          <Circle
            cx="32"
            cy="32"
            r="28.5"
            fill={`url(#${outerGrad})`}
            stroke={rimColor}
            strokeWidth="2"
          />
        )}

        <Circle
          cx="32"
          cy="32"
          r="23"
          fill={`url(#${coreGrad})`}
          stroke={locked ? 'rgba(255,255,255,0.1)' : primary}
          strokeWidth="1.25"
          strokeOpacity={locked ? 0.35 : 0.75}
        />

        {renderInnerEmblem(iconKey, strokeColor)}
      </Svg>

      {serialNumber != null ? (
        <View
          style={[
            styles.serialPlate,
            {
              borderColor: rimColor,
              backgroundColor: locked ? '#1E1E28' : '#121219',
              marginTop: -Math.round(size * 0.2),
            },
          ]}
        >
          <Text
            style={{
              fontSize: Math.max(9, Math.round(size * 0.19)),
              fontWeight: '800',
              color: locked ? '#9CA3AF' : '#FDE68A',
              letterSpacing: 0.4,
            }}
            numeric
          >
            #{serialNumber}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  serialPlate: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
