import { useEffect, useState } from 'react';
import { listDownloads, listTransfers, subscribeCompletedDownloads, subscribeTransfers, type DownloadEntry, type TransferEntry } from '../../lib/watchStore';

/** Live list of unfinished transfers (downloading, paused, failed). Refreshes on every store change. */
export function useTransfers(): TransferEntry[] {
  const [list, setList] = useState<TransferEntry[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => void listTransfers().then((t) => alive && setList(t));
    load();
    const unsub = subscribeTransfers(load);
    return () => {
      alive = false;
      unsub();
    };
  }, []);
  return list;
}

/** Live list of completed, playable downloads. Only reloads when downloads are added or removed. */
export function useCompletedDownloads(): DownloadEntry[] {
  const [list, setList] = useState<DownloadEntry[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => void listDownloads().then((d) => alive && setList(d));
    load();
    const unsub = subscribeCompletedDownloads(load);
    return () => {
      alive = false;
      unsub();
    };
  }, []);
  return list;
}

