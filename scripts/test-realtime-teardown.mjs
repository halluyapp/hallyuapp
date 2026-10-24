// Regression test for the "cannot add callbacks after subscribe()" Realtime error on the episode
// room. It models supabase-js's registry semantics: channel(topic) returns whatever is still
// registered under that topic, and removeChannel only unregisters after an async server ack.
// Runs under plain `node --test`; lib/realtimeTeardown.ts is transpiled on the fly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 } }).outputText;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hallyu-rt-'));
  const file = path.join(dir, path.basename(rel).replace(/\.ts$/, '.mjs'));
  fs.writeFileSync(file, out);
  return import(pathToFileURL(file).href);
}

const { closeChannelsForTopic } = await load('lib/realtimeTeardown.ts');

// Minimal registry with supabase-js semantics.
function fakeClient(serverAckMs = 20) {
  const channels = [];
  return {
    channels,
    channel(topic) {
      const realtimeTopic = `realtime:${topic}`;
      const existing = channels.find((c) => c.topic === realtimeTopic);
      if (existing) return existing;
      const ch = {
        topic: realtimeTopic,
        subscribed: false,
        on() {
          if (ch.subscribed) throw new Error(`cannot add callbacks to ${topic} after subscribe()`);
          return ch;
        },
        subscribe() {
          ch.subscribed = true;
          return ch;
        },
      };
      channels.push(ch);
      return ch;
    },
    getChannels() {
      return [...channels];
    },
    removeChannel(ch) {
      // The channel stays registered until the (async) server ack arrives.
      return new Promise((resolve) =>
        setTimeout(() => {
          const i = channels.indexOf(ch);
          if (i >= 0) channels.splice(i, 1);
          resolve('ok');
        }, serverAckMs),
      );
    },
  };
}

test('the old order reproduces the production error', async () => {
  const client = fakeClient();
  const first = client.channel('episode-watch-room:abc');
  first.on().subscribe();
  // Leave without waiting, then re-open immediately, as the room did before the fix.
  void client.removeChannel(first);
  const second = client.channel('episode-watch-room:abc');
  assert.equal(second, first, 'the still-registered channel is handed back');
  assert.throws(() => second.on(), /after subscribe/);
});

test('waiting for the previous teardown gives a fresh channel', async () => {
  const client = fakeClient();
  const first = client.channel('episode-watch-room:abc');
  first.on().subscribe();
  void client.removeChannel(first);
  await closeChannelsForTopic(client, 'episode-watch-room:abc');
  const second = client.channel('episode-watch-room:abc');
  assert.notEqual(second, first);
  assert.doesNotThrow(() => second.on().on().subscribe());
});

test('teardown waits for every stale channel on the topic and ignores other topics', async () => {
  const client = fakeClient();
  client.channel('episode-watch-room:abc').subscribe();
  client.channel('episode-watch-room:xyz').subscribe();
  await closeChannelsForTopic(client, 'episode-watch-room:abc');
  assert.deepEqual(client.getChannels().map((c) => c.topic), ['realtime:episode-watch-room:xyz']);
});

test('a failing removal does not block the reconnect', async () => {
  const client = fakeClient();
  client.channel('episode-watch-room:abc').subscribe();
  client.removeChannel = () => Promise.reject(new Error('socket closed'));
  await closeChannelsForTopic(client, 'episode-watch-room:abc');
  assert.ok(true);
});
