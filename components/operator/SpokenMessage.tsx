import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Audio } from 'expo-av';
import { IconButton } from '../ui/IconButton';
import { Text } from '../ui/Text';
import { voiceApi } from '../../lib/api/voice';

// Fetch one chunk at a time: bounded memory even on low-end devices. No persistent audio cache.
export function SpokenMessage({ messageId }: { messageId: string }) {
  const [phase, setPhase] = useState<'idle' | 'loading' | 'playing' | 'paused' | 'error'>('idle');
  const [error, setError] = useState('');
  const sound = useRef<Audio.Sound | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const stop = async () => {
    generation.current++;
    controller.current?.abort();
    const current = sound.current; sound.current = null;
    await current?.unloadAsync().catch(() => {});
  };
  useEffect(() => () => { void stop(); }, [messageId]);
  const playChunk = async (index: number, run: number): Promise<void> => {
    setPhase('loading');
    controller.current = new AbortController();
    try {
      const clip = await voiceApi.synthesize(messageId, index, controller.current.signal);
      if (run !== generation.current) return;
      if (!clip.ok || clip.message_id !== messageId || clip.chunk_index !== index || clip.audio_mime_type !== 'audio/wav') throw new Error('Invalid spoken response.');
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      const created = await Audio.Sound.createAsync({ uri: `data:${clip.audio_mime_type};base64,${clip.audio_base64}` }, { shouldPlay: false });
      if (run !== generation.current) { await created.sound.unloadAsync(); return; }
      sound.current = created.sound;
      created.sound.setOnPlaybackStatusUpdate((status) => {
        if (run !== generation.current) return;
        if (!status.isLoaded) {
          if (status.error) { setError('Audio playback failed. Retry to start again.'); setPhase('error'); }
          return;
        }
        if (status.didJustFinish) {
          created.sound.setOnPlaybackStatusUpdate(null);
          void created.sound.unloadAsync(); sound.current = null;
          if (index + 1 < clip.chunk_count) void playChunk(index + 1, run);
          else setPhase('idle');
        }
      });
      await created.sound.playAsync(); setPhase('playing');
    } catch (err) {
      if (run !== generation.current) return;
      setError(err instanceof Error ? err.message : 'Speech unavailable'); setPhase('error');
    }
  };
  const toggle = async () => {
    try {
      if (phase === 'playing') { await sound.current?.pauseAsync(); setPhase('paused'); }
      else if (phase === 'paused') { await sound.current?.playAsync(); setPhase('playing'); }
      else { await stop(); setError(''); void playChunk(0, generation.current); }
    } catch { setError('Playback failed. Retry to start again.'); setPhase('error'); }
  };
  return <View>
    <View style={{ flexDirection: 'row' }}>
      <IconButton icon={phase === 'playing' ? 'pause' : 'volume-high-outline'} label={phase === 'paused' ? 'Resume spoken response' : phase === 'playing' ? 'Pause spoken response' : 'Play spoken response'} size={18} disabled={phase === 'loading'} onPress={() => void toggle()} />
      {phase !== 'idle' && <IconButton icon="stop" label="Stop spoken response" size={18} onPress={() => { void stop(); setPhase('idle'); }} />}
    </View>
    {phase === 'loading' && <Text variant="caption">Generating speech…</Text>}
    {!!error && <Text variant="caption">{error}</Text>}
  </View>;
}
