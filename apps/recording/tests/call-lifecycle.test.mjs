import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { command } from '../shared/session.mjs';

// Run the real controller with browser media/DOM boundaries replaced. Recording
// and codec behavior remain covered by the real-browser QA page.
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
let source = ts.transpileModule(await readFile(new URL('../src/adapters/call.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
source = source.replace('../core/api', moduleUrl('export const api = () => { throw Error("Use the injected API"); };'))
  .replace('./recorder', moduleUrl('export const recordingMime = () => "audio/webm"; export const startRecorder = async recording => ({stop: async reason => {recording.state="local"; recording.events.push({reason});}});'))
  .replace('../core/quality.mjs', new URL('../src/core/quality.mjs', import.meta.url).href);
const { CallController } = await import(moduleUrl(source));

class Stream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
}
class Peer {
  connectionState = 'new'; signalingState = 'stable';
  constructor(configuration) { this.configuration = configuration; }
  addTrack() {}
  close() { this.connectionState = 'closed'; }
  getConfiguration() { return this.configuration; }
  getSenders() { return [this.sender ||= { track: { kind: 'audio' }, async replaceTrack(track) { this.track = track; } }]; }
  async createOffer() { return { type: 'offer', sdp: 'lifecycle test' }; }
  async setLocalDescription(description) { this.localDescription = { ...description, toJSON: () => description }; this.signalingState = 'have-local-offer'; }
}
function fixture(t, options = {}) {
  globalThis.MediaStream = Stream; globalThis.RTCPeerConnection = Peer;
  globalThis.document = { visibilityState: 'visible', body: { append() {} }, createElement: () => ({ style: {}, play: async () => {}, remove() {} }) };
  let state, now = 100000;
  const streams = [], requests = [], errors = [];
  const actors = { host: { role: 'host', participantId: randomUUID() }, guest: { role: 'guest', participantId: randomUUID() } };
  const apply = (action, actor, payload = {}) => { const result = command(state, { action, actor, payload }, now); state = result.state; return result.response; };
  const media = async () => {
    const track = { kind: 'audio', readyState: 'live', stop() { this.readyState = 'ended'; } };
    const stream = new Stream([track]); streams.push(stream); return stream;
  };
  const request = async (action, fields = {}, auth) => {
    requests.push(action);
    if (action === 'heartbeat' && options.failHeartbeat) throw Object.assign(new Error('監視接続エラー'), { status: options.heartbeatStatus || 502 });
    if (action === 'create') return { role: 'host', participantId: actors.host.participantId, auth: 'host', iceServers: [], invite: 'test-invite', status: apply('create', actors.host, fields) };
    return apply(action, actors[auth], fields);
  };
  const call = new CallController(() => {}, message => errors.push(message), options.saved || (() => {}), { request, media: options.media || media, playbackMuted: true });
  t.after(async () => { await call.leave(false); });
  return { call, streams, requests, errors, state: () => state, join: () => apply('join', actors.guest, { name: 'guest' }), endPeer: () => apply('leave', actors.guest), advance: ms => { now += ms; }, media,
    prepareRecording: () => {
      for (const actor of Object.values(actors)) { apply('heartbeat', actor, { connected: true }); call.accept(apply('consent', actor, { allowed: true })); }
      call.pc.connectionState = 'connected'; call.remote = new Stream([{ readyState: 'live', stop() {} }]);
    }
  };
}

test('microphone permission preparation is not cancelled by a temporary hidden page', async t => {
  const deferred = Promise.withResolvers();
  const f = fixture(t, { media: () => deferred.promise });
  const pending = f.call.connect('create', { name: 'host' });
  document.visibilityState = 'hidden'; await f.call.visibility(false);
  assert.equal(f.call.closed, false); assert.equal(f.requests.length, 0);
  document.visibilityState = 'visible'; deferred.resolve(await f.media()); await pending;
  assert.equal(f.call.closed, false); assert.ok(f.call.credentials.invite);
});

test('accepted member calls reuse issued credentials without creating another room or recording', async t => {
  const f = fixture(t);
  const credentials = await f.call.request('create', { name: 'host' });
  await f.call.connect('create', {}, credentials);
  assert.equal(f.requests.filter(action => action === 'create').length, 1);
  assert.equal(f.call.credentials.participantId, credentials.participantId);
  assert.equal(f.streams.length, 1); assert.equal(f.requests.includes('start'), false);
});

test('remote hangup finalizes recording as a normal call end and schedules its saved callback once', async t => {
  const saved = [];
  const f = fixture(t, { saved: () => saved.push(f.call.recording.events.at(-1).reason) });
  await f.call.connect('create', { name: 'host' }); f.join(); f.prepareRecording();
  await f.call.start('remote hangup');
  f.call.accept(f.endPeer()); await f.call.operation;
  assert.equal(f.call.closed, true); assert.deepEqual(saved, ['call-ended']);
  assert.equal(f.call.recording.state, 'local'); assert.equal(f.call.recorder, undefined);
});

test('a normal server recording stop remains eligible for automatic upload', async t => {
  const f = fixture(t); await f.call.connect('create', { name: 'host' }); f.join(); f.prepareRecording();
  await f.call.start('server stop');
  f.call.accept({ ...f.call.status, version: f.call.status.version + 1, allowed: true, recording: false });
  await f.call.operation;
  assert.equal(f.call.closed, false); assert.equal(f.call.recording.events.at(-1).reason, 'user');
});

test('cancelled microphone preparation rejects instead of reporting a successful connection', async t => {
  const deferred = Promise.withResolvers();
  const f = fixture(t, { media: () => deferred.promise });
  const pending = f.call.connect('create', { name: 'host' });
  await f.call.leave(false); deferred.resolve(await f.media());
  await assert.rejects(pending, /開始を中断/);
  assert.equal(f.streams[0].getTracks()[0].readyState, 'ended');
  assert.equal(f.requests.includes('create'), false);
});

test('a temporary supervision failure preserves the room and recovers on the next heartbeat', async t => {
  const options = { failHeartbeat: true };
  const f = fixture(t, options); await f.call.connect('create', { name: 'host' });
  assert.equal(f.call.closed, false); assert.ok(f.call.timer); assert.equal(f.state().ended, false);
  assert.ok(f.call.recoveryStarted); assert.equal(f.streams[0].getTracks()[0].readyState, 'live');
  options.failHeartbeat = false; await f.call.poll();
  assert.equal(f.call.recoveryStarted, 0); assert.equal(f.call.closed, false);
});

test('a terminal supervision failure rejects startup and does not install polling timers', async t => {
  const f = fixture(t, { failHeartbeat: true, heartbeatStatus: 410 });
  await assert.rejects(f.call.connect('create', { name: 'host' }), /通話が終了したか/);
  assert.equal(f.call.closed, true); assert.equal(f.call.timer, undefined); assert.equal(f.call.statsTimer, undefined);
  assert.equal(f.state().ended, true); assert.equal(f.streams[0].getTracks()[0].readyState, 'ended');
});

test('sending an unused invitation releases the microphone, keeps the room and resumes with a waiting guest', async t => {
  const f = fixture(t); await f.call.connect('create', { name: 'host' });
  document.visibilityState = 'hidden'; await f.call.visibility(false);
  assert.equal(f.call.closed, false); assert.equal(f.state().ended, false);
  assert.equal(f.call.waitingSuspended, true); assert.equal(f.call.pc, undefined);
  assert.equal(f.streams[0].getTracks()[0].readyState, 'ended');
  f.advance(60000); f.join(); const count = f.requests.length; await f.call.poll();
  assert.equal(f.requests.length, count); assert.equal(f.call.generation, 0);
  document.visibilityState = 'visible'; await f.call.visibility(true);
  assert.equal(f.call.closed, false); assert.equal(f.call.waitingSuspended, false);
  assert.equal(f.call.generation, 1); assert.equal(f.streams[1].getTracks()[0].readyState, 'live');
  assert.equal(f.state().recording, false);
});

test('leaving the page after negotiation starts keeps the room, microphone and peer connection', async t => {
  const f = fixture(t); await f.call.connect('create', { name: 'host' }); f.join(); await f.call.poll();
  const peer = f.call.pc;
  document.visibilityState = 'hidden'; await f.call.visibility(false);
  assert.equal(f.call.closed, false); assert.equal(f.state().ended, false); assert.equal(f.call.pc, peer);
  assert.match(f.call.message, /同じ通話と録音を継続/);
  assert.equal(f.streams[0].getTracks()[0].readyState, 'live');
});

test('resuming invitation preparation never retains a microphone when permission resolves in the background', async t => {
  const f = fixture(t); await f.call.connect('create', { name: 'host' });
  document.visibilityState = 'hidden'; await f.call.visibility(false);
  const deferred = Promise.withResolvers(); f.call.media = () => deferred.promise;
  document.visibilityState = 'visible'; const pending = f.call.visibility(true);
  document.visibilityState = 'hidden'; await f.call.visibility(false); deferred.resolve(await f.media()); await pending;
  assert.equal(f.call.waitingSuspended, true); assert.equal(f.call.closed, false);
  assert.equal(f.streams[1].getTracks()[0].readyState, 'ended');
  f.call.media = f.media; document.visibilityState = 'visible'; await f.call.visibility(true);
  assert.equal(f.call.waitingSuspended, false); assert.equal(f.streams[2].getTracks()[0].readyState, 'live');
});

test('resuming invitation preparation preserves the host microphone mute setting', async t => {
  const f = fixture(t); await f.call.connect('create', { name: 'host' }); await f.call.mute();
  document.visibilityState = 'hidden'; await f.call.visibility(false);
  document.visibilityState = 'visible'; await f.call.visibility(true);
  assert.equal(f.call.muted, true); assert.equal(f.streams[1].getTracks()[0].enabled, false);
});

test('a transport failure during resume releases the newly acquired microphone and ends the room', async t => {
  const f = fixture(t); await f.call.connect('create', { name: 'host' });
  document.visibilityState = 'hidden'; await f.call.visibility(false);
  globalThis.RTCPeerConnection = class { constructor() { throw new Error('transport failed'); } };
  document.visibilityState = 'visible'; await f.call.visibility(true);
  assert.equal(f.call.closed, true); assert.equal(f.state().ended, true);
  assert.equal(f.streams[1].getTracks()[0].readyState, 'ended');
  assert.match(f.errors[0], /transport failed/);
});

test('a delayed pre-start heartbeat does not cancel recording while the start response is in flight', async t => {
  const f = fixture(t); await f.call.connect('create', { name: 'host' }); f.join(); f.prepareRecording(); await f.call.operation;
  const request = f.call.request;
  const oldHeartbeat = await request('heartbeat', { connected: true }, 'host');
  const started = Promise.withResolvers(), deliver = Promise.withResolvers();
  f.call.request = async (action, fields, auth) => {
    const response = await request(action, fields, auth);
    if (action === 'start') { started.resolve(); await deliver.promise; }
    return response;
  };
  const starting = f.call.start('録音の競合検証'); await started.promise;
  f.call.accept(oldHeartbeat); deliver.resolve(); await starting;
  assert.ok(f.call.recorder, 'the successful start must retain a recorder');
  assert.equal(f.state().recording, true); assert.equal(f.call.closed, false);
});

for (const action of ['consent', 'stop']) test(`a newer ${action} cancellation still prevents recording while the start response is in flight`, async t => {
  const f = fixture(t); await f.call.connect('create', { name: 'host' }); f.join(); f.prepareRecording(); await f.call.operation;
  const request = f.call.request;
  const started = Promise.withResolvers(), deliver = Promise.withResolvers();
  f.call.request = async (action, fields, auth) => {
    const response = await request(action, fields, auth);
    if (action === 'start') { started.resolve(); await deliver.promise; }
    return response;
  };
  const starting = f.call.start('録音の取消検証'); await started.promise;
  f.call.accept(await request(action, action === 'consent' ? { allowed: false } : {}, 'guest'));
  deliver.resolve(); await starting;
  assert.equal(f.call.recorder, undefined); assert.equal(f.state().recording, false);
});

test('backgrounding and restoring a recording host preserves the same recorder, consent and voice connection', async t => {
  const f = fixture(t); await f.call.connect('create', { name: 'host' }); f.join(); f.prepareRecording(); await f.call.operation;
  // A connected real call has already exchanged its first offer/answer.
  f.call.generation = 1; f.state().generation = 1;
  await f.call.start('画面切替'); assert.ok(f.call.recorder);
  const peer = f.call.pc, recorder = f.call.recorder, id = f.call.recording.id;
  const stops = f.requests.filter(action => action === 'stop').length;
  document.visibilityState = 'hidden'; await f.call.visibility(false);
  assert.equal(f.call.recorder, recorder); assert.equal(f.state().recording, true); assert.equal(f.call.closed, false);
  assert.equal(f.call.status.participants.find(p => p.identity === 'host').connected, true);
  assert.equal(f.call.pc, peer); assert.equal(f.streams[0].getTracks()[0].readyState, 'live');
  document.visibilityState = 'visible'; await f.call.visibility(true);
  assert.equal(f.call.recorder, recorder); assert.equal(f.call.closed, false); assert.equal(f.call.pc, peer);
  assert.equal(f.call.recording.id, id); assert.equal(f.state().recording, true);
  assert.equal(f.requests.filter(action => action === 'stop').length, stops);
});

test('backgrounding a guest preserves server recording and reports actual media connectivity', async t => {
  const f = fixture(t); await f.call.connect('create', { name: 'host' }); f.join(); f.prepareRecording(); await f.call.operation;
  await f.call.request('start', {}, 'host');
  f.call.credentials = { ...f.call.credentials, role: 'guest', auth: 'guest' };
  document.visibilityState = 'hidden'; await f.call.visibility(false);
  assert.equal(f.state().recording, true); assert.equal(f.state().ended, false); assert.equal(f.call.closed, false);
  assert.equal(f.state().participants.guest.connected, true);
  document.visibilityState = 'visible'; await f.call.visibility(true);
  assert.equal(f.state().recording, true);
});

test('recording cannot start from a background page', async t => {
  const f = fixture(t); await f.call.connect('create', { name: 'host' }); f.join(); f.prepareRecording(); await f.call.operation;
  document.visibilityState = 'hidden'; f.call.pageVisible = false;
  await assert.rejects(f.call.start('背景録音'), /通話画面に戻って/);
  assert.equal(f.call.recorder, undefined); assert.equal(f.state().recording, false);
});

test('switching apps during an explicitly requested start does not cancel that start', async t => {
  const f = fixture(t); await f.call.connect('create', { name: 'host' }); f.join(); f.prepareRecording(); await f.call.operation;
  f.call.generation = 1; f.state().generation = 1;
  const request = f.call.request, started = Promise.withResolvers(), deliver = Promise.withResolvers();
  f.call.request = async (action, fields, auth) => {
    const response = await request(action, fields, auth);
    if (action === 'start') { started.resolve(); await deliver.promise; }
    return response;
  };
  const starting = f.call.start('画面切替中の開始'); await started.promise;
  document.visibilityState = 'hidden'; await f.call.visibility(false); deliver.resolve(); await starting;
  assert.ok(f.call.recorder); assert.equal(f.state().recording, true); assert.equal(f.call.closed, false);
});

test('a prolonged signaling outage does not end voice when moving between foreground and background', async t => {
  const options = { failHeartbeat: true }; const f = fixture(t, options);
  await f.call.connect('create', { name: 'host' });
  f.call.pageVisible = false; f.call.recoveryStarted = Date.now() - 100000; await f.call.poll();
  assert.equal(f.call.closed, false);
  f.call.pageVisible = true; await f.call.poll();
  assert.equal(f.call.closed, false); assert.equal(f.state().ended, false);
  assert.equal(f.call.local.getTracks()[0].readyState, 'live');
});

test('returning to a connected call replaces an OS-ended microphone and preserves mute', async t => {
  const f = fixture(t); await f.call.connect('create', { name: 'host' }); f.join(); f.prepareRecording(); await f.call.operation;
  await f.call.mute(); const peer = f.call.pc;
  document.visibilityState = 'hidden'; await f.call.visibility(false);
  f.call.local.getTracks().forEach(track => track.stop());
  document.visibilityState = 'visible'; await f.call.visibility(true);
  assert.equal(f.call.closed, false); assert.equal(f.call.pc, peer);
  assert.equal(peer.getSenders()[0].track, f.streams[1].getTracks()[0]);
  assert.equal(peer.getSenders()[0].track.enabled, false); assert.equal(f.call.recorder, undefined);
});

test('a guest recovery request can restart ICE when the host already uses TURN', async t => {
  const f = fixture(t); await f.call.connect('create', { name: 'host' }); f.join(); f.prepareRecording(); await f.call.operation;
  const peer = f.call.pc; peer.configuration.iceTransportPolicy = 'relay'; f.call.relayRequested = true;
  await f.call.receive({ type: 'relay-request', seq: 1, generation: 0, data: null });
  assert.equal(f.call.pc, peer); assert.equal(f.call.generation, 1);
  assert.equal(peer.signalingState, 'have-local-offer'); assert.equal(f.call.closed, false);
});

test('a pending browser playback request does not block return to the call', async t => {
  const f = fixture(t); await f.call.connect('create', { name: 'host' }); f.join(); f.prepareRecording(); await f.call.operation;
  f.call.audio.play = () => new Promise(() => {});
  document.visibilityState = 'hidden'; await f.call.visibility(false);
  document.visibilityState = 'visible';
  let timer;
  try {
    await Promise.race([f.call.visibility(true), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('playback blocked call restoration')), 1000); })]);
  } finally { clearTimeout(timer); }
  assert.equal(f.call.resumingCall, false); assert.equal(f.call.closed, false);
});
