import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { allDramas, AppState, getState } from './store';

/**
 * Native OS notification channels, local episode reminders, server-event heads-up banner presentation,
 * and unified deep-link extraction across both remote push notifications and local air-time reminders.
 */

export const remindersSupported = Platform.OS !== 'web';

const PREFIX = 'ep:';
const CHANNEL_EPISODES = 'episodes';
const CHANNEL_SOCIAL = 'social';
const CHANNEL_SYSTEM = 'system';
const CHANNEL_REMINDERS = 'reminders';
const CHANNEL_LIVE_PULSE = 'live_pulse';
export const LIVE_PULSE_NOTIFICATION_ID = 'hallyu-live-pulse-banner';
const HORIZON_MS = 14 * 86_400_000;
const SHOWN_NOTIFICATIONS_KEY = 'hallyu.shownNotificationIds.v1';

export interface PlannedReminder {
  id: string;
  dramaId: string;
  title: string;
  body: string;
  at: Date;
  url: string;
}

let handlerInstalled = false;
let channelsConfigured = false;
const shownRemoteNotificationIds = new Set<string>();
let shownIdsLoaded: Promise<void> | null = null;

function ensureShownIdsLoaded(): Promise<void> {
  if (!shownIdsLoaded) {
    shownIdsLoaded = AsyncStorage.getItem(SHOWN_NOTIFICATIONS_KEY)
      .then((raw) => {
        if (!raw) return;
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          for (const id of parsed) {
            if (typeof id === 'string') shownRemoteNotificationIds.add(id);
          }
        }
      })
      .catch(() => {});
  }
  return shownIdsLoaded;
}

function persistShownIds(): void {
  const recent = [...shownRemoteNotificationIds].slice(-250);
  void AsyncStorage.setItem(SHOWN_NOTIFICATIONS_KEY, JSON.stringify(recent)).catch(() => {});
}

/** Foreground presentation: surface heads-up OS banners with sound across foreground & active states. */
export function installNotificationHandler() {
  if (!remindersSupported || handlerInstalled) return;
  handlerInstalled = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
}

/**
 * Configure all Android 8+ notification channels at startup with MAX importance and PUBLIC lockscreen
 * visibility so heads-up banners and lock-screen alerts display reliably on Android 13/14/15.
 */
export async function ensureAndroidNotificationChannels(): Promise<void> {
  if (Platform.OS !== 'android' || channelsConfigured) return;
  try {
    const shared = {
      importance: Notifications.AndroidImportance.MAX,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      vibrationPattern: [0, 250, 150, 250],
      lightColor: '#E11D48',
      sound: 'default',
    };
    await Promise.all([
      Notifications.setNotificationChannelAsync(CHANNEL_EPISODES, {
        name: 'Episode nights',
        description: 'New episodes and live rooms for series you follow.',
        ...shared,
      }),
      Notifications.setNotificationChannelAsync(CHANNEL_SOCIAL, {
        name: 'Social activity',
        description: 'Followers, comments, replies, and reactions on your posts.',
        ...shared,
      }),
      Notifications.setNotificationChannelAsync(CHANNEL_SYSTEM, {
        name: 'Account & system notices',
        description: 'Moderation updates, verification tests, and account security alerts.',
        ...shared,
      }),
      Notifications.setNotificationChannelAsync(CHANNEL_REMINDERS, {
        name: 'Scheduled reminders',
        description: 'On-device countdown reminders for upcoming broadcasts.',
        ...shared,
      }),
      Notifications.setNotificationChannelAsync(CHANNEL_LIVE_PULSE, {
        name: 'Live Pulse Shade Banner',
        description: 'Silent ongoing lock-screen & shade pulse for active watch parties and premieres.',
        importance: Notifications.AndroidImportance.LOW,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        enableVibrate: false,
        sound: null,
      }),
    ]);
    channelsConfigured = true;
  } catch (e) {
    if (__DEV__) console.warn('[notifications] channel setup failed', e);
  }
}

