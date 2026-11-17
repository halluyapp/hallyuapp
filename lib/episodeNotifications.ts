import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  EPISODE_NOTIFIED_STORAGE_KEY,
  evaluateAiredEpisodeNotifications,
  mergeEpisodeNotifications,
  type AiredEpisodeCandidate,
  type EpisodeEvaluationState,
} from './episodeNotificationRules';

export {
  EPISODE_NOTIFIED_STORAGE_KEY,
  evaluateAiredEpisodeNotifications,
  mergeEpisodeNotifications,
  type AiredEpisodeCandidate,
  type EpisodeEvaluationState,
};

export async function readNotifiedEpisodeKeys(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(EPISODE_NOTIFIED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

export async function persistNotifiedEpisodeKeys(keys: ReadonlySet<string>): Promise<void> {
  try {
    await AsyncStorage.setItem(EPISODE_NOTIFIED_STORAGE_KEY, JSON.stringify([...keys].slice(-400)));
  } catch {
    // Non-fatal
  }
}

export function requestWebEpisodeNotificationPermission(): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (window.Notification.permission === 'default') {
    void window.Notification.requestPermission().catch(() => {});
  }
}

export function presentWebEpisodeNotification(candidate: AiredEpisodeCandidate): boolean {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (window.Notification.permission !== 'granted') return false;
  try {
    new window.Notification(candidate.notification.title ?? candidate.toastTitle, {
      body: candidate.notification.body,
      tag: candidate.key,
    });
    return true;
  } catch {
    return false;
  }
}
