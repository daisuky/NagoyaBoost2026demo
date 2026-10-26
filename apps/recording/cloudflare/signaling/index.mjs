import { command } from '../../shared/session.mjs';
import { directoryCommand, pruneDirectory } from '../../shared/directory.mjs';
import { identityCommand, pruneIdentity } from '../../shared/identity-directory.mjs';
import { verifyEnvelope } from '../../shared/identity-crypto.mjs';
async function equalSecret(a, b) {
  const digest = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  const left = new Uint8Array(x), right = new Uint8Array(y);
  let different = 0; for (let i = 0; i < left.length; i++) different |= left[i] ^ right[i];
  return different === 0;
}
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!env.SIGNALING_SERVICE_SECRET || env.SIGNALING_SERVICE_SECRET.length < 32 || !await equalSecret(request.headers.get('Authorization') || '', `Bearer ${env.SIGNALING_SERVICE_SECRET}`)) return new Response('Unauthorized', { status: 401 });
    const path = new URL(request.url).pathname;
    if (path === '/directory') return env.DIRECTORY.get(env.DIRECTORY.idFromName('team')).fetch(request);
    if (path === '/identity-directory') return env.IDENTITY_DIRECTORY.get(env.IDENTITY_DIRECTORY.idFromName('identity-v1')).fetch(request);
    const match = path.match(/^\/rooms\/(ippo-[a-f0-9-]{36})$/);
    if (!match) return new Response('Not found', { status: 404 });
    return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
  }
};
export class CallRoom {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const raw = await request.text();
        if (raw.length > 24000) return Response.json({ error: '入力が長すぎます' }, { status: 413 });
        const previous = await this.ctx.storage.get('state');
        const result = command(previous, JSON.parse(raw));
        await this.ctx.storage.put('state', result.state);
        // Expiry never moves: avoid an extra billed write on every heartbeat.
        if (!previous) await this.ctx.storage.setAlarm(result.state.expiresAt);
        return Response.json(result.response, { headers: { 'Cache-Control': 'no-store' } });
      } catch (error) {
        return Response.json({ error: error.status ? error.message : '接続状態の更新に失敗しました' }, { status: error.status || 500 });
      }
    });
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}
export class ContactDirectory {
  constructor(ctx) { this.ctx = ctx; }
  async schedule(state) {
    const deadlines = Object.values(state.invites).map(i => i.expiresAt);
    for (const c of Object.values(state.calls)) {
      deadlines.push(c.createdAt + 86400000);
      if (['preparing', 'ringing'].includes(c.state)) deadlines.push(c.expiresAt);
      if (c.state === 'accepted') deadlines.push(c.sessionUntil);
    }
    const next = Math.min(...deadlines.filter(t => t > Date.now()));
    const current = await this.ctx.storage.getAlarm();
    if (Number.isFinite(next) && (current === null || current <= Date.now() || current > next)) await this.ctx.storage.setAlarm(next);
    if (!Number.isFinite(next) && current !== null) await this.ctx.storage.deleteAlarm();
  }
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const raw = await request.text();
        if (raw.length > 48000) return Response.json({ error: '入力が長すぎます' }, { status: 413 });
        const previous = await this.ctx.storage.get('state');
        const result = directoryCommand(previous, JSON.parse(raw));
        if (JSON.stringify(previous) !== JSON.stringify(result.state)) {
          await this.ctx.storage.put('state', result.state);
          await this.schedule(result.state);
        }
        return Response.json(result.response, { headers: { 'Cache-Control': 'no-store' } });
      } catch (error) { return Response.json({ error: error.status ? error.message : '呼び出し情報を更新できません' }, { status: error.status || 500 }); }
    });
  }
  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get('state'); if (!state) return;
      pruneDirectory(state, Date.now());
      await this.ctx.storage.put('state', state);
      await this.schedule(state);
    });
  }
}
export class IdentityDirectory {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const raw = await request.text();
        if (raw.length > 64000) return Response.json({ error: '入力が長すぎます' }, { status: 413 });
        const command = JSON.parse(raw);
        const actor = await verifyEnvelope(command.envelope, command.audience);
        const previous = await this.ctx.storage.get('state');
        const result = identityCommand(previous, { ...command, actor, nonce: command.envelope.data.nonce });
        if (previous || command.action !== 'enroll-result') {
          if (JSON.stringify(previous) !== JSON.stringify(result.state)) await this.ctx.storage.put('state', result.state);
          if (!['status', 'enroll-result'].includes(command.action) && await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 240000);
        }
        return Response.json(result.response, { headers: { 'Cache-Control': 'no-store' } });
      } catch (error) { return Response.json({ error: error.status ? error.message : '登録情報を更新できません' }, { status: error.status || 500 }); }
    });
  }
  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get('state'); if (!state) return;
      pruneIdentity(state, Date.now()); await this.ctx.storage.put('state', state);
      if (Object.keys(state.nonces).length || Object.keys(state.exchanges).length || Object.keys(state.enrollments).length || Object.keys(state.calls).length) await this.ctx.storage.setAlarm(Date.now() + 240000);
    });
  }
}
