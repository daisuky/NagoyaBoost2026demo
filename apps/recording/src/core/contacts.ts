import type { Credentials } from './types';
export type Member = { id: string; name: string; priority: boolean };
export type Ring = { id: string; caller: string; callee: string; state: 'preparing' | 'ringing' | 'accepted' | 'declined' | 'busy' | 'cancelled' | 'expired' | 'completed'; expiresAt: number; room: string; push: string };
export type Directory = { self: string; contacts: { memberId: string; notifications: boolean }[]; pending: { id: string; memberId: string }[]; calls: Ring[]; notifications: boolean };
export type ContactHealth = { enabled: boolean; pushConfigured: boolean; publicKey: string; members: Member[] };
export type RingResult = { call: Ring; credentials: Credentials };
const base = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const storageKey = 'ippo-device-credential-v1';
export const deviceIdentity = {
  get: () => localStorage.getItem(storageKey) || '',
  set: (value: string) => localStorage.setItem(storageKey, value),
  clear: () => localStorage.removeItem(storageKey)
};
export function prepareDeviceIdentity() {
  if (deviceIdentity.get()) return;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  deviceIdentity.set(`${crypto.randomUUID()}.${secret}`);
}
export async function contactApi<T = Directory>(endpoint: 'contacts' | 'incoming', action: string, fields: Record<string, unknown> = {}): Promise<T> {
  const credential = deviceIdentity.get();
  const response = await fetch(`${base}/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify({ action, ...fields }), signal: AbortSignal.timeout(45000) });
  const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error || '呼び出しを確認できません'), { status: response.status }); return result;
}
