// Shared by browser, Vercel and Worker. No private keys cross this boundary.
const enc = new TextEncoder();
export const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export const unb64 = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
export const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export const digest = async value => b64(await crypto.subtle.digest('SHA-256', enc.encode(value)));
export async function publicId(key) { return digest(`ippo-key-v1:${key}`); }
export async function sign(key, data) { return b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(canonical(data)))); }
export async function verify(key, signature, data) {
  try {
    if (typeof key !== 'string' || key.length !== 87 || typeof signature !== 'string' || signature.length !== 86) return false;
    const imported = await crypto.subtle.importKey('raw', unb64(key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, imported, unb64(signature), enc.encode(canonical(data)));
  } catch { return false; }
}
export const failIdentity = (status, message) => { throw Object.assign(new Error(message), { status }); };
export async function verifyCertificate(certificate) {
  if (!certificate || typeof certificate.root !== 'string' || certificate.root.length !== 87 || !Array.isArray(certificate.chain) || certificate.chain.length > 8) failIdentity(401, '端末の認証情報が無効です');
  let current = certificate.root;
  for (const step of certificate.chain) {
    const data = { purpose: 'ippo-device-v1', root: certificate.root, parent: current, key: step.key };
    if (!await verify(current, step.signature, data)) failIdentity(401, '端末の承認を確認できません');
    current = step.key;
  }
  return { userId: await publicId(certificate.root), deviceId: await publicId(current), publicKey: current, root: certificate.root };
}
export async function verifyEnvelope(envelope, audience, now = Date.now()) {
  const { certificate, data, signature } = envelope || {};
  const actor = await verifyCertificate(certificate);
  if (!data || data.audience !== audience || !Number.isSafeInteger(data.at) || Math.abs(data.at - now) > 120000 || !/^[a-f0-9-]{36}$/.test(data.nonce || '') || !await verify(actor.publicKey, signature, data)) failIdentity(401, '署名または時刻を確認できません。端末の時刻も確認してください');
  return actor;
}
export async function confirmationCode(id, rootA, rootB) {
  const value = await digest(canonical({ purpose: 'ippo-contact-v1', id, roots: [rootA, rootB].sort() }));
  return value.slice(0, 16).match(/.{4}/g).join(' ');
}
