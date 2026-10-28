import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const moduleUrl = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
let source = ts.transpileModule(await readFile(new URL('../src/adapters/drive.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
source = source.replace('import.meta.env.VITE_API_BASE_URL', "''")
  .replace('./storage', moduleUrl('export const store = { put: async () => {}, audio: async () => new Blob(["fixture-audio"], { type: "audio/webm" }) };'))
  .replace('../core/upload.mjs', moduleUrl('export async function sendResumable(url, blob) { globalThis.archiveBlobs.push(blob); return { id: "file-" + globalThis.archiveBlobs.length }; }'));
const { archive } = await import(moduleUrl(source));

for (const layout of ['conversation', 'legacy']) test(`${layout} uploads keep audio slots and manifest associations intact`, async t => {
  const fetcher = globalThis.fetch, slots = [];
  t.after(() => { globalThis.fetch = fetcher; });
  globalThis.archiveBlobs = [];
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer fixture-capability');
    const body = JSON.parse(options.body); slots.push(body.slot);
    return Response.json({ uploadUrl: 'https://www.googleapis.com/upload/fixture' });
  };
  const speakers = ['host', 'guest'];
  const recording = { id: crypto.randomUUID(), consultationId: 'fixture-room', title: '架空の会話', createdAt: new Date().toISOString(), state: 'local', mimeType: 'audio/webm', archiveAuth: 'fixture-capability', consent: [], events: [], driveFiles: {},
    tracks: (layout === 'conversation' ? ['conversation'] : speakers).map(speakerId => ({ id: speakerId + '-track', speakerId, speakerName: speakerId, chunkCount: 1 })),
    ...(layout === 'conversation' ? { audioLayout: 'conversation', speakers: speakers.map(speakerId => ({ speakerId, speakerName: speakerId })) } : {}) };
  await archive.upload(recording, () => {});
  assert.deepEqual(slots, layout === 'conversation' ? ['conversation', 'manifest'] : ['host', 'guest', 'manifest']);
  assert.equal(recording.state, 'saved');
  const manifest = JSON.parse(await globalThis.archiveBlobs.at(-1).text());
  assert.equal(manifest.audio_layout, layout === 'conversation' ? 'conversation' : 'speaker-separated');
  manifest.tracks.forEach((track, i) => assert.equal(track.file_id, 'file-' + (i + 1)));
  assert.equal(manifest.archiveAuth, undefined);
  if (layout === 'conversation') assert.equal(manifest.speakers.length, 2);
});
