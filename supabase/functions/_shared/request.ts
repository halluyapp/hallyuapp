// Request validation shared by service-role workers. Empty scheduler payloads are allowed; malformed
// JSON, arrays, null, and scalar bodies are not silently converted into destructive default jobs.

export async function readObjectBody(request: Request, allowEmpty = true): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) {
    if (allowEmpty) return {};
    throw new Error('a JSON object body is required');
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('the request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

export function integerOption(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}
