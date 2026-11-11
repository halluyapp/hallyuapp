/** One in-flight registration action, with bounded retries for the idempotent register_profile RPC. */
export async function provisionWithRetry<T>(
  operation: () => Promise<T>,
  isCurrent: () => boolean,
  delay: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T> {
  let lastFailure: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastFailure = error;
      if (!isCurrent()) throw error;
      if (attempt < 2) await delay(350 * 2 ** attempt);
    }
  }
  throw lastFailure ?? new Error('Account setup could not be completed.');
}
