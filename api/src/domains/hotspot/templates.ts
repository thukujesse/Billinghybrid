import { config } from '../../config.js';

/**
 * Thin MikroTik hotspot HTML templates. Each one redirects the customer's
 * browser to our Next.js portal at /hotspot with relevant $(var) values
 * forwarded as query parameters. MikroTik substitutes $(varname) tokens
 * when serving these files, so the redirect URL ends up with real values.
 *
 * The portal page reads `mode` to decide what to render:
 *   - default       → voucher / M-Pesa entry (from login + rlogin)
 *   - status        → "you're connected, time left, logout link"
 *   - logout        → "logged out, thanks"
 *   - error         → display $(error) message + voucher form
 *
 * `tenant` (slug) is baked in per-router at template-fetch time so the
 * portal page knows which venue's branding to apply.
 */
const portalUrl = (): string => `https://${config.portal.host}/hotspot`;

const LOGIN = (slug: string): string => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Wi-Fi</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}</style>
</head><body>
<p>Connecting…</p>
<script>
var p=new URLSearchParams({
  'tenant':'${slug}',
  'link-login-only':'$(link-login-only)',
  'link-orig':'$(link-orig)',
  'link-orig-esc':'$(link-orig-esc)',
  'mac':'$(mac)',
  'ip':'$(ip)',
  'username':'$(username)',
  'error':'$(error)'
});
location.href='${portalUrl()}?'+p.toString();
</script></body></html>`;

const ALOGIN = (): string => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Connected</title>
<meta http-equiv="refresh" content="2;url=$(link-orig)">
<style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#16a34a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center}</style>
</head><body>
<div><h2>Connected</h2><p>You're online. Redirecting…</p></div>
<script>setTimeout(function(){location.href='$(link-orig)'||'https://example.com';},1500);</script>
</body></html>`;

const STATUS = (slug: string): string => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Session</title></head>
<body>
<script>
var p=new URLSearchParams({
  'tenant':'${slug}',
  'mode':'status',
  'mac':'$(mac)',
  'ip':'$(ip)',
  'username':'$(username)',
  'session-time-left':'$(session-time-left)',
  'uptime':'$(uptime)',
  'bytes-in':'$(bytes-in)',
  'bytes-out':'$(bytes-out)',
  'link-logout':'$(link-logout)'
});
location.href='${portalUrl()}?'+p.toString();
</script></body></html>`;

const LOGOUT = (slug: string): string => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Logged out</title></head>
<body>
<script>
location.href='${portalUrl()}?tenant=${slug}&mode=logout&mac=$(mac)&uptime=$(uptime)&bytes-in=$(bytes-in)&bytes-out=$(bytes-out)';
</script></body></html>`;

const ERROR_PAGE = (slug: string): string => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Login error</title></head>
<body>
<script>
var p=new URLSearchParams({
  'tenant':'${slug}',
  'mode':'error',
  'link-login-only':'$(link-login-only)',
  'link-orig':'$(link-orig)',
  'mac':'$(mac)',
  'ip':'$(ip)',
  'error':'$(error)'
});
location.href='${portalUrl()}?'+p.toString();
</script></body></html>`;

const REDIRECT = (): string => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Redirecting</title>
<meta http-equiv="refresh" content="0;url=$(link-redirect)">
</head><body>
<script>location.href='$(link-redirect)';</script>
</body></html>`;

const RLOGIN = (slug: string): string =>
  LOGIN(slug).replace(`'username':'$(username)',`, `'username':'$(username)','mode':'rlogin',`);

// MikroTik bundles md5.js for client-side CHAP password hashing on the login
// form. We use http-pap auth (no client-side crypto needed), so this is a
// safe stub — present so the hotspot doesn't 404 trying to load it.
const MD5_JS = (): string => `// JTM stub — login is server-side PAP via RADIUS, no MD5 needed.
function doLogin(){return true;}
function hexMD5(){return '';}`;

const TEMPLATES: Record<string, { body: (slug: string) => string; contentType: string }> = {
  'login.html':    { body: LOGIN,                contentType: 'text/html; charset=utf-8' },
  'alogin.html':   { body: () => ALOGIN(),       contentType: 'text/html; charset=utf-8' },
  'status.html':   { body: STATUS,               contentType: 'text/html; charset=utf-8' },
  'logout.html':   { body: LOGOUT,               contentType: 'text/html; charset=utf-8' },
  'error.html':    { body: ERROR_PAGE,           contentType: 'text/html; charset=utf-8' },
  'redirect.html': { body: () => REDIRECT(),     contentType: 'text/html; charset=utf-8' },
  'rlogin.html':   { body: RLOGIN,               contentType: 'text/html; charset=utf-8' },
  'md5.js':        { body: () => MD5_JS(),       contentType: 'application/javascript; charset=utf-8' },
};

export function getTemplate(
  name: string,
  slug: string = ''
): { body: string; contentType: string } | null {
  const tpl = TEMPLATES[name];
  if (!tpl) return null;
  return { body: tpl.body(slug), contentType: tpl.contentType };
}

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);
