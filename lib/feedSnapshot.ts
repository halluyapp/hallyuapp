/** A ranked feed row retained by a screen while the canonical posts live in the store. */
export interface FeedSnapshotItem<T extends { id: string }> {
  post: T;
  reason?: string;
}

/**
 * Compare ranking and post versions. IDs alone are insufficient: reactions, comments, edits and
 * media can change without moving a chronological post, and those updates must reach the cards.
 */
export function feedSnapshotEqual<T extends { id: string }>(a: FeedSnapshotItem<T>[], b: FeedSnapshotItem<T>[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.post !== b[i]!.post || a[i]!.reason !== b[i]!.reason) return false;
  }
  return true;
}
