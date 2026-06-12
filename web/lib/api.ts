const BAKED_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

// When served from the customer-facing portal subdomain (proxied through the
// VPS), route API calls to the same origin so MikroTik walled-garden only
// needs to allow ONE host (the VPS). Dashboard users on the Render origin
// keep using the baked jtm-api URL.
const getBase = () => {
  if (typeof window === 'undefined') {
    // Server-side render runs ON the VPS, which can't fetch its own public
    // hostname (no NAT hairpin) — so hit the API locally. serverApi() forwards
    // the tenant host via X-Forwarded-Host so Host→tenant routing still works.
    return process.env.INTERNAL_API_URL ?? 'http://127.0.0.1:4000';
  }
  const host = window.location.hostname;
  // Any platform host (demo/auth/billing/portal + every tenant subdomain) calls
  // its OWN origin. This keeps the Host header intact so the API's Host→tenant
  // routing hits the right database, and the MikroTik walled-garden only ever
  // needs to allow the single host the user is actually on.
  if (host.endsWith('hubnetwifi.co.ke')) {
    return window.location.origin;
  }
  return BAKED_BASE;
};

const TOKEN_KEY = 'jtm_token';
export const getToken = () =>
  typeof window !== 'undefined' ? window.localStorage.getItem(TOKEN_KEY) : null;
export const setToken = (t: string | null) => {
  if (typeof window === 'undefined') return;
  if (t) {
    window.localStorage.setItem(TOKEN_KEY, t);
    // Mirror into a cookie so server-rendered dashboard pages can authenticate.
    document.cookie = `${TOKEN_KEY}=${t}; path=/; max-age=${60 * 60 * 24 * 7}; samesite=lax`;
  } else {
    window.localStorage.removeItem(TOKEN_KEY);
    document.cookie = `${TOKEN_KEY}=; path=/; max-age=0`;
  }
};

export async function api<T = any>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const res = await fetch(`${getBase()}/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export const money = (cents: number, currency = 'KES') =>
  `${currency} ${(cents / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
