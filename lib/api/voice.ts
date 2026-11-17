// Voice notes for the Nari DM.
//
// The recording never touches a provider credential. It is posted to the `operator-voice` Edge
// Function, which holds `GEMINI_VOICE_API_KEY` as a function secret and talks to Gemini for
// speech-to-text and speech-out. The client only ever sees the transcript, Nari's reply (which
// arrives through the ordinary DM thread) and any synthesised audio the function returns.
//
// Gemini is the voice engine only: the transcript is handed to the same Nari DM, so thinking,
// tools, memory and permissions stay in Hallyu's own operator backend.

import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../../constants/keys';
import { ensureBackendSessionToken } from './client';

export interface VoiceStatus {
  contract_version?: number;
  configured: boolean;
  stt_ready?: boolean;
  tts_ready?: boolean;
  voice_model?: string;
  endpoint?: string;
  note?: string;
  error?: string | null;
}

export interface VoiceTurnResponse {
  ok: boolean;
  transcript?: string;
  stage?: string;
  error?: string;
  [key: string]: unknown;
}

export interface VoiceClip {
  audioBase64: string;
  mimeType: string;
  durationMs: number;
}

export class VoiceError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'VoiceError';
    this.status = status;
  }
}

async function callVoice<T>(payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new VoiceError('This build has no backend connection configured.', 0);
  }
  const token = await ensureBackendSessionToken();
  if (!token) {
    throw new VoiceError('Sign in to talk to Nari.', 401);
  }

  const response = await fetch(`${SUPABASE_URL}/functions/v1/operator-voice`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text().catch(() => '');
  let parsed: (T & { error?: string }) | null = null;
  try {
    parsed = text ? (JSON.parse(text) as T & { error?: string }) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const message =
      parsed?.error ||
      text.slice(0, 300) ||
      `Voice request failed (${response.status})`;
    throw new VoiceError(message, response.status);
  }

  if (!parsed) throw new VoiceError('Invalid voice response.', 502);
  return parsed as T;
}

export const voiceApi = {
  status: () => callVoice<VoiceStatus>({ action: 'status' }),
  transcribe: (audioBase64: string, mimeType: string, signal?: AbortSignal) =>
    callVoice<{ ok: boolean; transcript?: string; voice_model?: string }>({
      action: 'transcribe', audio_base64: audioBase64, mime_type: mimeType,
    }, signal),
  synthesize: (messageId: string, chunkIndex = 0, signal?: AbortSignal) =>
    callVoice<{ ok: boolean; message_id: string; chunk_index: number; chunk_count: number;
      audio_base64: string; audio_mime_type: string }>({
      action: 'synthesize', message_id: messageId, chunk_index: chunkIndex,
    }, signal),
};

// ── Recording ────────────────────────────────────────────────────────────────────────────────
//
// Native uses expo-av's recorder. Web has no file on disk to read back, so it uses MediaRecorder
// and base64-encodes the blob directly. Both produce the same shape for the Edge Function.

interface WebRecorderState {
  recorder: any;
  stream: any;
  chunks: any[];
  startedAt: number;
  mimeType: string;
}

let recordingTimer: ReturnType<typeof setTimeout> | null = null;
function clearRecordingTimer() { if (recordingTimer) clearTimeout(recordingTimer); recordingTimer = null; }

let nativeRecording: Audio.Recording | null = null;
let nativeStartedAt = 0;
let webRecorder: WebRecorderState | null = null;

export function isRecordingVoiceNote(): boolean {
  return Boolean(nativeRecording) || Boolean(webRecorder);
}

