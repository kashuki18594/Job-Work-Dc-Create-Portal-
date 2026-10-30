const DOWN = 'App server is not responding — it may be restarting. Wait a few seconds and try again (keep "npm run dev" running).';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The server always answers in JSON. A non-JSON 5xx comes from the dev proxy when the
// server is down or restarting; reads retry a few times, writes never retry (no double posting).
async function req(method, url, body, tries = method === 'GET' ? 3 : 1) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    if (tries > 1) { await wait(1500); return req(method, url, body, tries - 1); }
    throw new Error(DOWN);
  }
  const data = await res.json().catch(() => null);
  if (data == null && res.status >= 500) {
    if (tries > 1) { await wait(1500); return req(method, url, body, tries - 1); }
    throw new Error(DOWN);
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status} ${res.statusText})`);
  return data ?? {};
}
export const api = {
  get: (u) => req('GET', u),
  post: (u, b) => req('POST', u, b || {}),
  put: (u, b) => req('PUT', u, b),
  del: (u) => req('DELETE', u),
};

// module-level cache for Zoho lookups
const cache = {};
export async function lookup(kind, refresh = false) {
  if (!refresh && cache[kind]) return cache[kind];
  cache[kind] = await api.get(`/api/zoho/${kind}${refresh ? '?refresh=1' : ''}`);
  return cache[kind];
}
// add a just-created Zoho record to the cached list so other pages see it
export function addToLookup(kind, row) {
  if (cache[kind]) cache[kind] = [...cache[kind], row];
  return cache[kind] || [row];
}
