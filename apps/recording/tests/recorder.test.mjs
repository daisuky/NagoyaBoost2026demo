import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const moduleUrl = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const source = ts.transpileModule(await readFile(new URL('../src/adapters/recorder.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { startRecorder } = await import(moduleUrl(source.replace('./storage', moduleUrl('export const store = { put: (...a) => globalThis.recorderStore.put(...a), append: (...a) => globalThis.recorderStore.append(...a), audio: (...a) => globalThis.recorderStore.audio(...a) };'))));

class Node {
  connections = []; disconnected = false;
  connect(target) { this.connections.push(target); return target; }
  disconnect() { this.disconnected = true; }
}
function fixture() {
  const contexts = [], recorders = [], chunks = [], errors = [];
  const input = () => ({ stopped: false, stop() { this.stopped = true; } });
  globalThis.AudioContext = class {
    state = 'suspended'; sources = []; gains = []; destination = new Node();
    constructor() { contexts.push(this); }
    createMediaStreamDestination() { this.output = Object.assign(new Node(), { stream: { getTracks: () => [this.outputTrack ||= input()] } }); return this.output; }
    createMediaStreamSource(stream) { const node = Object.assign(new Node(), { stream }); this.sources.push(node); return node; }
    createGain() { const gain = Object.assign(new Node(), { gain: { value: 1 } }); this.gains.push(gain); return gain; }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; this.onstatechange?.(); }
  };
  globalThis.MediaRecorder = class {
    state = 'inactive';
    constructor(stream) { this.stream = stream; recorders.push(this); }
    start(timeslice) { this.state = 'recording'; this.timeslice = timeslice; this.ondataavailable({ data: new Blob(['first']) }); }
    stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['tail']) }); this.onstop(); }
  };
  globalThis.recorderStore = { put: async () => {}, append: async (_id, _track, index, data) => { chunks[index] = data; }, audio: async () => new Blob(chunks) };
  const inputs = [input(), input()];
  const tracks = inputs.map((track, i) => ({ stream: { getTracks: () => [track] }, speakerId: i ? 'guest' : 'host', speakerName: i ? 'B' : 'A' }));
  const recording = { id: crypto.randomUUID(), tracks: [], state: 'recording', mimeType: 'audio/webm', events: [] };
  return { contexts, recorders, chunks, errors, inputs, recording, start: () => startRecorder(recording, tracks, message => errors.push(message)) };
}

test('two live inputs feed one mixed recording; stop flushes the tail without closing call inputs', async () => {
  const f = fixture(), recorder = await f.start(), context = f.contexts[0];
  assert.equal(f.recorders.length, 1); assert.equal(f.recorders[0].stream, context.output.stream);
  assert.equal(context.sources.length, 2); assert.equal(context.output.channelCount, 1);
  context.sources.forEach((source, i) => {
    assert.deepEqual(source.connections, [context.gains[i]]);
    assert.equal(context.gains[i].gain.value, 0.5);
    assert.deepEqual(context.gains[i].connections, [context.output]);
  });
  assert.equal(f.recording.tracks.length, 1); assert.equal(f.recording.tracks[0].speakerId, 'conversation');
  assert.deepEqual(f.recording.speakers.map(s => s.speakerId), ['host', 'guest']);
  const firstStop = recorder.stop('user'); assert.equal(recorder.stop('user'), firstStop); await firstStop;
  assert.equal(await new Blob(f.chunks).text(), 'firsttail');
  assert.equal(f.recording.state, 'local'); assert.equal(f.recording.audioBytes, 9);
  assert.equal(context.state, 'closed'); assert.equal(context.outputTrack.stopped, true);
  assert.ok(f.inputs.every(input => !input.stopped)); assert.deepEqual(f.errors, []);
});

test('actual audio-processing interruption is reported and retained as interrupted data', async () => {
  const f = fixture(), recorder = await f.start();
  f.contexts[0].state = 'interrupted'; f.contexts[0].onstatechange();
  assert.equal(f.errors.length, 1); await recorder.stop('recording-error');
  assert.equal(f.recording.state, 'interrupted'); assert.equal(f.recording.audioBytes, 9);
  assert.ok(f.inputs.every(input => !input.stopped));
});

test('failed recorder startup releases its graph without ending either call input', async () => {
  const f = fixture(); globalThis.MediaRecorder.prototype.start = () => { throw new Error('codec unavailable'); };
  await assert.rejects(f.start(), /codec unavailable/);
  assert.equal(f.contexts[0].state, 'closed'); assert.ok(f.inputs.every(input => !input.stopped));
  assert.equal(f.recording.state, 'interrupted');
});