export async function startVoiceNote(): Promise<void> {
  if (isRecordingVoiceNote()) return;

  if (Platform.OS === 'web') {
    const nav = (globalThis as any).navigator;
    const MediaRecorderCtor = (globalThis as any).MediaRecorder;
    if (!nav?.mediaDevices?.getUserMedia || !MediaRecorderCtor) {
      throw new VoiceError('This browser cannot record audio.', 501);
    }
    const stream = await nav.mediaDevices.getUserMedia({ audio: true });
    let recorder: any;
    try { recorder = new MediaRecorderCtor(stream); } catch (error) {
      stream.getTracks().forEach((track: any) => track.stop()); throw error;
    }
    const chunks: any[] = [];
    recorder.ondataavailable = (event: any) => {
      if (event?.data?.size) chunks.push(event.data);
    };
    try { recorder.start(); } catch (error) {
      stream.getTracks().forEach((track: any) => track.stop()); throw error;
    }
    webRecorder = {
      recorder,
      stream,
      chunks,
      startedAt: Date.now(),
      mimeType: String(recorder.mimeType || 'audio/webm'),
    };
    recordingTimer = setTimeout(() => void cancelVoiceNote(), 60000);
    return;
  }

  const permission = await Audio.requestPermissionsAsync();
  if (!permission.granted) {
    throw new VoiceError('Microphone permission is required to send a voice note.', 403);
  }
  await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
  const recording = new Audio.Recording();
  try {
    await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
    await recording.startAsync();
  } catch (error) {
    await recording.stopAndUnloadAsync().catch(() => {});
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(() => {});
    throw error;
  }
  nativeRecording = recording;
  nativeStartedAt = Date.now();
  recordingTimer = setTimeout(() => void cancelVoiceNote(), 60000);
}

function mimeTypeFromUri(uri: string): string {
  const extension = uri.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  if (extension === 'm4a' || extension === 'mp4') return 'audio/mp4';
  if (extension === 'caf') return 'audio/x-caf';
  if (extension === '3gp') return 'audio/3gpp';
  if (extension === 'webm') return 'audio/webm';
  if (extension === 'wav') return 'audio/wav';
  return 'audio/mp4';
}

function base64FromBytes(bytes: Uint8Array): string {
  const btoaImpl = (globalThis as any).btoa as ((input: string) => string) | undefined;
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(index, index + chunkSize)));
  }
  if (!btoaImpl) throw new VoiceError('This browser cannot encode audio.', 501);
  return btoaImpl(binary);
}

export async function stopVoiceNote(): Promise<VoiceClip> {
  clearRecordingTimer();
  if (webRecorder) {
    const { recorder, stream, chunks, startedAt, mimeType } = webRecorder;
    webRecorder = null;
    try {
      const stopped = new Promise<void>((resolve, reject) => {
        recorder.onstop = () => resolve();
        recorder.onerror = () => reject(new VoiceError('Recording failed.', 422));
      });
      recorder.stop();
      await stopped;
    } finally { stream?.getTracks?.().forEach((track: any) => track.stop()); }

    const BlobCtor = (globalThis as any).Blob;
    const blob = new BlobCtor(chunks, { type: mimeType });
    const buffer = await blob.arrayBuffer();
    if (!buffer?.byteLength) throw new VoiceError('Nothing was recorded.', 422);
    return {
      audioBase64: base64FromBytes(new Uint8Array(buffer)),
      mimeType: mimeType.split(';')[0] || 'audio/webm',
      durationMs: Date.now() - startedAt,
    };
  }

  const recording = nativeRecording;
  if (!recording) throw new VoiceError('No voice note is recording.', 409);
  nativeRecording = null;
  try { await recording.stopAndUnloadAsync(); }
  finally { await Audio.setAudioModeAsync({ allowsRecordingIOS: false }); }
  const uri = recording.getURI();
  if (!uri) throw new VoiceError('The recording produced no audio.', 422);
  let audioBase64: string;
  try { audioBase64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }); }
  finally { await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {}); }
  if (!audioBase64) throw new VoiceError('The recording produced no audio.', 422);
  return {
    audioBase64,
    mimeType: mimeTypeFromUri(uri),
    durationMs: Date.now() - nativeStartedAt,
  };
}

export async function cancelVoiceNote(): Promise<void> {
  clearRecordingTimer();
  if (webRecorder) {
    const { recorder, stream } = webRecorder;
    webRecorder = null;
    try {
      recorder.stop();
    } catch {
      // already stopped
    }
    stream?.getTracks?.().forEach((track: any) => track.stop());
    return;
  }
  const recording = nativeRecording;
  nativeRecording = null;
  if (!recording) return;
  try {
    await recording.stopAndUnloadAsync();
  } catch {
    // already unloaded
  }
  const uri = recording.getURI();
  if (uri) await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
  await Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(() => {});
}
