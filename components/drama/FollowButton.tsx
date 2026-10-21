import React, { useRef } from 'react';
import { AccessibilityInfo, Animated, StyleProp, ViewStyle } from 'react-native';
import { Button, ButtonSize } from '../ui/Button';
import { useApp, useRequireMember, haptic, useReduceMotion } from '../../lib/hooks';
import { springs } from '../../lib/motion';
import { useToast } from '../ui/Toast';
import { AppState } from '../../lib/store';
import { setFollow } from '../../lib/api/social';
import { track } from '../../lib/analytics';

interface FollowButtonProps {
  kind: keyof AppState['follows'];
  id: string;
  name?: string; // for toast copy
  size?: ButtonSize;
  block?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Called after a follow (e.g. to offer notifications) */
  onFollowed?: () => void;
}

/** One verb everywhere: Follow / Following / Requested (for private member accounts). */
export function FollowButton({ kind, id, name, size = 'sm', block, style, onFollowed }: FollowButtonProps) {
  const { isFollowing, getUser, dispatch } = useApp();
  const require = useRequireMember();
  const toast = useToast();
  const reduce = useReduceMotion();
  const [requested, setRequested] = React.useState(false);
  const targetUser = kind === 'users' ? getUser(id) : undefined;
  const on = isFollowing(kind, id);
  const noun = kind === 'users' ? 'person' : kind === 'dramas' ? 'drama' : kind === 'actors' ? 'actor' : 'collection';
  const pulse = useRef(new Animated.Value(1)).current;
  /** The state change is the feedback: a small settle when it flips to Following. */
  const settle = () => {
    if (reduce) return;
    pulse.setValue(0.94);
    Animated.spring(pulse, { toValue: 1, ...springs.bouncy }).start();
  };
  const label = on ? 'Following' : requested ? 'Requested' : 'Follow';
  const active = on || requested;
  return (
    <Animated.View style={[block ? { alignSelf: 'stretch' } : null, { transform: [{ scale: pulse }] }]}>
      <Button
        label={label}
        variant={active ? 'secondary' : 'primary'}
        size={size}
        block={block}
        style={style}
        icon={on ? 'checkmark' : requested ? 'time-outline' : undefined}
        accessibilityLabel={`${active ? 'Unfollow' : 'Follow'} ${name ?? noun}`}
        accessibilityState={{ selected: active }}
        onPress={() =>
          require(`follow this ${noun}`, () => {
            if (active) {
              haptic.select();
              setRequested(false);
              dispatch({ type: 'follow', kind, id, on: false });
              track('follow.set', { kind, on: false });
              AccessibilityInfo.announceForAccessibility?.(`Unfollowed ${name ?? noun}`);
              return;
            }
            haptic.success();
            if (targetUser?.isPrivate) {
              setRequested(true);
              dispatch({ type: 'follow', kind, id, on: false });
              void setFollow('user', id, true).catch(() => setRequested(false));
              settle();
              toast.show({ message: `Follow request sent to ${name ?? `@${targetUser.handle}`}` });
              return;
            }
            dispatch({ type: 'follow', kind, id, on: true });
            track('follow.set', { kind, on: true });
            AccessibilityInfo.announceForAccessibility?.(`Following ${name ?? noun}`);
            settle();
            onFollowed?.();
            toast.show({ message: `Following ${name ?? `this ${noun}`}`, actionLabel: 'Undo', onAction: () => dispatch({ type: 'follow', kind, id, on: false }) });
          })
        }
      />
    </Animated.View>
  );
}
