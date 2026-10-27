/**
 * Download notifications for Hallyu TV. One notification per download, updated in place as it progresses.
 * These local notices cover foreground transfers; Android DownloadManager supplies the native background
 * transfer notification in the signed APK. Notifications are best-effort: when permission is missing or the device
 * refuses, nothing is shown and the download itself is unaffected.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { progressNotice, type NoticeKind } from './watchRules';

const CHANNEL = 'hallyu-downloads';
const ID_PREFIX = 'watch-dl:';
let channelReady: Promise<void> | null = null;
const lastShown = new Map<string, { percent: number; at: number; kind: NoticeKind }>();

function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return Promise.resolve();
  channelReady ??= Notifications.setNotificationChannelAsync(CHANNEL, {
    name: 'Downloads',
    description: 'Progress of Hallyu TV downloads.',
    importance: Notifications.AndroidImportance.LOW,
    sound: null,
  }).then(
    () => undefined,
    () => undefined,
  );
  return channelReady;
}

/** Shows or updates the notification for one transfer. Repeated calls are throttled to whole percentages and time. */
export async function reportDownload(
  key: string,
  title: string,
  kind: NoticeKind,
  written: number,
  total: number | null,
  message?: string | null,
): Promise<void> {
  if (Platform.OS === 'web') return;
  const percent = total && total > 0 ? Math.min(100, Math.floor((written / total) * 100)) : 0;
  const prev = lastShown.get(key);
  const now = Date.now();
  if (kind === 'progress' && prev && prev.kind === 'progress' && percent - prev.percent < 5 && now - prev.at < 4000) return;
  lastShown.set(key, { percent, at: now, kind });
  const notice = progressNotice(kind, title, percent, message ?? null);
  try {
    await ensureChannel();
    await Notifications.scheduleNotificationAsync({
      identifier: `${ID_PREFIX}${key}`,
      content: {
        title: notice.title,
        body: notice.body,
        sound: false,
        priority: Notifications.AndroidNotificationPriority.LOW,
        data: { source: 'hallyu_download', url: '/watch/downloads' },
        ...(Platform.OS === 'android' ? { channelId: CHANNEL } : {}),
      },
      trigger: null,
    });
  } catch {
    // Permission missing or unsupported: skip silently.
  }
}

/** Removes a transfer's notification, for example after cancel. */
export async function clearDownloadNotice(key: string): Promise<void> {
  lastShown.delete(key);
  await Notifications.dismissNotificationAsync(`${ID_PREFIX}${key}`).catch(() => {});
}
