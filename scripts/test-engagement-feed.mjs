#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadFeedSnapshot() {
  const filename = `${process.cwd()}/lib/feedSnapshot.ts`;
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  const context = vm.createContext({ console });
  new vm.Script(`(function(exports, module) { ${output}\n})`, { filename }).runInContext(context)(module.exports, module);
  return module.exports;
}

test('feed snapshots adopt engagement changes even when rank and membership stay unchanged', () => {
  const { feedSnapshotEqual } = loadFeedSnapshot();
  const original = { id: 'post-1', commentCount: 1, reactions: { loved: 2 } };
  const updated = { ...original, commentCount: 2, reactions: { loved: 3 } };
  assert.equal(feedSnapshotEqual([{ post: original }], [{ post: original }]), true);
  assert.equal(feedSnapshotEqual([{ post: original }], [{ post: updated }]), false);
  assert.equal(feedSnapshotEqual([{ post: updated }], [{ post: original }]), false);
});

test('post-card reaction breakdown cannot squeeze the primary action row', () => {
  const source = fs.readFileSync('components/feed/PostCard.tsx', 'utf8');
  const summary = source.indexOf('<ReactionSummary counts={post.reactions} style={styles.reactionSummary} />');
  const actions = source.indexOf('<View style={styles.actions}>');
  assert.ok(summary >= 0 && summary < actions, 'reaction summary must be above, not inside, the action row');
  assert.equal(source.indexOf('<ReactionSummary counts={post.reactions} />'), -1);
  assert.match(source, /actions: \{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'/);
  assert.match(source, /action: \{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44, minWidth: 40/);
});

test('authenticated health checks use the Rork bearer bridge, not an unrelated Supabase session', () => {
  const source = fs.readFileSync('lib/api/client.ts', 'utf8');
  const start = source.indexOf('export async function probeBackend');
  const end = source.indexOf('export async function exchangeRorkToken', start);
  const probe = source.slice(start, end).replace(/\/\/[^\n]*/g, '');
  assert.ok(probe.includes('ensureBackendSessionToken()'));
  assert.ok(!probe.includes('supabase.auth.getSession()'));
  assert.ok(probe.includes("supabase.rpc('get_bootstrap')"));
});
