import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl } from 'react-native';
import { colors } from '../../constants/theme';

/**
 * Pull-to-refresh for a screen. When a backend task is supplied, success means that task completed;
 * failures are exposed to the screen and cached data is left alone. Device-local screens may omit it.
 */
export function useRefresh(_scope?: string, task?: () => Promise<void>) {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const running = useRef<Promise<boolean> | null>(null);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const onRefresh = useCallback(async (): Promise<boolean> => {
    if (running.current) return running.current;
    setRefreshing(true);
    setError(null);
    const run = (async () => {
      try {
        // Preserve the small visual beat, but never substitute it for the requested data request.
        await Promise.all([task?.() ?? Promise.resolve(), new Promise((r) => setTimeout(r, 350))]);
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Refresh failed. Your cached data is unchanged.';
        if (alive.current) setError(message);
        return false;
      }
    })();
    running.current = run;
    try {
      return await run;
    } finally {
      if (running.current === run) running.current = null;
      if (alive.current) setRefreshing(false);
    }
  }, [task]);
  const control = <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} progressBackgroundColor={colors.surface2} />;
  return { refreshing, error, onRefresh, control };
}
