import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
export { CONSENT_VERSION } from '../shared/session.mjs';
export function equal(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
export function issue(secret, payload, now = Date.now(), ttl = 2 * 60 * 60 * 1000) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: now + ttl })).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function verify(secret, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 4000) throw fail(401, '招待または参加情報を確認してください');
  const [body, signature, extra] = token.split('.');
  if (extra || !body || !signature || !equal(signature, createHmac('sha256', secret).update(body).digest('base64url'))) throw fail(401, '参加情報が無効です');
  let value; try { value = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw fail(401, '参加情報が無効です'); }
  if (!Number.isFinite(value.exp) || value.exp <= now || !/^ippo-[a-f0-9-]{36}$/.test(value.room) || !['host', 'guest'].includes(value.role)) throw fail(401, '招待の有効期限が切れています');
  return value;
}
export function fail(status, message) { return Object.assign(new Error(message), { status }); }
export function newRoom() { return `ippo-${randomUUID()}`; }
