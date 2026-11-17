// Gemini voice transport only. No reasoning, tool execution, model or endpoint fallback.
export class VoiceFailure extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
export function validateAudio(data: unknown, mime: unknown): { data: string; mime_type: string } {
  const allowed = ['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/m4a', 'audio/webm'];
  // expo-av records AAC inside an MP4 container.
  const type = mime === 'audio/mp4' ? 'audio/m4a' : String(mime);
  if (!allowed.includes(type)) throw new VoiceFailure('unsupported_audio_format', 415);
  if (typeof data !== 'string' || !data.length || data.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 ||
      data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new VoiceFailure('invalid_audio', 422);
  let bytes: string;
  try { bytes = atob(data); } catch { throw new VoiceFailure('invalid_audio', 422); }
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) throw new VoiceFailure('audio_too_large', 413);
  return { data, mime_type: type };
}
export function textChunks(text: string, limit = 1800): string[] {
  const chunks: string[] = [];
  while (text.length) {
    let end = Math.min(limit, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end - 1);
      if (space > limit / 2) end = space + 1;
    }
    chunks.push(text.slice(0, end)); text = text.slice(end);
  }
  return chunks;
}
export async function geminiInteraction(key: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 45000);
  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ ...payload, store: false }), signal: controller.signal,
    });
    if (!response.ok) {
      const code = response.status === 401 ? 'invalid_credentials' : response.status === 403 ? 'access_denied'
        : response.status === 429 ? 'quota_or_rate_limit' : response.status >= 500 ? 'provider_unavailable' : 'provider_rejected';
      throw new VoiceFailure(code, 502);
    }
    const result = await response.json();
    if (result.status !== 'completed' || !Array.isArray(result.steps)) throw new VoiceFailure('incomplete_provider_response', 502);
    return result;
  } catch (error) {
    if (error instanceof VoiceFailure) throw error;
    throw new VoiceFailure(controller.signal.aborted ? 'voice_cancelled_or_timeout' : 'voice_network_error', 502);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export function outputContent(result: Record<string, any>): Record<string, any>[] {
  return result.steps.filter((step: any) => step.type === 'model_output').flatMap((step: any) => Array.isArray(step.content) ? step.content : []);
}