export function channelForGroup(group?: string | null): string {
  if (group === 'social' || group === 'mentions') return CHANNEL_SOCIAL;
  if (group === 'system') return CHANNEL_SYSTEM;
  return CHANNEL_EPISODES;
}

/**
 * Raises a real OS heads-up banner for an incoming server-created `public.notifications` record
 * received over Realtime, strictly deduplicated by server notification UUID.
 */
export async function presentServerNotificationBanner(input: {
  id: string;
  group?: string | null;
  title?: string | null;
  body?: string | null;
  deepLink?: string | null;
}): Promise<boolean> {
  if (!remindersSupported || !input.id) return false;
  await ensureShownIdsLoaded();
  if (shownRemoteNotificationIds.has(input.id)) return false;
  shownRemoteNotificationIds.add(input.id);
  persistShownIds();

  try {
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) return false;
    await ensureAndroidNotificationChannels();
    const channelId = channelForGroup(input.group);
    const deepLink =
      input.deepLink && input.deepLink.startsWith('/')
        ? input.deepLink === '/notifications'
          ? '/(tabs)/activity'
          : input.deepLink
        : '/(tabs)/activity';
    await Notifications.scheduleNotificationAsync({
      identifier: `srv:${input.id}`,
      content: {
        title: input.title?.trim() || 'Hallyu',
        body: input.body?.trim() || 'You have a new update on Hallyu.',
        sound: 'default',
        data: {
          notification_id: input.id,
          deep_link: deepLink,
          url: deepLink,
          source: 'server_realtime',
        },
        ...(Platform.OS === 'android' ? { channelId } : {}),
      },
      trigger: null,
    });
    return true;
  } catch {
    return false;
  }
}

export type PermissionState = 'granted' | 'denied' | 'undetermined' | 'unsupported';

export async function notificationPermission(): Promise<PermissionState> {
  if (!remindersSupported) return 'unsupported';
  try {
    const p = await Notifications.getPermissionsAsync();
    return p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied';
  } catch {
    return 'denied';
  }
}

/** Request OS notification permission explicitly in response to a user action and ensure Android channels exist. */
export async function ensureNotificationPermission(): Promise<PermissionState> {
  if (!remindersSupported) return 'unsupported';
  try {
    await ensureAndroidNotificationChannels();
    const cur = await Notifications.getPermissionsAsync();
    if (cur.granted) return 'granted';
    if (!cur.canAskAgain) return 'denied';
    const req = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    });
    return req.granted ? 'granted' : req.canAskAgain ? 'undetermined' : 'denied';
  } catch {
    return 'denied';
  }
}

