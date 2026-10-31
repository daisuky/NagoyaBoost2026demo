import { b64, unb64, publicId, sign, verifyCertificate, verifyEnvelope, digest, confirmationCode } from '../../shared/identity-crypto.mjs';
import type { Credentials } from './types';
export type Certificate = { root: string; chain: { key: string; signature: string }[] };
export type Identity = { privateKey: CryptoKey; certificate: Certificate; userId: string; deviceId: string };
export type Contact = { userId: string; root: string; name: string; confirmed: boolean };
type Exchange = { id: string; secret: string; ownerRoot: string; ownerName: string; expiresAt?: number };
type LocalState = { name: string; contacts: Contact[]; exchanges: Record<string, Exchange>; enrollment?: { id: string; secret: string; key: string; expiresAt: number } };
export type Ring = { id: string; caller: string; callee: string; callerDevice: string; answeredBy?: string; state: string; expiresAt: number; room: string; push: string; offer: any };
export type Directory = { self: string; deviceId: string; contacts: { userId: string }[]; exchanges: { id: string; owner: string; claimant?: string; ownerRoot: string; claimantRoot?: string; card?: string; approvals: string[]; expiresAt: number }[]; devices: { id: string }[]; calls: Ring[]; notifications: boolean };
export type Health = { enabled: boolean; protocol: string; pushConfigured: boolean; publicKey: string };
export type RingResult = { call: Ring; credentials: Credentials };
const base = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
let database: Promise<IDBDatabase> | undefined;
const db = () => database ||= new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open('ippo-identity-v1', 1);
  let settled = false;
  const fail = (error: unknown) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
  const timer = setTimeout(() => fail(new Error('保存領域を開けませんでした。他の画面を閉じて再確認してください。')), 4000);
  req.onupgradeneeded = () => req.result.createObjectStore('local');
  req.onsuccess = () => {
    if (settled) { req.result.close(); return; }
    settled = true; clearTimeout(timer);
    req.result.onversionchange = () => { req.result.close(); database = undefined; };
    resolve(req.result);
  };
  req.onerror = () => fail(req.error); req.onblocked = () => fail(new Error('別の画面が保存領域の更新を待たせています。'));
}).catch(error => { database = undefined; throw error; });
async function read<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => { void db().then(d => { const tx = d.transaction('local'); const req = tx.objectStore('local').get(key); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }).catch(reject); });
}
async function write(key: string, value: unknown) {
  const d = await db(); await new Promise<void>((resolve, reject) => { const tx = d.transaction('local', 'readwrite'); tx.objectStore('local').put(value, key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
}
export const localBook = {
  async get(): Promise<LocalState> { return await read<LocalState>('book') || { name: '', contacts: [], exchanges: {} }; },
  put: (value: LocalState) => write('book', value)
};
export async function getIdentity() { return read<Identity>('identity'); }
export async function probeIdentityStorage() {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([(async () => {
      const d = await db(), key = `probe-${crypto.randomUUID()}`;
      await new Promise<void>((resolve, reject) => {
        const tx = d.transaction('local', 'readwrite'), local = tx.objectStore('local');
        local.put('ok', key);
        const readback = local.get(key);
        readback.onsuccess = () => { if (readback.result !== 'ok') tx.abort(); else local.delete(key); };
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('保存確認が中断されました'));
      });
    })(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('保存領域の確認がタイムアウトしました')), 5000); })]);
  } finally { clearTimeout(timeout); }
}
export async function prepareIdentity(): Promise<Identity> {
  const existing = await getIdentity(); if (existing) return existing;
  // Browser WebCrypto stores a non-extractable private CryptoKey in IndexedDB.
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const root = b64(await crypto.subtle.exportKey('raw', keys.publicKey));
  const userId = await publicId(root);
  const identity: Identity = { privateKey: keys.privateKey, certificate: { root, chain: [] }, userId, deviceId: userId };
  // Atomic read/insert also works in browsers without Web Locks.
  const d = await db();
  return new Promise<Identity>((resolve, reject) => {
    const tx = d.transaction('local', 'readwrite'), store = tx.objectStore('local'), req = store.get('identity'); let selected = identity;
    req.onsuccess = () => { if (req.result) selected = req.result; else store.put(identity, 'identity'); };
    tx.oncomplete = () => resolve(selected); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
export async function resetLocalIdentity() {
  const d = await db();
  await new Promise<void>((resolve, reject) => { const tx = d.transaction('local', 'readwrite'); tx.objectStore('local').delete('identity'); tx.objectStore('local').delete('book'); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('初期化が中断されました')); });
}
export async function signedEnvelope(endpoint: string, action: string, fields: Record<string, unknown>, identity?: Identity) {
  const me = identity || await prepareIdentity();
  const data = { audience: `ippo-${endpoint}-v1`, action, fields, at: Date.now(), nonce: crypto.randomUUID() };
  return { certificate: me.certificate, data, signature: await sign(me.privateKey, data) };
}
export async function identityApi<T = Directory>(endpoint: 'contacts' | 'incoming', action: string, fields: Record<string, unknown> = {}): Promise<T> {
  const body = action === 'health' ? { action } : { envelope: await signedEnvelope(endpoint, action, fields) };
  const response = await fetch(`${base}/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error || '接続できません'), { status: response.status }); return result;
}
const randomSecret = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const encode = (value: unknown) => b64(new TextEncoder().encode(JSON.stringify(value)));
const decode = (value: string) => JSON.parse(new TextDecoder().decode(unb64(value)));
const linkFor = (kind: string, value: unknown) => `${base || location.origin}/#${kind}=${encode(value)}`;
export function readCard(value: string) {
  if (value.length > 6000) throw new Error('リンクが長すぎます');
  const x = decode(value);
  if (!/^[a-f0-9-]{36}$/.test(x.id || '') || !/^[A-Za-z0-9_-]{43}$/.test(x.secret || '')) throw new Error('リンクを確認してください');
  return x;
}
async function seal(secret: string, value: unknown) {
  const key = await crypto.subtle.importKey('raw', unb64(secret), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return `${b64(iv)}.${b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value))))}`;
}
async function open(secret: string, ciphertext: string) {
  const [iv, data] = ciphertext.split('.');
  const key = await crypto.subtle.importKey('raw', unb64(secret), 'AES-GCM', false, ['decrypt']);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(data))));
}
export async function makeContactLink() {
  const me = await prepareIdentity(), book = await localBook.get();
  if (!book.name.trim()) throw new Error('この端末だけに保存する表示名を入力してください');
  const exchange: Exchange = { id: crypto.randomUUID(), secret: randomSecret(), ownerRoot: me.certificate.root, ownerName: book.name };
  // Save first so a lost network response never loses the secret needed to receive the reply.
  book.exchanges[exchange.id] = exchange; await localBook.put(book);
  const result = await identityApi<{ expiresAt: number }>('contacts', 'exchange-create', { id: exchange.id, token: await digest(exchange.secret) });
  exchange.expiresAt = result.expiresAt;
  return linkFor('contact', exchange);
}
export async function claimContact(value: string) {
  const card = readCard(value) as Exchange;
  if (typeof card.ownerName !== 'string' || card.ownerName.length > 40 || typeof card.ownerRoot !== 'string') throw new Error('連絡先を確認してください');
  const ownerId = await publicId(card.ownerRoot); await verifyCertificate({ root: card.ownerRoot, chain: [] });
  const me = await prepareIdentity(), book = await localBook.get();
  if (!book.name.trim()) throw new Error('先に自分の表示名を入力してください');
  const previous = book.contacts.find(c => c.userId === ownerId);
  if (previous && previous.root !== card.ownerRoot) throw new Error('相手の鍵が変わっています。LINEで再確認してください');
  book.exchanges[card.id] = card;
  if (!previous) book.contacts.push({ userId: ownerId, root: card.ownerRoot, name: card.ownerName, confirmed: false });
  await localBook.put(book);
  let result: Directory;
  try { result = await identityApi('contacts', 'exchange-claim', { id: card.id, token: await digest(card.secret), card: await seal(card.secret, { root: me.certificate.root, name: book.name }) }); }
  catch (error) {
    if ((error as { status?: number }).status === 410) throw Object.assign(new Error('この登録リンクは利用できません。期限切れ・使用済み・無効などが考えられます。招待した方に新しいリンクを作ってもらってください。'), { status: 410 });
    throw error;
  }
  const server = result.exchanges.find(x => x.id === card.id);
  if (server?.ownerRoot !== card.ownerRoot || server?.claimantRoot !== me.certificate.root) throw new Error('連絡先の鍵が一致しません。承認せずLINEで確認してください');
  return result;
}
export async function exchangeDetails(x: Directory['exchanges'][number]) {
  const me = await prepareIdentity(), book = await localBook.get(), saved = book.exchanges[x.id];
  if (!saved || !x.claimantRoot || !x.claimant) return null;
  if (saved.ownerRoot !== x.ownerRoot || await publicId(x.ownerRoot) !== x.owner || await publicId(x.claimantRoot) !== x.claimant) throw new Error('連絡先の鍵が一致しません');
  const mine = x.owner === me.userId;
  if (mine && x.ownerRoot !== me.certificate.root || !mine && x.claimantRoot !== me.certificate.root) throw new Error('自分の鍵が一致しません');
  const other = mine ? await open(saved.secret, x.card!) : { root: saved.ownerRoot, name: saved.ownerName };
  const root = mine ? x.claimantRoot : x.ownerRoot, userId = mine ? x.claimant : x.owner;
  if (other.root !== root || typeof other.name !== 'string' || !other.name.trim() || other.name.length > 40) throw new Error('連絡先の内容を確認できません');
  return { id: x.id, userId, root, name: other.name, code: await confirmationCode(x.id, x.ownerRoot, x.claimantRoot), mine: x.approvals.includes(me.userId) };
}
export async function approveContact(x: Directory['exchanges'][number]) {
  const contact = await exchangeDetails(x); if (!contact) throw new Error('連絡先交換の情報がありません');
  const book = await localBook.get(), previous = book.contacts.find(c => c.userId === contact.userId);
  if (previous && previous.root !== contact.root) throw new Error('相手の鍵が変わっています');
  if (previous) previous.confirmed = true;
  else book.contacts.push({ userId: contact.userId, name: contact.name, root: contact.root, confirmed: true });
  await localBook.put(book);
  return identityApi('contacts', 'exchange-approve', { id: x.id });
}
export async function createEnrollment() {
  const me = await prepareIdentity();
  const book = await localBook.get();
  book.enrollment = { id: crypto.randomUUID(), secret: randomSecret(), key: me.certificate.chain.at(-1)?.key || me.certificate.root, expiresAt: Date.now() + 600000 };
  await localBook.put(book); return linkFor('device', book.enrollment);
}
export async function approveEnrollment(value: string) {
  const request = readCard(value), me = await prepareIdentity(), book = await localBook.get();
  if (!Number.isSafeInteger(request.expiresAt) || request.expiresAt <= Date.now() || request.expiresAt > Date.now() + 660000 || typeof request.key !== 'string' || request.key === me.certificate.root) throw new Error('端末追加用QRが期限切れ、または無効です');
  if (me.certificate.chain.length >= 8) throw new Error('追加できる承認の段数に達しました。最初の端末から追加してください');
  await verifyCertificate({ root: request.key, chain: [] });
  const parent = me.certificate.chain.at(-1)?.key || me.certificate.root;
  const step = { key: request.key, signature: await sign(me.privateKey, { purpose: 'ippo-device-v1', root: me.certificate.root, parent, key: request.key }) };
  const certificate = { root: me.certificate.root, chain: [...me.certificate.chain, step] };
  return identityApi('contacts', 'enroll-approve', { id: request.id, token: await digest(request.secret), certificate, book: await seal(request.secret, { root: me.certificate.root, name: book.name, contacts: book.contacts }) });
}
export async function receiveEnrollment() {
  const book = await localBook.get(), e = book.enrollment; if (!e) return false;
  if (e.expiresAt < Date.now()) { delete book.enrollment; await localBook.put(book); throw new Error('端末追加の有効期限が切れました。QRを作り直してください'); }
  const result = await identityApi<{ certificate: Certificate | null; book?: string }>('contacts', 'enroll-result', { id: e.id, token: await digest(e.secret) });
  if (!result.certificate) return false;
  const cert = await verifyCertificate(result.certificate), me = await prepareIdentity();
  if (cert.publicKey !== e.key || cert.deviceId !== me.deviceId || !result.certificate.chain.length) throw new Error('承認された端末の鍵が一致しません');
  const transferred = await open(e.secret, result.book!);
  if (transferred.root !== result.certificate.root || !Array.isArray(transferred.contacts) || transferred.contacts.length > 64 || typeof transferred.name !== 'string') throw new Error('電話帳を確認できません');
  for (const c of transferred.contacts) if (await publicId(c.root) !== c.userId || typeof c.name !== 'string') throw new Error('電話帳の鍵を確認できません');
  await write('identity', { ...me, certificate: result.certificate, userId: cert.userId });
  await localBook.put({ ...book, name: transferred.name, contacts: transferred.contacts, enrollment: undefined }); return true;
}
export async function verifyIncoming(call: Ring) {
  const book = await localBook.get(), c = book.contacts.find(x => x.userId === call.caller && x.confirmed);
  if (!c || c.root !== call.offer?.certificate?.root) throw new Error('電話帳に登録した相手の鍵と一致しません。応答できません');
  const actor = await verifyEnvelope(call.offer, 'ippo-incoming-v1');
  if (actor.userId !== c.userId || call.offer.data.action !== 'ring' || call.offer.data.fields.id !== call.id || call.offer.data.fields.userId !== (await prepareIdentity()).userId) throw new Error('着信の署名を確認できません');
}
