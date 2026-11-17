// Gemini voice transport only. No reasoning, tool execution, model or endpoint fallback.
export class VoiceFailure extends Error {
  constructor(public code: string, public status = 400, public providerDetail?: string) { super(code); }
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
export function normalizeSpeechAudio(data: string, mime: string): {type:string;data:string;mime_type:string} {
  if (mime === 'audio/wav') return {type:'audio',data,mime_type:mime};
  if (!/^audio\/L16;codec=pcm;rate=24000$/i.test(mime)) throw new VoiceFailure('unsupported_audio_response',502);
  const raw=atob(data); if (!raw.length || raw.length%2 || raw.length>8*1024*1024) throw new VoiceFailure('invalid_audio_response',502);
  const bytes=new Uint8Array(44+raw.length); const view=new DataView(bytes.buffer);
  const text=(offset:number,value:string)=>{for(let i=0;i<value.length;i++)bytes[offset+i]=value.charCodeAt(i);};
  text(0,'RIFF');view.setUint32(4,36+raw.length,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,24000,true);view.setUint32(28,48000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,raw.length,true);
  for(let i=0;i<raw.length;i++)bytes[44+i]=raw.charCodeAt(i);
  let encoded='';for(let i=0;i<bytes.length;i+=8192)encoded+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return {type:'audio',data:btoa(encoded),mime_type:'audio/wav'};
}
export async function geminiInteraction(key: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 45000);
  try {
    // Explicit stable Gemini generateContent routing for dedicated voice models.
    const model = String(payload.model ?? '');
    if (!/^[a-z0-9.-]+$/.test(model)) throw new VoiceFailure('invalid_voice_configuration', 503);
    const input = payload.input as any[];
    const audio = input?.find((part: any) => part.type === 'audio');
    const spokenText = input?.flatMap((part: any) => part.content ?? []).find((part: any) => part.type === 'text')?.text;
    const contentPayload = audio ? {
      contents: [{ role: 'user', parts: [{ text: input.find((part: any) => part.type === 'text')?.text }, { inlineData: { mimeType: audio.mime_type, data: audio.data } }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 4096 },
    } : {
      contents: [{ role: 'user', parts: [{ text: spokenText }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } },
    };
    const useInteractions = Boolean(audio) && Deno.env.get('GEMINI_VOICE_STT_TRANSPORT') === 'interactions';
    const endpoint = useInteractions ? 'https://generativelanguage.googleapis.com/v1beta/interactions' : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(useInteractions ? {...payload, store:false} : contentPayload), signal: controller.signal,
    });
    if (!response.ok) {
      const code = response.status === 401 ? 'invalid_credentials' : response.status === 403 ? 'access_denied'
        : response.status === 429 ? 'quota_or_rate_limit' : response.status >= 500 ? 'provider_unavailable' : 'provider_rejected';
      const problem = await response.json().catch(() => null);
      const detail = `${response.status}:${String(problem?.error?.status ?? '')}:${String(problem?.error?.message ?? '').slice(0,250)}`;
      throw new VoiceFailure(code, 502, detail);
    }
    const result = await response.json();
    if (useInteractions) {
      if (result.status !== 'completed' || !Array.isArray(result.steps)) throw new VoiceFailure('incomplete_provider_response',502);
      return result;
    }
    const candidate = result.candidates?.[0];
    if (!candidate || candidate.finishReason !== 'STOP' || !Array.isArray(candidate.content?.parts)) throw new VoiceFailure('incomplete_provider_response', 502);
    return { steps: [{ type: 'model_output', content: candidate.content.parts.filter((part: any) => !part.thought).map((part: any) => part.inlineData ?
      normalizeSpeechAudio(part.inlineData.data, part.inlineData.mimeType) : { type: 'text', text: part.text ?? '' }) }], usage: result.usageMetadata };
  } catch (error) {
    if (error instanceof VoiceFailure) throw error;
    throw new VoiceFailure(controller.signal.aborted ? 'voice_cancelled_or_timeout' : 'voice_network_error', 502);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export function outputContent(result: Record<string, any>): Record<string, any>[] {
  return result.steps.filter((step: any) => step.type === 'model_output').flatMap((step: any) => Array.isArray(step.content) ? step.content : []);
}