/** Pure: what local air-time reminders should be scheduled within the 14-day horizon. */
export function plannedReminders(s: AppState, from = Date.now()): PlannedReminder[] {
  if (!s.prefs.notifications.episodes) return [];
  const out: PlannedReminder[] = [];
  for (const drama of allDramas(s)) {
    if (!s.follows.dramas.includes(drama.id)) continue;
    if (s.dramaNotify[drama.id] === false) continue;
    for (const e of drama.episodes) {
      if (!e.airDate) continue;
      const at = new Date(e.airDate).getTime();
      if (!Number.isFinite(at) || at <= from + 30_000 || at > from + HORIZON_MS) continue;
      const multi = drama.seasons.length > 1;
      out.push({
        id: `${PREFIX}${drama.id}:${e.season}:${e.number}:${Math.floor(at / 60_000)}`,
        dramaId: drama.id,
        title: `${drama.title} · ${multi ? `S${e.season} ` : ''}Episode ${e.number} is airing`,
        body: e.title ? `“${e.title}” — the room is open. Join while it’s live.` : 'The room is open — join while it’s live.',
        at: new Date(at),
        url: `/episode/${drama.id}/${e.season}/${e.number}`,
      });
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

let inflight: Promise<void> | null = null;
let again = false;

/** Reconcile the OS scheduled reminder queue with `plannedReminders(state)`. */
export function syncEpisodeReminders(s: AppState = getState()): Promise<void> {
  if (!remindersSupported) return Promise.resolve();
  if (inflight) {
    again = true;
    return inflight;
  }
  inflight = (async () => {
    try {
      const perm = await Notifications.getPermissionsAsync();
      if (!perm.granted) return;
      await ensureAndroidNotificationChannels();
      const want = plannedReminders(s);
      const wantIds = new Set(want.map((w) => w.id));
      const have = new Set<string>();
      for (const n of await Notifications.getAllScheduledNotificationsAsync()) {
        if (!n.identifier.startsWith(PREFIX)) continue;
        if (wantIds.has(n.identifier)) have.add(n.identifier);
        else await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => {});
      }
      for (const w of want) {
        if (have.has(w.id)) continue;
        await Notifications.scheduleNotificationAsync({
          identifier: w.id,
          content: {
            title: w.title,
            body: w.body,
            data: { url: w.url, deep_link: w.url, dramaId: w.dramaId, source: 'local_reminder' },
            sound: 'default',
          },
          trigger: Platform.OS === 'android' ? { date: w.at, channelId: CHANNEL_REMINDERS } : w.at,
        });
      }
    } catch (e) {
      if (__DEV__) console.warn('[reminders] sync failed', e);
    }
  })().finally(() => {
    inflight = null;
    if (again) {
      again = false;
      void syncEpisodeReminders(getState());
    }
  });
  return inflight;
}

/** Extract in-app deep-link route from either a remote push payload (`deep_link`) or local reminder (`url`). */
export function parseNotificationDeepLink(data: Record<string, unknown> | null | undefined): string | undefined {
  if (!data) return undefined;
  const candidate = typeof data.url === 'string' && data.url.startsWith('/')
    ? data.url
    : typeof data.deep_link === 'string' && data.deep_link.startsWith('/')
      ? data.deep_link
      : undefined;
  if (candidate === '/notifications') return '/(tabs)/activity';
  return candidate;
}

/** Deep-link target carried by a notification response, if any. */
export function reminderUrl(response: Notifications.NotificationResponse | null | undefined): string | undefined {
  const data = response?.notification.request.content.data as Record<string, unknown> | undefined;
  return parseNotificationDeepLink(data);
}

/**
 * Syncs the opt-in silent Android Notification-Shade / Lock-Screen "Hallyu Live Pulse" banner.
 * Keeps Hallyu alive in the notification drawer with active watch rooms, tonight's airing shows,
 * and unread counts without buzzing or interrupting the user.
 */
export async function syncLivePulseBanner(s: AppState): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    if (!s.prefs.livePulseBanner) {
      await Notifications.dismissNotificationAsync(LIVE_PULSE_NOTIFICATION_ID).catch(() => {});
      await Notifications.cancelScheduledNotificationAsync(LIVE_PULSE_NOTIFICATION_ID).catch(() => {});
      return;
    }

    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) return;
    await ensureAndroidNotificationChannels();

    const airingNow = allDramas(s).filter((d) => d.status === 'airing');
    const unreadCount = s.notifications.filter((n) => !n.read).length;
    const leadTitle = airingNow[0]?.title;
    const title = leadTitle
      ? `Hallyu Live · ${leadTitle} & Tonight's Watch Rooms`
      : 'Hallyu Live Pulse · Watch Rooms Active';
    const body =
      unreadCount > 0
        ? `${unreadCount} unread update${unreadCount === 1 ? '' : 's'} · Tap to jump into tonight's live feed & events`
        : `${Math.max(airingNow.length, 4)} live rooms & premiere countdowns open now · Tap to join`;

    await Notifications.scheduleNotificationAsync({
      identifier: LIVE_PULSE_NOTIFICATION_ID,
      content: {
        title,
        body,
        sound: false,
        sticky: true,
        priority: Notifications.AndroidNotificationPriority.LOW,
        data: {
          url: '/events',
          deep_link: '/events',
          source: 'live_pulse_banner',
        },
        ...(Platform.OS === 'android' ? { channelId: CHANNEL_LIVE_PULSE } : {}),
      },
      trigger: null,
    });
  } catch {
    // Non-fatal
  }
}
