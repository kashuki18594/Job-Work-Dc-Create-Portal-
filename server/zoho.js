// Zoho Books API client: keeps a refresh token locally, mints access tokens on demand.
import 'dotenv/config';

const DC = (process.env.ZOHO_DC || 'in').trim(); // in | com | eu | com.au ...
const ACCOUNTS_URL = process.env.ZOHO_ACCOUNTS_URL || `https://accounts.zoho.${DC}`;
const API_BASE = process.env.ZOHO_API_BASE || `https://www.zohoapis.${DC}/books/v3`;
// Same organisation through the Zoho Inventory API: used where the login has Inventory but not Books permission
const INVENTORY_BASE = process.env.ZOHO_INVENTORY_BASE || `https://www.zohoapis.${DC}/inventory/v1`;
const ORG_ID = process.env.ZOHO_ORG_ID;

let cached = { token: null, expiresAt: 0 };
let inflight = null;

export function configOk() {
  const missing = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID']
    .filter((k) => !process.env[k]);
  return { ok: missing.length === 0, missing };
}

async function refreshAccessToken() {
  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  let data;
  try {
    const res = await fetch(`${ACCOUNTS_URL}/oauth/v2/token?${params}`, { method: 'POST' });
    data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  } catch (e) {
    throw Object.assign(new Error(`Cannot reach Zoho login (${e.cause?.code || e.message}) — check the internet connection`), { http: 502 });
  }
  if (!data.access_token) {
    const why = data.error === 'invalid_code' ? 'refresh token is invalid or revoked — generate a new one' : data.error || JSON.stringify(data);
    throw Object.assign(new Error(`Zoho login failed: ${why}`), { http: 502 });
  }
  cached = {
    token: data.access_token,
    // refresh 2 minutes early
    expiresAt: Date.now() + ((data.expires_in || 3600) - 120) * 1000,
  };
  return cached.token;
}

async function getToken() {
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;
  if (!inflight) inflight = refreshAccessToken().finally(() => { inflight = null; });
  return inflight;
}

/**
 * Call Zoho Books (or, with api: 'inventory', the Zoho Inventory API of the same organisation).
 * path like '/items' ; query object ; body object (sent as JSON). Throws Error with Zoho's message when code !== 0.
 */
export async function zoho(method, path, { query = {}, body, api } = {}, retried = false) {
  const token = await getToken();
  const qs = new URLSearchParams({ organization_id: ORG_ID, ...query });
  let res;
  try {
    res = await fetch(`${api === 'inventory' ? INVENTORY_BASE : API_BASE}${path}?${qs}`, {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw Object.assign(new Error(`Cannot reach Zoho Books (${e.cause?.code || e.message}) — check the internet connection and try again`), { http: 502 });
  }
  if (res.status === 429) throw Object.assign(new Error('Zoho Books API limit reached — wait a minute and try again'), { http: 429 });
  if (res.status === 401 && !retried) {
    cached = { token: null, expiresAt: 0 };
    return zoho(method, path, { query, body, api }, true);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { code: -1, message: text.slice(0, 300) }; }
  if (!res.ok || (data.code !== undefined && data.code !== 0)) {
    const err = new Error(`Zoho ${method} ${path}: ${data.message || res.statusText}`);
    err.zoho = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Fetch every page of a list endpoint. key = response array key, e.g. 'items'. */
export async function zohoAll(path, key, query = {}) {
  const out = [];
  for (let page = 1; page < 200; page++) {
    const data = await zoho('GET', path, { query: { ...query, page, per_page: 200 } });
    out.push(...(data[key] || []));
    if (!data.page_context?.has_more_page) break;
  }
  return out;
}

/** Upload one file to Zoho (multipart, field "attachment"), e.g. path '/deliverychallans/<id>/attachment'. */
export async function zohoUpload(path, { name, type, data }, retried = false) {
  const token = await getToken();
  const form = new FormData();
  form.append('attachment', new Blob([data], { type: type || 'application/octet-stream' }), name);
  let res;
  try {
    res = await fetch(`${API_BASE}${path}?${new URLSearchParams({ organization_id: ORG_ID })}`, {
      method: 'POST', headers: { Authorization: `Zoho-oauthtoken ${token}` }, body: form,
    });
  } catch (e) {
    throw Object.assign(new Error(`Cannot reach Zoho Books (${e.cause?.code || e.message}) — check the internet connection and try again`), { http: 502 });
  }
  if (res.status === 401 && !retried) {
    cached = { token: null, expiresAt: 0 };
    return zohoUpload(path, { name, type, data }, true);
  }
  const text = await res.text();
  let out;
  try { out = JSON.parse(text); } catch { out = { code: -1, message: text.slice(0, 300) }; }
  if (!res.ok || (out.code !== undefined && out.code !== 0)) {
    throw Object.assign(new Error(`Zoho upload ${name}: ${out.message || res.statusText}`), { zoho: out, http: 502 });
  }
  return out;
}

const CRM_BASE = process.env.ZOHO_CRM_BASE || `https://www.zohoapis.${DC}/crm/v2`;

/** Read from Zoho CRM with the same login (needs a ZohoCRM scope on the refresh token). */
export async function zohoCrm(path, query = {}, retried = false) {
  const token = await getToken();
  let res;
  try {
    res = await fetch(`${CRM_BASE}${path}?${new URLSearchParams(query)}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  } catch (e) {
    throw Object.assign(new Error(`Cannot reach Zoho CRM (${e.cause?.code || e.message}) — check the internet connection`), { http: 502 });
  }
  if (res.status === 401 && !retried) {
    cached = { token: null, expiresAt: 0 };
    return zohoCrm(path, query, true);
  }
  if (res.status === 204) return { data: [] }; // CRM answers "no content" when nothing matches
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = out.code === 'OAUTH_SCOPE_MISMATCH' ? 'the Zoho login has no CRM permission — regenerate the refresh token with a ZohoCRM scope' : out.message || res.statusText;
    throw Object.assign(new Error(`Zoho CRM: ${why}`), { http: 502 });
  }
  return out;
}
