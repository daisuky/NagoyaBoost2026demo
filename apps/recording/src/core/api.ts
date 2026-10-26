import type { Credentials, CallStatus } from './types';
const base = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
export async function api<T = CallStatus>(action: string, fields: Record<string, unknown> = {}, auth?: string): Promise<T> {
  const response = await fetch(`${base}/api/call`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify({ action, ...fields }), signal: AbortSignal.timeout(12000) });
  const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error || '通信に失敗しました'), { status: response.status }); return value;
}
export const enter = (action: 'create' | 'join', fields: Record<string, unknown>) => api<Credentials>(action, fields);
