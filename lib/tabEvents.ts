/**
 * Lightweight zero-dependency event coordination for navigation polish:
 * 1) Re-tapping the currently active bottom tab scrolls that tab's list smoothly to the top.
 * 2) Tapping the center `+` button in the bottom TabBar opens the contextual `CreateSheet` immediately.
 */
import type { PostContext } from './model';

export type TabRouteName = 'index' | 'explore' | 'activity' | 'you';

type Listener = () => void;
type CreateListener = (context?: PostContext) => void;

const reTapListeners = new Map<TabRouteName, Set<Listener>>();
const createSheetListeners = new Set<CreateListener>();
let activePostContext: PostContext | undefined;

export function onTabReTap(tab: TabRouteName, fn: Listener): () => void {
  let bucket = reTapListeners.get(tab);
  if (!bucket) {
    bucket = new Set();
    reTapListeners.set(tab, bucket);
  }
  bucket.add(fn);
  return () => {
    bucket?.delete(fn);
  };
}

export function emitTabReTap(tab: TabRouteName): void {
  const bucket = reTapListeners.get(tab);
  if (!bucket) return;
  for (const fn of Array.from(bucket)) fn();
}

export function setActiveComposerContext(ctx?: PostContext): void {
  activePostContext = ctx;
}

export function getActiveComposerContext(): PostContext | undefined {
  return activePostContext;
}

export function onOpenGlobalCreateSheet(fn: CreateListener): () => void {
  createSheetListeners.add(fn);
  return () => {
    createSheetListeners.delete(fn);
  };
}

export function openGlobalCreateSheet(context?: PostContext): boolean {
  if (!createSheetListeners.size) return false;
  const resolved = context ?? activePostContext;
  for (const fn of Array.from(createSheetListeners)) fn(resolved);
  return true;
}
