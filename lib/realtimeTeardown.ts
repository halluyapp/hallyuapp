/**
 * supabase-js returns the channel that is still registered under a topic when `channel(topic)` is
 * called, and a removed channel stays registered until its server unsubscribe finishes. Anything
 * that re-creates a channel on the same topic must therefore wait for those teardowns first. If it
 * does not, it gets the old, already-subscribed channel back and attaching handlers to it throws
 * "cannot add postgres_changes / presence callbacks after subscribe()".
 *
 * Dependency-free on purpose so it can be tested without loading the Supabase client.
 */
export interface RealtimeChannelRegistry {
  getChannels(): { topic: string }[];
  removeChannel(channel: { topic: string }): Promise<unknown>;
}

export function closeChannelsForTopic(
  client: RealtimeChannelRegistry,
  topic: string,
): Promise<void> {
  const realtimeTopic = `realtime:${topic}`;
  const teardowns: Promise<unknown>[] = [];
  for (const existing of client.getChannels()) {
    if (existing.topic === topic || existing.topic === realtimeTopic) {
      teardowns.push(client.removeChannel(existing).catch(() => undefined));
    }
  }
  return Promise.all(teardowns).then(() => undefined);
}
