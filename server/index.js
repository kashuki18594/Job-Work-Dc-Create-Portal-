import 'dotenv/config';
import express from 'express';
import { zoho, zohoAll, zohoUpload, zohoCrm, configOk } from './zoho.js';
import { db, save, uid } from './db.js';

// No CORS: the browser reaches the API only through the Vite proxy (same origin),
// so other websites can't drive Books postings through this server.
const app = express();
app.use(express.json({ limit: '2mb' }));

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e.message, e.zoho || '');
    res.status(e.http || 500).json({ error: e.message, zoho: e.zoho });
  });
const fail = (msg, http = 400) => Object.assign(new Error(msg), { http });

// One Books-posting action per DC at a time, so a double click can't post twice.
const busyDcs = new Set();
const locked = (fn) => async (req, res) => {
  const id = req.params.id;
  if (busyDcs.has(id)) throw fail('Another action on this DC is still running — wait and refresh', 409);
  busyDcs.add(id);
  try { return await fn(req, res); } finally { busyDcs.delete(id); }
};

// ---------- calculations ----------
function computeLine(l, factor) {
  const parameter = Number(l.parameter) || 0;
  const length = Number(l.length) || 0;
  const pcs = Number(l.pcs) || 0;
  const sqftPerPc = Math.round((parameter * length / 1e6) * factor * 1e6) / 1e6;
  const ratePerSqft = Number(l.ratePerSqft) || 0;
  const coatingPerPc = r2(sqftPerPc * ratePerSqft);
  return {
    id: l.id || uid(),
    rawItemId: l.rawItemId, rawName: l.rawName, rawSku: l.rawSku || '', hsn: l.hsn || '', unit: l.unit || 'nos',
    coating: l.coating || '',
    coatedItemId: l.coatedItemId, coatedName: l.coatedName, coatedSku: l.coatedSku || '',
    parameter, length, pcs,
    sqftPerPc, totalSqft: r2(sqftPerPc * pcs),
    ratePerSqft, coatingPerPc, coatingAmount: r2(sqftPerPc * pcs * ratePerSqft),
    rawCostPerPc: r2(l.rawCostPerPc),
    locationId: l.locationId || '', locationName: l.locationName || '', // where this line's stock goes out from and comes back to
    discount: r2(l.discount), // ₹ on the line, printed only
    gstRate: l.gstRate === '' || l.gstRate == null ? null : Number(l.gstRate), // % printed on the DC; null = DC default
    receivedPcs: Number(l.receivedPcs) || 0,
    scrapPcs: Number(l.scrapPcs) || 0,
  };
}
const balanceOf = (l) => l.pcs - l.receivedPcs - l.scrapPcs;

function deriveStatus(dc) {
  if (['draft', 'cancelled', 'closed'].includes(dc.status)) return dc.status;
  const anyRecv = dc.lines.some((l) => l.receivedPcs > 0);
  const allDone = dc.lines.every((l) => balanceOf(l) <= 0);
  if (allDone) return 'received';
  return anyRecv ? 'partial' : 'confirmed';
}

function getDc(id) {
  const dc = db().dcs.find((d) => d.id === id);
  if (!dc) throw fail('DC not found', 404);
  return dc;
}

function rememberMappingsAndRates(dc) {
  const s = db();
  for (const l of dc.lines) {
    if (l.rawItemId && l.coating && l.coatedItemId) {
      const m = s.mappings.find((x) => x.rawItemId === l.rawItemId && x.coating === l.coating);
      if (m) Object.assign(m, { coatedItemId: l.coatedItemId, coatedName: l.coatedName });
      else s.mappings.push({ id: uid(), rawItemId: l.rawItemId, rawName: l.rawName, coating: l.coating, coatedItemId: l.coatedItemId, coatedName: l.coatedName });
    }
    if (dc.vendorId && l.coating && l.ratePerSqft) {
      const r = s.rates.find((x) => x.vendorId === dc.vendorId && x.coating === l.coating);
      if (r) r.ratePerSqft = l.ratePerSqft;
      else s.rates.push({ id: uid(), vendorId: dc.vendorId, vendorName: dc.vendorName, coating: l.coating, ratePerSqft: l.ratePerSqft });
    }
  }
}

// Stock adjustments go through the Zoho Inventory API: this login is not allowed to post them through Books.
function adjustmentBody({ date, reason, ref, description, lines, locationId = db().settings.locationId }) {
  const s = db().settings;
  return {
    date, reason, reference_number: ref, description, adjustment_type: 'quantity',
    ...(locationId ? { location_id: locationId } : {}),
    line_items: lines.map((x) => ({
      item_id: x.itemId,
      quantity_adjusted: x.qty, // negative = stock out
      ...(x.itemTotal !== undefined ? { item_total: r2(x.itemTotal) } : {}),
      adjustment_account_id: s.clearingAccountId,
      ...(locationId ? { location_id: locationId } : {}),
    })),
  };
}

function requireSettings(keys) {
  const s = db().settings;
  const labels = { clearingAccountId: 'Material sent account (Settings)', coatingServiceItemId: 'Coating service item', scrapAccountId: 'Scrap / Loss account' };
  const missing = keys.filter((k) => !s[k]);
  if (missing.length) throw fail(`Settings incomplete: set ${missing.map((k) => labels[k] || k).join(', ')}`);
}

// ---------- health & Zoho lookups ----------
let cache = {};
async function cachedList(key, loader, refresh) {
  if (!refresh && cache[key] && Date.now() - cache[key].at < 30 * 60 * 1000) return cache[key].data;
  const data = await loader();
  cache[key] = { at: Date.now(), data };
  return data;
}

app.get('/api/health', wrap(async (req, res) => {
  const cfg = configOk();
  if (!cfg.ok) return res.json({ ok: false, error: `Missing in .env: ${cfg.missing.join(', ')}` });
  const data = await zoho('GET', `/organizations/${process.env.ZOHO_ORG_ID}`);
  res.json({ ok: true, organization: data.organization?.name, currency: data.organization?.currency_code });
}));

const listItem = (i) => ({
  item_id: i.item_id, name: i.name, sku: i.sku || '', unit: i.unit || '',
  purchase_rate: i.purchase_rate || 0, rate: i.rate || 0,
  product_type: i.product_type, item_type: i.item_type,
  stock_on_hand: i.stock_on_hand ?? i.available_stock ?? null,
  hsn_or_sac: i.hsn_or_sac || '', brand: i.brand || '', manufacturer: i.manufacturer || '',
  gstRate: itemGstRate(i),
  // Books tax for this item on a sales document: intra-state (e.g. GST18 group) and inter-state (IGST18)
  taxIntraId: (i.item_tax_preferences || []).find((x) => x.tax_specification === 'intra')?.tax_id || '',
  taxInterId: (i.item_tax_preferences || []).find((x) => x.tax_specification === 'inter')?.tax_id || '',
});

// Item's GST % from Books: intra-state preference (e.g. GST18), else inter (IGST18);
// non-taxable / exempt items are 0. null = no tax set on the item.
function itemGstRate(i) {
  if (i.is_taxable === false || i.tax_exemption_id) return 0;
  const prefs = i.item_tax_preferences || [];
  const p = prefs.find((x) => x.tax_specification === 'intra') || prefs.find((x) => x.tax_specification === 'inter');
  if (p) return Number(p.tax_percentage) || 0;
  return i.tax_id ? Number(i.tax_percentage) || 0 : null;
}

app.get('/api/zoho/items', wrap(async (req, res) => {
  const items = await cachedList('items', async () => {
    const list = await zohoAll('/items', 'items', { filter_by: 'Status.Active' });
    return list.map(listItem);
  }, req.query.refresh === '1');
  res.json(items);
}));

// Item custom fields in this Books org ("Additional Information"). Required when brand is Alloy.
// CRM ID and issynctally are left out on purpose: the app never sets them.
const ITEM_CUSTOM_FIELDS = [
  { api: 'cf_description', label: 'Description' },
  { api: 'cf_generic_name', label: 'Product Name' },
  { api: 'cf_series', label: 'Series' },
  { api: 'cf_finish', label: 'Finish' },
  { api: 'cf_uom', label: 'UOM' },
  { api: 'cf_finish_code', label: 'Finish Code' },
];
const isAlloy = (brand) => String(brand || '').trim().toLowerCase() === 'alloy';
// Alloy naming rule: <Product Name>_<Unit>_<Finish Code>, e.g. 100.01A_2.8m_NA (used for both Name and SKU)
const alloySku = (productName, unit, finishCode) => [productName, unit, finishCode].map((x) => String(x ?? '').trim()).join('_');

// Accounts/taxes for new items: Settings override, else the Books defaults by name.
async function newItemDefaults() {
  const s = db().settings;
  const accounts = await allAccounts();
  const taxes = await cachedList('taxes', () => zoho('GET', '/settings/taxes').then((d) => d.taxes || []));
  const acc = (id, name) => accounts.find((a) => a.account_id === id) || accounts.find((a) => a.account_name === name);
  const tax = (id, name) => taxes.find((t) => t.tax_id === id) || taxes.find((t) => t.tax_name === name);
  const pick = (a) => (a ? { id: a.account_id, name: a.account_name } : null);
  const pickTax = (t) => (t ? { id: t.tax_id, name: t.tax_name } : null);
  return {
    sales: pick(acc(s.itemSalesAccountId, 'Sales Accounts')),
    purchase: pick(acc(s.itemPurchaseAccountId, 'Cost of Goods Sold')),
    inventory: pick(acc(s.itemInventoryAccountId, 'Inventory Asset')),
    taxIntra: pickTax(tax(s.itemTaxIntraId, 'GST18')),
    taxInter: pickTax(tax(s.itemTaxInterId, 'IGST18')),
  };
}

// group: CGST+SGST tax group · spec: cgst/sgst/igst · scope: intra/inter ('' = either)
const taxRows = (taxes) => taxes.filter((t) => !t.is_inactive).map((t) => ({
  tax_id: t.tax_id, name: t.tax_name, pct: t.tax_percentage,
  group: t.tax_type === 'tax_group', spec: t.tax_specific_type || '', scope: t.tax_specification || '',
}));

app.get('/api/item-meta', wrap(async (req, res) => {
  const taxes = await cachedList('taxes', () => zoho('GET', '/settings/taxes').then((d) => d.taxes || []));
  const exemptions = await cachedList('exemptions', () => zoho('GET', '/settings/taxexemptions').then((d) => d.tax_exemptions || []));
  const units = await cachedList('units', () => zoho('GET', '/units').then((d) => d.units || []));
  const manufacturers = await cachedList('manufacturers', () => zoho('GET', '/manufacturers').then((d) => d.manufacturers || []).catch(() => []));
  // brands: the API doesn't allow listing them, so use the ones existing items carry
  const items = await cachedList('items', async () => (await zohoAll('/items', 'items', { filter_by: 'Status.Active' })).map(listItem));
  const unitInfo = new Map();
  for (const u of units) {
    const info = [u.name, u.uqc].filter(Boolean).join(' · ');
    if (!unitInfo.has(u.unit)) unitInfo.set(u.unit, info);
  }
  const sorted = (a) => [...new Set(a.filter(Boolean))].sort((x, y) => x.localeCompare(y));
  res.json({
    units: [...unitInfo].map(([unit, info]) => ({ unit, info })),
    manufacturers: sorted(manufacturers.map((m) => m.name)),
    brands: sorted(items.map((i) => i.brand)),
    customFields: ITEM_CUSTOM_FIELDS,
    defaults: await newItemDefaults(),
    taxes: taxRows(taxes),
    exemptions: exemptions.filter((e) => e.type === 'item').map((e) => ({ id: e.tax_exemption_id, name: e.description ? `${e.tax_exemption_code} — ${e.description}` : e.tax_exemption_code })),
  });
}));

// Full item (for copying details of the raw item into a new coated item).
app.get('/api/zoho/items/:id', wrap(async (req, res) => {
  const { item: i } = await zoho('GET', `/items/${req.params.id}`);
  res.json({
    ...listItem(i), description: i.description || '', purchase_description: i.purchase_description || '',
    // stock on hand per location / sub-location, e.g. { '<Chennai (Table Space) id>': 135 }
    stockByLocation: Object.fromEntries((i.locations || []).map((l) => [l.location_id, Number(l.location_stock_on_hand) || 0])),
    custom: Object.fromEntries((i.custom_fields || []).map((c) => [c.api_name, c.value])),
  });
}));

app.post('/api/zoho/items', wrap(async (req, res) => {
  const b = req.body;
  const str = (v) => String(v ?? '').trim();
  const custom = b.custom || {};
  const unit = str(b.unit);
  if (isAlloy(b.brand)) {
    const missing = ITEM_CUSTOM_FIELDS.filter((f) => !f.checkbox && !str(custom[f.api])).map((f) => f.label);
    if (!unit) missing.unshift('Unit');
    if (missing.length) throw fail(`Brand Alloy: fill ${missing.join(', ')}`);
  }
  const name = isAlloy(b.brand) ? alloySku(custom.cf_generic_name, unit, custom.cf_finish_code) : str(b.name);
  const sku = isAlloy(b.brand) ? name : str(b.sku);
  if (!name || !sku || !unit) throw fail('Name, SKU and Unit are required');
  if (b.rate === '' || b.rate == null || b.purchase_rate === '' || b.purchase_rate == null) throw fail('Selling price and cost price are required (0 is allowed)');
  const d = await newItemDefaults();
  for (const [k, label] of [['sales', 'Sales account'], ['purchase', 'Cost of Goods Sold account'], ['inventory', 'Inventory account']]) {
    if (!d[k]) throw fail(`${label} not found in Books — set it in Settings → New item defaults`);
  }
  // tax preference: taxable (intra + inter tax) or non-taxable (exemption reason)
  const taxable = b.taxPreference !== 'non_taxable';
  const taxIntraId = str(b.taxIntraId) || d.taxIntra?.id;
  const taxInterId = str(b.taxInterId) || d.taxInter?.id;
  if (taxable && (!taxIntraId || !taxInterId)) throw fail('Select intra-state and inter-state tax');
  if (!taxable && !str(b.taxExemptionId)) throw fail('Select exemption reason for a non-taxable item');
  const body = {
    name, sku, unit,
    product_type: 'goods', item_type: 'inventory',
    brand: str(b.brand), manufacturer: str(b.manufacturer), hsn_or_sac: str(b.hsn_or_sac),
    is_taxable: taxable,
    ...(taxable
      ? { item_tax_preferences: [{ tax_id: taxIntraId, tax_specification: 'intra' }, { tax_id: taxInterId, tax_specification: 'inter' }] }
      : { tax_exemption_id: str(b.taxExemptionId) }),
    rate: Number(b.rate) || 0, description: str(b.description), account_id: d.sales.id,
    purchase_rate: Number(b.purchase_rate) || 0, purchase_description: str(b.purchase_description), purchase_account_id: d.purchase.id,
    inventory_account_id: d.inventory.id,
    custom_fields: ITEM_CUSTOM_FIELDS
      .filter((f) => f.checkbox || str(custom[f.api]))
      .map((f) => ({ api_name: f.api, value: f.checkbox ? !!custom[f.api] : str(custom[f.api]) })),
  };
  const { item } = await zoho('POST', '/items', { body });
  const row = listItem(item);
  if (cache.items) cache.items.data.push(row);
  console.log(`Item created in Books: ${row.name} (${row.item_id})`);
  res.json(row);
}));

app.get('/api/zoho/vendors', wrap(async (req, res) => {
  const vendors = await cachedList('vendors', async () => {
    // Books ignores contact_type on this list; ActiveVendors is the filter that works.
    const list = await zohoAll('/contacts', 'contacts', { filter_by: 'Status.ActiveVendors' });
    return list
      .filter((c) => c.status === 'active' && c.contact_type === 'vendor')
      .map((c) => {
        const company = c.company_name && c.company_name.trim() !== c.contact_name.trim() ? c.company_name.trim() : '';
        // info: shown under the name in pickers and searched (company name, GSTIN)
        return { contact_id: c.contact_id, name: c.contact_name, company_name: company, gst_no: c.gst_no || '', info: [company, c.gst_no].filter(Boolean).join(' · ') };
      });
  }, req.query.refresh === '1');
  res.json(vendors);
}));

app.get('/api/zoho/vendors/:id', wrap(async (req, res) => res.json(await vendorDetails(req.params.id))));

// The plain chart-of-accounts list leaves out stock and cost_of_goods_sold accounts;
// the Asset / Expense filtered lists include them, so merge all three.
function allAccounts(refresh) {
  return cachedList('accounts', async () => {
    const lists = await Promise.all([undefined, 'AccountType.Asset', 'AccountType.Expense']
      .map((f) => zohoAll('/chartofaccounts', 'chartofaccounts', f ? { filter_by: f } : {})));
    const byId = new Map();
    for (const a of lists.flat()) byId.set(a.account_id, a);
    return [...byId.values()];
  }, refresh);
}

app.get('/api/zoho/accounts', wrap(async (req, res) => {
  const data = await allAccounts(req.query.refresh === '1');
  res.json(data.filter((a) => a.is_active !== false).map((a) => ({ account_id: a.account_id, name: a.account_name, type: a.account_type })));
}));

app.get('/api/zoho/taxes', wrap(async (req, res) => {
  const data = await cachedList('taxes', () => zoho('GET', '/settings/taxes').then((d) => d.taxes || []), req.query.refresh === '1');
  res.json(data.map((t) => ({ tax_id: t.tax_id, name: t.tax_name, pct: t.tax_percentage, type: t.tax_specific_type || t.tax_type })));
}));

// A Books location for the DC print / dispatch-from: address lines, GSTIN, contact.
// No GSTIN on the location (e.g. Head Office): use the one registered in the same state.
function locationInfo(l, all) {
  const st = l.address?.state_code || '';
  const gstin = l.tax_reg_no || all.find((x) => x.tax_reg_no && x.address?.state_code === st)?.tax_reg_no || '';
  return {
    location_id: l.location_id, name: l.location_name, type: l.type, parent: l.parent_location_id || '', primary: !!l.is_primary_location,
    state: st, gstin, address: locationLines(l), email: l.email || '', phone: l.phone || l.mobile || '',
  };
}
const allLocations = () => cachedList('locationsAll', () => zoho('GET', '/locations').then((d) => d.locations || []));

app.get('/api/zoho/locations', wrap(async (req, res) => {
  try {
    const locs = await allLocations();
    // includes stock sub-locations (type line_item_only); a DC's own location is never one of those
    res.json(locs.map((l) => locationInfo(l, locs)));
  } catch { res.json([]); }
}));

// ---------- settings & masters ----------
app.get('/api/settings', (req, res) => res.json(db().settings));
app.put('/api/settings', (req, res) => {
  const s = db();
  const { nextDcSeq, dcPrefix, ...rest } = req.body; // old auto-numbering settings, no longer used
  s.settings = { ...s.settings, ...rest };
  save();
  res.json(s.settings);
});

for (const coll of ['mappings', 'rates']) {
  app.get(`/api/${coll}`, (req, res) => res.json(db()[coll]));
  app.post(`/api/${coll}`, (req, res) => {
    const s = db();
    const row = { ...req.body, id: req.body.id || uid() };
    const i = s[coll].findIndex((x) => x.id === row.id);
    if (i >= 0) s[coll][i] = row; else s[coll].push(row);
    save();
    res.json(row);
  });
  app.delete(`/api/${coll}/:id`, (req, res) => {
    const s = db();
    s[coll] = s[coll].filter((x) => x.id !== req.params.id);
    save();
    res.json({ ok: true });
  });
}

// ---------- DCs ----------
app.get('/api/dcs', (req, res) => {
  res.json(db().dcs.slice().reverse().map((d) => ({
    id: d.id, dcNo: d.dcNo, date: d.date, vendorName: d.vendorName, status: d.status,
    poNumber: d.zoho?.poNumber || '',
    pcs: d.lines.reduce((a, l) => a + l.pcs, 0),
    received: d.lines.reduce((a, l) => a + l.receivedPcs, 0),
    scrap: d.lines.reduce((a, l) => a + l.scrapPcs, 0),
    balance: d.lines.reduce((a, l) => a + Math.max(0, balanceOf(l)), 0),
    coatingAmount: r2(d.lines.reduce((a, l) => a + l.coatingAmount, 0)),
  })));
});

app.get('/api/dcs/:id', wrap(async (req, res) => res.json(getDc(req.params.id))));

const fmtAddress = (a = {}) => [a.attention, a.address, a.street2, a.city, a.state, a.zip].filter(Boolean).join(', ');

async function vendorDetails(vendorId) {
  try {
    const { contact: c } = await zoho('GET', `/contacts/${vendorId}`);
    const a = c.billing_address || {};
    return {
      vendorName: c.contact_name, vendorGstin: c.gst_no || '',
      vendorAddress: fmtAddress(a),
      vendorShipAddress: fmtAddress(c.shipping_address),
      vendorState: c.place_of_contact_formatted || a.state || '',
    };
  } catch { return {}; }
}

// DC parties live only in the app (the DC is not created in Books). Empty ones default
// to the job worker's Books billing/shipping address and the company / dispatch address.
function fillAddresses(dc) {
  const co = db().settings.company;
  dc.billingAddress ||= dc.vendorAddress || '';
  dc.shippingAddress ||= dc.vendorShipAddress || dc.billingAddress;
  dc.dispatchFrom ||= co.dispatchAddress || co.address || '';
  dc.billToName ||= dc.vendorName || '';
  dc.billToGstin ||= dc.vendorGstin || '';
  dc.shipToName ||= dc.vendorName || '';
  dc.shipToGstin ||= dc.vendorGstin || '';
  dc.dispatchName ||= co.name || '';
  dc.dispatchGstin ||= co.gstin || '';
}

// Everything printed on the DC that is not stock-related; stays editable after confirmation.
const PRINT_KEYS = [
  'vehicleNo', 'ewayBillNo', 'transporter', 'transportMode', 'gstRate', 'remarks',
  'reverseCharge', 'placeOfSupply', 'workOrder', 'orderDate', 'contactPerson', 'contactMobile', 'packages', 'mdfNo', 'terms',
  'billToName', 'billingAddress', 'billToGstin', 'billToState',
  'shipToName', 'shippingAddress', 'shipToGstin', 'shipToState',
  'dispatchName', 'dispatchFrom', 'dispatchGstin', 'dispatchState',
];

function headerFrom(body) {
  const pick = ['date', 'vendorId', 'vendorName', 'vendorGstin', 'vendorAddress', 'vendorState', ...PRINT_KEYS];
  return Object.fromEntries(pick.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
}

// A DC has one dispatching location: lines may use it or its sub-locations. Returns that main location.
async function mainLocation(lines) {
  const locs = await allLocations();
  const mains = new Set(lines.map((l) => { const x = locs.find((y) => y.location_id === l.locationId); return x?.parent_location_id || l.locationId; }));
  if (mains.size > 1) throw fail('All lines of a DC must be from one location or its sub-locations. Make a separate DC for the other location');
  return [...mains][0];
}

function validateLines(lines) {
  if (!lines?.length) throw fail('Add at least one item line');
  lines.forEach((l, i) => {
    const n = i + 1;
    if (!l.rawItemId) throw fail(`Line ${n}: select raw item`);
    if (!l.locationId) throw fail(`Line ${n}: select location`);
    if (!l.coatedItemId) throw fail(`Line ${n}: select coated (new) item`);
    if (!String(l.hsn || '').trim()) throw fail(`Line ${n}: HSN / SAC is required`);
    if (!String(l.unit || '').trim()) throw fail(`Line ${n}: UOM is required`);
    if (!(l.pcs > 0)) throw fail(`Line ${n}: Qty must be more than 0`);
    if (!(l.rawCostPerPc > 0)) throw fail(`Line ${n}: Rate must be more than 0`);
  });
}

// DC numbers are typed by the user (no auto numbering) and must be unique
function checkDcNo(value, exceptId) {
  const no = String(value ?? '').trim();
  if (!no) throw fail('Enter the DC number');
  if (no.length > 50) throw fail('DC number is too long (max 50 characters)');
  const dup = db().dcs.find((d) => d.id !== exceptId && String(d.dcNo).trim().toLowerCase() === no.toLowerCase());
  if (dup) throw fail(`DC number ${no} is already used (${dup.vendorName || 'another DC'}, ${dup.date})`);
  return no;
}

app.post('/api/dcs', wrap(async (req, res) => {
  const s = db();
  const b = req.body;
  const dcNo = checkDcNo(b.dcNo);
  if (!b.vendorId) throw fail('Select job worker');
  const lines = (b.lines || []).map((l) => computeLine(l, s.settings.sqftFactor));
  validateLines(lines);
  const dc = {
    id: uid(),
    dcNo,
    status: 'draft', date: today(),
    ...headerFrom(b), ...(await vendorDetails(b.vendorId)), locationId: await mainLocation(lines),
    lines, receipts: [], zoho: {}, log: [{ at: new Date().toISOString(), msg: 'DC created (draft)' }],
    createdAt: new Date().toISOString(),
  };
  if (b.date) dc.date = b.date;
  fillAddresses(dc);
  s.dcs.push(dc);
  rememberMappingsAndRates(dc);
  save();
  res.json(dc);
}));

app.put('/api/dcs/:id', wrap(async (req, res) => {
  const s = db();
  const dc = getDc(req.params.id);
  const b = req.body;
  if (dc.status === 'draft') {
    // the number can change only while draft; once confirmed it is the reference on the Books entries
    if (b.dcNo !== undefined) dc.dcNo = checkDcNo(b.dcNo, dc.id);
    const lines = (b.lines || []).map((l) => computeLine(l, s.settings.sqftFactor));
    validateLines(lines);
    const vendorChanged = b.vendorId && b.vendorId !== dc.vendorId;
    Object.assign(dc, headerFrom(b), { lines, locationId: await mainLocation(lines) });
    if (vendorChanged) Object.assign(dc, await vendorDetails(b.vendorId));
    fillAddresses(dc);
    rememberMappingsAndRates(dc);
  } else {
    // after confirmation only the print details (transport, order, parties) can change
    for (const k of PRINT_KEYS) if (b[k] !== undefined) dc[k] = b[k];
  }
  save();
  res.json(dc);
}));

app.delete('/api/dcs/:id', wrap(async (req, res) => {
  const s = db();
  const dc = getDc(req.params.id);
  if (dc.status !== 'draft') throw fail('Only draft DCs can be deleted. Use Cancel for confirmed DCs.');
  s.dcs = s.dcs.filter((d) => d.id !== dc.id);
  save();
  res.json({ ok: true });
}));

// Tax for each PO line (Books refuses a line without one): the tax in Settings if set, else the
// item's own tax from Books, intra-state when the vendor and the location are in the same state.
async function poLineTaxes(dc, s) {
  const { contact: vendor } = await zoho('GET', `/contacts/${dc.vendorId}`);
  const locs = await allLocations();
  const loc = locs.find((l) => l.location_id === dc.locationId) || locs.find((l) => l.is_primary_location);
  const intra = vendor.place_of_contact && vendor.place_of_contact === loc?.address?.state_code;
  const out = {};
  for (const id of new Set(dc.lines.map((l) => l.coatedItemId))) {
    if (s.purchaseTaxId) { out[id] = { tax_id: s.purchaseTaxId }; continue; }
    const { item } = await zoho('GET', `/items/${id}`);
    const pref = (item.item_tax_preferences || []).find((p) => p.tax_specification === (intra ? 'intra' : 'inter'));
    if (item.tax_exemption_id) out[id] = { tax_exemption_id: item.tax_exemption_id };
    else if (pref?.tax_id) out[id] = { tax_id: pref.tax_id };
    else throw fail(`${item.name}: no ${intra ? 'intra' : 'inter'}-state tax on this item in Books. Set it on the item, or set Tax on PO lines in Settings`);
  }
  return out;
}

// Lines whose raw item doesn't have enough stock in Zoho at the line's location.
// Lines with the same item and location are added together. Locations already posted are skipped.
async function stockShortages(dc) {
  const posted = dc.zoho?.outAdjustments || {};
  const need = new Map();
  for (const l of dc.lines) {
    if (posted[l.locationId]) continue;
    const key = `${l.rawItemId}|${l.locationId}`;
    need.set(key, { itemId: l.rawItemId, name: l.rawName, locationId: l.locationId, location: l.locationName, pcs: (need.get(key)?.pcs || 0) + l.pcs });
  }
  const out = [];
  for (const n of need.values()) {
    const { item } = await zoho('GET', `/items/${n.itemId}`);
    const available = Number(item.locations?.find((x) => x.location_id === n.locationId)?.location_stock_on_hand) || 0;
    if (n.pcs > available) out.push({ item: n.name, location: n.location, required: n.pcs, available });
  }
  return out;
}
const shortageText = (list) => list.map((x) => `${x.item}: need ${x.required}, only ${x.available} at ${x.location || 'this location'}`).join(' · ');

app.get('/api/dcs/:id/stock-check', wrap(async (req, res) => res.json(await stockShortages(getDc(req.params.id)))));

// Confirm: raw stock OUT (inventory adjustment, to the "material sent" account) + a PO to the job
// worker for the new (coated) items: qty = pcs sent, rate = the Rate on the DC line.
// The job worker's actual price goes on the bill in Books. Each step is idempotent: if the PO fails,
// Confirm again only creates the PO.
app.post('/api/dcs/:id/confirm', wrap(locked(async (req, res) => {
  requireSettings(['clearingAccountId']);
  const s = db().settings;
  const dc = getDc(req.params.id);
  const needsPoOnly = ['confirmed', 'partial'].includes(dc.status) && !dc.zoho?.poId; // confirmed before the PO flow
  if (!['draft', 'confirming'].includes(dc.status) && !needsPoOnly) throw fail(`DC is already ${dc.status}`);
  validateLines(dc.lines);
  // all lines or nothing: one short line stops the whole DC before anything is posted
  if (!needsPoOnly) {
    const short = await stockShortages(dc);
    if (short.length) throw fail(`Not enough stock, DC not confirmed. ${shortageText(short)}`);
  }
  const before = dc.status;
  if (!needsPoOnly) dc.status = 'confirming';
  dc.zoho ||= {};

  // Zoho takes one location per adjustment: one stock-out per line location
  dc.zoho.outAdjustments ||= {};
  for (const locationId of new Set(dc.lines.map((l) => l.locationId))) {
    if (dc.zoho.outAdjustments[locationId] || needsPoOnly) continue;
    const here = dc.lines.filter((l) => l.locationId === locationId);
    const body = adjustmentBody({
      date: dc.date, reason: s.adjustmentReason, ref: dc.dcNo, locationId,
      description: `Material sent for job work to ${dc.vendorName} vide DC ${dc.dcNo}`,
      lines: here.map((l) => ({ itemId: l.rawItemId, qty: -l.pcs, itemTotal: l.pcs * l.rawCostPerPc })),
    });
    let r;
    try {
      r = await zoho('POST', '/inventoryadjustments', { body, api: 'inventory' });
    } catch (e) {
      // nothing posted yet: back to draft so the lines can still be edited
      if (!Object.keys(dc.zoho.outAdjustments).length) dc.status = 'draft';
      throw e;
    }
    const adjId = r.inventory_adjustment?.inventory_adjustment_id;
    dc.zoho.outAdjustments[locationId] = adjId;
    dc.log.push({ at: new Date().toISOString(), msg: `Inventory adjustment (stock out) created at ${here[0].locationName || locationId}: ${adjId}` });
    save();
  }

  if (!dc.zoho.poId) {
    const poTax = await poLineTaxes(dc, s);
    const body = {
      vendor_id: dc.vendorId,
      date: dc.date,
      reference_number: dc.dcNo,
      notes: `Job work against DC ${dc.dcNo}`,
      ...(dc.locationId ? { location_id: dc.locationId } : {}),
      line_items: dc.lines.map((l) => ({
        item_id: l.coatedItemId,
        description: [`From ${l.rawName}`, l.coating && `Coating ${l.coating}`, `DC ${dc.dcNo}`].filter(Boolean).join(' | '),
        quantity: l.pcs,
        rate: l.rawCostPerPc || 0,
        ...poTax[l.coatedItemId],
        location_id: l.locationId,
      })),
    };
    const r = await zoho('POST', '/purchaseorders', { body });
    const po = r.purchaseorder || {};
    dc.zoho.poId = po.purchaseorder_id;
    dc.zoho.poNumber = po.purchaseorder_number;
    // remember which PO line belongs to which DC line (same order), for Purchase Receive
    (po.line_items || []).forEach((pl, i) => { if (dc.lines[i]) dc.lines[i].poLineItemId = pl.line_item_id; });
    dc.log.push({ at: new Date().toISOString(), msg: `Purchase order created: ${dc.zoho.poNumber}` });
  }

  dc.status = needsPoOnly ? before : 'confirmed';
  dc.confirmedAt ||= new Date().toISOString();
  save();
  res.json(dc);
})));

// Undo the last receipt (one step back): a purchase receive is deleted in Zoho; an older
// adjustment-type receipt gets a reversing adjustment. Received pcs go back to pending.
app.post('/api/dcs/:id/undo-receipt', wrap(locked(async (req, res) => {
  const s = db().settings;
  const dc = getDc(req.params.id);
  if (!['partial', 'received'].includes(dc.status)) throw fail(`Nothing to undo on a ${dc.status} DC`);
  const rc = dc.receipts[dc.receipts.length - 1];
  if (!rc) throw fail('No receipt on this DC');
  if (rc.receiveId) {
    await zoho('DELETE', `/purchasereceives/${rc.receiveId}`, { api: 'inventory' });
  } else if (rc.adjustmentId && await zoho('GET', `/inventoryadjustments/${rc.adjustmentId}`, { api: 'inventory' }).then(() => true, (e) => {
    // already deleted in Zoho: stock is back by itself, a reversal would take it out twice
    if (e.zoho?.code === 1002) return false;
    throw e;
  })) {
    const body = adjustmentBody({
      date: today(), reason: s.adjustmentReason, ref: `${dc.dcNo} UNDO`,
      description: `Reversal of receipt on DC ${dc.dcNo} (adjustment ${rc.adjustmentId})`,
      lines: rc.lines.map((x) => {
        const l = dc.lines.find((y) => y.id === x.lineId);
        return { itemId: l.coatedItemId, qty: -x.pcs, itemTotal: x.value };
      }),
    });
    const r = await zoho('POST', '/inventoryadjustments', { body, api: 'inventory' });
    rc.reversalAdjustmentId = r.inventory_adjustment?.inventory_adjustment_id;
  }
  for (const x of rc.lines) { const l = dc.lines.find((y) => y.id === x.lineId); if (l) l.receivedPcs = Math.max(0, l.receivedPcs - x.pcs); }
  dc.receipts.pop();
  (dc.undoneReceipts ||= []).push({ ...rc, undoneAt: new Date().toISOString() });
  dc.status = deriveStatus(dc);
  dc.log.push({ at: new Date().toISOString(), msg: `Receipt of ${rc.lines.reduce((a, x) => a + x.pcs, 0)} pcs undone${rc.reversalAdjustmentId ? ` (reversal adjustment ${rc.reversalAdjustmentId})` : rc.receiveId ? ` (purchase receive ${rc.receiveNumber || rc.receiveId} deleted)` : ' (its adjustment was already deleted in Zoho, nothing posted)'}` });
  save();
  res.json(dc);
})));

// Receive: Purchase Receive against the DC's PO (no inventory adjustment).
app.post('/api/dcs/:id/receive', wrap(locked(async (req, res) => {
  const dc = getDc(req.params.id);
  if (!['confirmed', 'partial'].includes(dc.status)) throw fail(`Cannot receive on a ${dc.status} DC`);
  if (!dc.zoho?.poId) throw fail('This DC has no purchase order in Books — confirm it again to create the PO');
  const { date = today(), vendorInvoiceNo = '', vendorChallanNo = '', remarks = '' } = req.body;
  const rows = (req.body.lines || []).filter((x) => Number(x.pcs) > 0);
  if (!rows.length) throw fail('Enter received pcs for at least one line');

  const lines = rows.map((x) => {
    const l = dc.lines.find((y) => y.id === x.lineId);
    if (!l) throw fail('Unknown line');
    const pcs = Number(x.pcs);
    if (pcs > balanceOf(l)) throw fail(`${l.coatedName}: receiving ${pcs} but only ${balanceOf(l)} pending`);
    if (!l.poLineItemId) throw fail(`${l.coatedName}: not linked to a PO line — check PO ${dc.zoho.poNumber} in Books`);
    return { l, pcs };
  });

  const ref = String(vendorChallanNo || vendorInvoiceNo || dc.dcNo).slice(0, 50);
  const r = await zoho('POST', '/purchasereceives', {
    api: 'inventory',
    query: { purchaseorder_id: dc.zoho.poId },
    body: {
      date, reference_number: ref,
      notes: [`Job work DC ${dc.dcNo}`, vendorInvoiceNo && `Job worker invoice ${vendorInvoiceNo}`, vendorChallanNo && `Job worker challan ${vendorChallanNo}`, remarks].filter(Boolean).join(' · '),
      line_items: lines.map(({ l, pcs }) => ({ line_item_id: l.poLineItemId, quantity: pcs })),
    },
  });
  const pr = r.purchasereceive || {};

  for (const { l, pcs } of lines) l.receivedPcs += pcs;
  dc.receipts.push({
    id: uid(), date, vendorInvoiceNo, vendorChallanNo, remarks,
    receiveId: pr.receive_id || pr.purchasereceive_id, receiveNumber: pr.receive_number || '',
    lines: lines.map(({ l, pcs }) => ({ lineId: l.id, item: l.coatedName, pcs, rate: l.rawCostPerPc || 0, value: r2(pcs * (l.rawCostPerPc || 0)) })),
  });
  dc.log.push({ at: new Date().toISOString(), msg: `Received ${lines.reduce((a, x) => a + x.pcs, 0)} pcs — purchase receive ${pr.receive_number || ''} on PO ${dc.zoho.poNumber}` });
  dc.status = deriveStatus(dc);
  save();
  res.json(dc);
})));

// Close: pending pcs are marked short / scrap. Nothing is posted: their raw value was already
// booked to the "material sent" account at Confirm, and the PO keeps only what was received.
app.post('/api/dcs/:id/close', wrap(locked(async (req, res) => {
  const dc = getDc(req.params.id);
  if (!['confirmed', 'partial', 'received'].includes(dc.status)) throw fail(`Cannot close a ${dc.status} DC`);
  const { notes = '' } = req.body;
  const pending = dc.lines.filter((l) => balanceOf(l) > 0);
  if (pending.length) {
    dc.log.push({ at: new Date().toISOString(), msg: `Closed short: ${pending.map((l) => `${l.coatedName} x${balanceOf(l)}`).join(', ')}${notes ? ` — ${notes}` : ''}` });
    for (const l of pending) l.scrapPcs += balanceOf(l);
  }
  dc.status = 'closed';
  dc.closedAt = new Date().toISOString();
  save();
  res.json(dc);
})));

// Cancel: only before anything is received. Reverses the stock-out and cancels the PO.
app.post('/api/dcs/:id/cancel', wrap(locked(async (req, res) => {
  const s = db().settings;
  const dc = getDc(req.params.id);
  if (!['confirmed', 'confirming'].includes(dc.status)) throw fail(`Cannot cancel a ${dc.status} DC`);
  if (dc.lines.some((l) => l.receivedPcs > 0)) throw fail('Material already received on this DC — close it instead');

  // reverse each stock-out at the value Zoho actually booked (its own cost, not the DC rate)
  dc.zoho.cancelAdjustments ||= {};
  for (const [locationId, adjId] of Object.entries(dc.zoho.outAdjustments || {})) {
    if (dc.zoho.cancelAdjustments[locationId]) continue;
    const { inventory_adjustment: out } = await zoho('GET', `/inventoryadjustments/${adjId}`, { api: 'inventory' });
    const body = adjustmentBody({
      date: today(), reason: s.adjustmentReason, ref: `${dc.dcNo} CANCEL`, locationId,
      description: `Reversal of ${adjId} — DC ${dc.dcNo} cancelled`,
      lines: out.line_items.map((x) => ({ itemId: x.item_id, qty: Math.abs(x.quantity_adjusted), itemTotal: Math.abs(x.item_total) })),
    });
    const r = await zoho('POST', '/inventoryadjustments', { body, api: 'inventory' });
    dc.zoho.cancelAdjustments[locationId] = r.inventory_adjustment?.inventory_adjustment_id;
    save();
  }
  if (dc.zoho.poId && !dc.zoho.poCancelled) {
    await zoho('POST', `/purchaseorders/${dc.zoho.poId}/status/cancelled`);
    dc.zoho.poCancelled = true;
  }
  dc.status = 'cancelled';
  dc.log.push({ at: new Date().toISOString(), msg: 'DC cancelled, stock reversed, PO cancelled' });
  save();
  res.json(dc);
})));

// ---------- reports ----------
app.get('/api/reports/pending', (req, res) => {
  const rows = [];
  for (const dc of db().dcs) {
    if (!['confirmed', 'partial'].includes(dc.status)) continue;
    for (const l of dc.lines) {
      const bal = balanceOf(l);
      if (bal <= 0) continue;
      const days = Math.floor((Date.now() - new Date(dc.date).getTime()) / 86400000);
      rows.push({
        dcId: dc.id, dcNo: dc.dcNo, date: dc.date, days, vendorName: dc.vendorName,
        rawName: l.rawName, coating: l.coating, coatedName: l.coatedName,
        sent: l.pcs, received: l.receivedPcs, scrap: l.scrapPcs, balance: bal,
        value: r2(bal * l.rawCostPerPc),
      });
    }
  }
  res.json(rows);
});

const PORT = process.env.PORT || 5055;
const HOST = process.env.HOST || '127.0.0.1'; // this PC only
// ---------- Normal DC: created in Zoho Books as a delivery challan ----------
// Job work DCs (/api/dcs) stay in the app; a normal DC lives in Books, so Books is its source of truth.

// Zoho place-of-supply codes (as Books stores them on contacts) with the GST state number
const ZOHO_STATES = [
  ['JK', '01', 'Jammu & Kashmir'], ['HP', '02', 'Himachal Pradesh'], ['PB', '03', 'Punjab'], ['CH', '04', 'Chandigarh'],
  ['UK', '05', 'Uttarakhand'], ['HR', '06', 'Haryana'], ['DL', '07', 'Delhi'], ['RJ', '08', 'Rajasthan'], ['UP', '09', 'Uttar Pradesh'],
  ['BR', '10', 'Bihar'], ['SK', '11', 'Sikkim'], ['AR', '12', 'Arunachal Pradesh'], ['NL', '13', 'Nagaland'], ['MN', '14', 'Manipur'],
  ['MZ', '15', 'Mizoram'], ['TR', '16', 'Tripura'], ['ML', '17', 'Meghalaya'], ['AS', '18', 'Assam'], ['WB', '19', 'West Bengal'],
  ['JH', '20', 'Jharkhand'], ['OD', '21', 'Odisha'], ['CG', '22', 'Chhattisgarh'], ['MP', '23', 'Madhya Pradesh'], ['GJ', '24', 'Gujarat'],
  ['DN', '26', 'Dadra & Nagar Haveli and Daman & Diu'], ['MH', '27', 'Maharashtra'], ['KA', '29', 'Karnataka'], ['GA', '30', 'Goa'],
  ['LD', '31', 'Lakshadweep'], ['KL', '32', 'Kerala'], ['TN', '33', 'Tamil Nadu'], ['PY', '34', 'Puducherry'],
  ['AN', '35', 'Andaman & Nicobar Islands'], ['TS', '36', 'Telangana'], ['AD', '37', 'Andhra Pradesh'], ['LA', '38', 'Ladakh'],
].map(([code, gst, name]) => ({ code, gst, name }));

const zohoDcUrl = (id) => `https://inventory.zoho.in/app/${process.env.ZOHO_ORG_ID}#/deliverychallans/${id}`;

app.get('/api/zoho/customers', wrap(async (req, res) => {
  const customers = await cachedList('customers', async () => {
    const list = await zohoAll('/contacts', 'contacts', { filter_by: 'Status.ActiveCustomers' });
    return list
      .filter((c) => c.status === 'active' && c.contact_type === 'customer')
      .map((c) => {
        const company = c.company_name && c.company_name.trim() !== c.contact_name.trim() ? c.company_name.trim() : '';
        return { contact_id: c.contact_id, name: c.contact_name, gst_no: c.gst_no || '', info: [company, c.gst_no].filter(Boolean).join(' · ') };
      });
  }, req.query.refresh === '1');
  res.json(customers);
}));

app.get('/api/zoho/customers/:id', wrap(async (req, res) => {
  const { contact: c } = await zoho('GET', `/contacts/${req.params.id}`);
  // GST registrations of the customer ("Tax Information" on a Books address)
  const taxInfos = (c.tax_info_list || []).map(taxInfoRow);
  // every saved address of the contact (billing, shipping and additional ones); empty ones left out
  const seen = new Set();
  const addresses = [c.billing_address, c.shipping_address, ...(c.addresses || [])]
    .filter((a) => a?.address_id && fmtAddress(a) && !seen.has(a.address_id) && seen.add(a.address_id))
    .map((a) => ({ id: a.address_id, text: fmtAddress(a), lines: addressLines(a), taxInfoId: a.tax_info_id || '' }));
  const has = (a) => addresses.some((x) => x.id === a?.address_id);
  res.json({
    name: c.contact_name, gstNo: c.gst_no || '', gstTreatment: c.gst_treatment || '', placeOfSupply: c.place_of_contact || '',
    addresses, taxInfos,
    billingAddressId: has(c.billing_address) ? c.billing_address.address_id : addresses[0]?.id || '',
    // no shipping address on the contact: use another saved address, else the billing one
    shippingAddressId: has(c.shipping_address) ? c.shipping_address.address_id
      : addresses.find((x) => x.id !== c.billing_address?.address_id)?.id || addresses[0]?.id || '',
  });
}));

// An address as display lines, like Books shows it: attention / street / street 2 / city / state PIN / country
const addressLines = (a = {}) => [
  a.attention, a.address, a.street2, a.city, [a.state, a.zip].filter(Boolean).join(' '), a.country,
  a.phone && `Phone: ${a.phone}`, a.fax && `Fax: ${a.fax}`,
].map((x) => String(x || '').trim()).filter(Boolean);

const taxInfoRow = (t) => ({
  id: t.tax_info_id, gstin: t.tax_registration_no || t.gst_no || '', treatment: t.tax_treatment || t.gst_treatment || '',
  placeOfSupply: t.place_of_supply || '', legalName: t.legal_name || '',
});

// New address on the customer in Books (then usable as billing / shipping on any document).
// Same fields as the Books address form: attention, country, tax information, address, street 2,
// city, state, PIN code, phone (with country code) and fax.
app.post('/api/zoho/customers/:id/address', wrap(async (req, res) => {
  const b = req.body;
  const str = (v) => String(v ?? '').trim();
  const country = str(b.country) || 'India';
  const india = country === 'India';
  if (!str(b.address)) throw fail('Address is required');
  if (!str(b.city)) throw fail('City is required');
  if (!str(b.state)) throw fail('State is required');
  if (india ? !/^[0-9]{6}$/.test(str(b.zip)) : !str(b.zip)) throw fail(india ? 'PIN code must be 6 digits' : 'PIN / ZIP code is required');
  const phone = str(b.phone);
  if (phone && !/^[0-9 -]{6,15}$/.test(phone)) throw fail('Phone must be 6–15 digits');
  const body = {
    attention: str(b.attention), address: str(b.address), street2: str(b.street2),
    city: str(b.city), state: str(b.state), zip: str(b.zip), country,
    ...(phone ? { phone: `${str(b.phoneCode) || '+91'} ${phone}` } : {}),
    ...(str(b.fax) ? { fax: str(b.fax) } : {}),
    ...(str(b.taxInfoId) ? { tax_info_id: str(b.taxInfoId) } : {}),
  };
  const r = await zoho('POST', `/contacts/${req.params.id}/address`, { body });
  const a = r.address_info || r.address || {};
  if (!a.address_id) throw fail('Books did not return the new address — check the customer in Zoho', 502);
  console.log(`Address added in Books to contact ${req.params.id}: ${a.address_id}`);
  res.json({ id: a.address_id, text: fmtAddress({ ...body, ...a }), lines: addressLines({ ...body, ...a }), taxInfoId: a.tax_info_id || body.tax_info_id || '' });
}));

// Everything the Books delivery-challan form needs: challan types, custom fields,
// locations with their warehouses, the Product reporting tag, taxes and states.
async function normalDcMeta() {
  const [ep, locs, taxes, product] = await Promise.all([
    cachedList('dcEditpage', () => zoho('GET', '/deliverychallans/editpage')),
    cachedList('locationsAll', () => zoho('GET', '/locations').then((d) => d.locations || [])),
    cachedList('taxes', () => zoho('GET', '/settings/taxes').then((d) => d.taxes || [])),
    cachedList('productTag', async () => {
      const t = ((await zoho('GET', '/reportingtags')).tags || []).find((x) => x.tag_name === 'Product' && x.is_active !== false);
      if (!t) return null;
      const o = await zoho('GET', `/reportingtags/${t.tag_id}/options/all`);
      return { tagId: t.tag_id, options: (o.results || []).map((x) => ({ id: x.option_id, name: x.option_name, depth: x.depth || 0 })) };
    }).catch(() => null),
  ]);
  return {
    challanTypes: (ep.challan_types || []).map((c) => ({ value: c.challan_type, label: c.challan_type_formatted })),
    customFields: (ep.custom_fields || []).filter((c) => c.is_active !== false)
      .map((c) => ({
        api: c.api_name, label: c.label, type: c.data_type, multiline: c.data_type === 'multiline', required: !!c.is_mandatory,
        options: c.data_type === 'dropdown' ? (c.values || []).filter((v) => v.is_active !== false).sort((a, b) => (a.order || 0) - (b.order || 0)).map((v) => v.name) : undefined,
      })),
    // header locations; warehouses = their line-item-only sub-locations (where the stock sits)
    locations: locs.filter((l) => l.type !== 'line_item_only').map((l) => ({
      id: l.location_id, name: l.location_name, state: l.address?.state_code || '', gstin: locationInfo(l, locs).gstin, address: locationLines(l),
      // address in parts, for filling the Dispatch From form
      parts: { street1: l.address?.street_address1 || '', street2: l.address?.street_address2 || '', city: l.address?.city || '', state: l.address?.state || '', zip: l.address?.postal_code || '' },
      warehouses: locs.filter((w) => w.parent_location_id === l.location_id).map((w) => ({ id: w.location_id, name: w.location_name })),
    })),
    product,
    // line-level custom fields; the CRM ones (Deal Number, Stock Out Deal) hold a CRM deal id
    lineFields: (ep.item_custom_fields || []).filter((c) => c.is_active !== false).map((c) => ({
      id: c.customfield_id, api: c.api_name, label: c.label, required: !!c.is_mandatory,
      crmModule: c.external_service_name === 'zoho_crm' ? c.external_service_module : '',
    })),
    taxes: taxRows(taxes),
    states: ZOHO_STATES,
  };
}

// One file per call (raw body, name in X-File-Name), attached to the challan in Books. Books allows 5 files of 10 MB.
// A Books location's address as display lines
const locationLines = (l) => {
  const a = l.address || {};
  return [a.attention, a.street_address1, a.street_address2, a.city, [a.state, a.postal_code].filter(Boolean).join(' '), a.country]
    .map((x) => String(x || '').trim()).filter(Boolean);
};

// One normal DC from Books, shaped for the app's print and status actions
app.get('/api/normal-dcs/:id', wrap(async (req, res) => {
  const meta = await normalDcMeta();
  const { deliverychallan: c } = await zoho('GET', `/deliverychallans/${req.params.id}`);
  const locs = await cachedList('locationsAll', () => zoho('GET', '/locations').then((d) => d.locations || []));
  const loc = locs.find((l) => l.location_id === c.location_id);
  const state = (code) => ZOHO_STATES.find((x) => x.code === code);
  const pos = state(c.place_of_supply);
  // "Delhi" on an address -> "07-Delhi"
  const stateOfAddress = (a) => { const x = ZOHO_STATES.find((s) => s.name.toLowerCase() === String(a?.state || '').trim().toLowerCase()); return x ? `${x.gst}-${x.name}` : a?.state || ''; };
  // header custom fields by label, e.g. { 'Contact Person': 'Ramesh', 'No of Boxes': '12' }
  const custom = Object.fromEntries((c.custom_fields || []).map((f) => [f.label, f.value_formatted ?? f.value ?? '']));
  const kind = (name) => (/IGST/i.test(name) ? 'igst' : /SGST|UTGST/i.test(name) ? 'sgst' : /CGST/i.test(name) ? 'cgst' : 'other');
  const lines = (c.line_items || []).map((l) => {
    const amount = r2((Number(l.quantity) || 0) * (Number(l.rate) || 0));
    const taxable = r2(l.item_total ?? amount);
    const taxes = { cgst: 0, sgst: 0, igst: 0 };
    for (const t of l.line_item_taxes || []) { const k = kind(t.tax_name); if (k !== 'other') taxes[k] = r2(taxes[k] + (Number(t.tax_amount) || 0)); }
    const pct = (v) => (taxable ? r2(v / taxable * 100) : 0);
    return {
      id: l.line_item_id, name: l.name, sku: l.sku || '', description: l.description || '', hsn: l.hsn_or_sac || '', unit: l.unit || '',
      quantity: Number(l.quantity) || 0, rate: Number(l.rate) || 0, amount, discount: r2(amount - taxable), taxable,
      cgst: taxes.cgst, sgst: taxes.sgst, igst: taxes.igst, cgstPct: pct(taxes.cgst), sgstPct: pct(taxes.sgst), igstPct: pct(taxes.igst),
      total: r2(taxable + taxes.cgst + taxes.sgst + taxes.igst), warehouse: l.location_name || '',
      deals: Object.fromEntries((l.item_custom_fields || []).map((f) => [f.label, f.value_formatted || ''])),
    };
  });
  const sum = (k) => r2(lines.reduce((a, l) => a + l[k], 0));
  res.json({
    id: c.deliverychallan_id, number: c.deliverychallan_number, date: c.date, status: c.status || c.challan_status || '',
    challanType: meta.challanTypes.find((t) => t.value === c.challan_type)?.label || c.challan_type || '',
    reference: c.reference_number || '', placeOfSupply: pos ? `${pos.gst}-${pos.name}` : c.place_of_supply || '',
    reverseCharge: c.is_reverse_charge_applied ? 'Yes' : 'No',
    ewayBill: (c.ewaybills || [])[0]?.ewaybill_number || '',
    product: (c.tags || []).map((t) => t.tag_option_name).filter(Boolean).join(', '),
    custom,
    location: loc ? { ...locationInfo(loc, locs), state: state(loc.address?.state_code) } : null,
    customer: {
      name: c.customer_name, gstin: c.gst_no || '', shipGstin: c.shipping_gst_no || c.gst_no || '',
      billing: addressLines(c.billing_address), shipping: addressLines(c.shipping_address),
      billState: stateOfAddress(c.billing_address), shipState: stateOfAddress(c.shipping_address),
    },
    lines,
    totals: {
      amount: sum('amount'), discount: sum('discount'), taxable: sum('taxable'), cgst: sum('cgst'), sgst: sum('sgst'), igst: sum('igst'),
      adjustment: Number(c.adjustment) || 0, total: Number(c.total) || 0,
    },
    notes: c.notes || '', terms: c.terms || '',
    url: zohoDcUrl(c.deliverychallan_id),
  });
}));

// Books status actions on a normal DC: draft -> open, open -> delivered
app.post('/api/normal-dcs/:id/status/:status', wrap(async (req, res) => {
  const { status } = req.params;
  if (!['open', 'delivered'].includes(status)) throw fail('Status can be open or delivered');
  await zoho('POST', `/deliverychallans/${req.params.id}/status/${status}`);
  console.log(`Delivery challan ${req.params.id} marked as ${status}`);
  res.json({ ok: true, status });
}));

app.post('/api/normal-dcs/:id/attachment', express.raw({ type: () => true, limit: '10mb' }), wrap(async (req, res) => {
  const name = decodeURIComponent(String(req.get('x-file-name') || '')).trim();
  if (!name) throw fail('File name missing');
  if (!req.body?.length) throw fail(`${name}: file is empty`);
  await zohoUpload(`/deliverychallans/${req.params.id}/attachment`, { name, type: req.get('content-type'), data: req.body });
  console.log(`Attached ${name} to delivery challan ${req.params.id}`);
  res.json({ ok: true, name });
}));

// CRM deals for the Deal Number / Stock Out Deal lookups on challan lines.
// No query: the 50 most recently changed deals; with a query: CRM word search (number, name, account…).
const DEAL_FIELDS = 'Deal_Name,Deal_Number,Account_Name,Stage';
const dealRow = (d) => ({ id: d.id, number: d.Deal_Number || '', name: d.Deal_Name || '', account: d.Account_Name?.name || '', stage: d.Stage || '' });
app.get('/api/crm/deals', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const out = q.length >= 2
    ? await zohoCrm('/Deals/search', { word: q, fields: DEAL_FIELDS, per_page: 50 })
    : await cachedList('recentDeals', () => zohoCrm('/Deals', { fields: DEAL_FIELDS, per_page: 50, sort_by: 'Modified_Time', sort_order: 'desc' }));
  res.json((out.data || []).map(dealRow));
}));

app.get('/api/normal-dc/meta', wrap(async (req, res) => res.json(await normalDcMeta())));

app.get('/api/normal-dcs', wrap(async (req, res) => {
  const d = await zoho('GET', '/deliverychallans', { query: { per_page: 200, sort_column: 'created_time', sort_order: 'D' } });
  res.json((d.deliverychallans || []).map((x) => ({
    id: x.deliverychallan_id, number: x.deliverychallan_number, date: x.date, customerName: x.customer_name,
    reference: x.reference_number || '', status: x.status || x.challan_status || '', total: x.total, location: x.location_name || '',
    url: zohoDcUrl(x.deliverychallan_id),
  })));
}));

// Form data (app) -> Books delivery-challan body, with all checks. Used for create and edit;
// on edit each line carries its Books line_item_id, and empty fields are sent so they clear.
async function normalDcBody(b) {
  const meta = await normalDcMeta();
  if (!b.customerId) throw fail('Select customer');
  if (!b.date) throw fail('Delivery challan date is required');
  if (!meta.challanTypes.some((c) => c.value === b.challanType)) throw fail('Select challan type');
  if (!meta.states.some((x) => x.code === b.placeOfSupply)) throw fail('Select place of supply');
  const loc = meta.locations.find((l) => l.id === b.locationId);
  if (meta.locations.length && !loc) throw fail('Select location');
  for (const c of meta.customFields) if (c.required && !String(b.custom?.[c.api] ?? '').trim()) throw fail(`${c.label} is required`);
  const lines = (b.lines || []).filter((l) => l.itemId);
  if (!lines.length) throw fail('Add at least one item');
  lines.forEach((l, i) => {
    const n = i + 1;
    if (!(Number(l.quantity) > 0)) throw fail(`Line ${n}: quantity must be more than 0`);
    if (!(Number(l.rate) >= 0)) throw fail(`Line ${n}: rate is not valid`);
    if (!(Number(l.discount || 0) >= 0 && Number(l.discount || 0) <= 100)) throw fail(`Line ${n}: discount must be 0–100%`);
    if (!l.taxId) throw fail(`Line ${n}: select tax`);
    for (const f of meta.lineFields) if (f.required && !l.fields?.[f.id]?.value) throw fail(`Line ${n}: ${f.label} is required`);
    // the location itself or one of its sub-warehouses
    if (loc && l.warehouseId && l.warehouseId !== loc.id && !loc.warehouses.some((w) => w.id === l.warehouseId)) throw fail(`Line ${n}: warehouse is not part of ${loc.name}`);
  });
  const option = meta.product?.options.find((o) => o.id === b.productOptionId);
  const registered = ['business_gst', 'business_registered_composition', 'business_sez', 'deemed_export'].includes(b.gstTreatment);
  const gstNo = String(b.gstNo || '').trim().toUpperCase();
  if (registered && !/^[0-9]{2}[A-Z0-9]{13}$/.test(gstNo)) throw fail('GSTIN is required for a registered customer (15 characters)');

  const number = String(b.dcNumber || '').trim();
  const body = {
    customer_id: b.customerId,
    ...(number ? { deliverychallan_number: number } : {}),
    date: b.date,
    challan_type: b.challanType,
    place_of_supply: b.placeOfSupply,
    reference_number: String(b.referenceNumber || '').trim(),
    ...(loc ? { location_id: loc.id } : {}),
    ...(b.billingAddressId ? { billing_address_id: b.billingAddressId } : {}),
    ...(b.shippingAddressId ? { shipping_address_id: b.shippingAddressId } : {}),
    ...(b.gstTreatment ? { gst_treatment: b.gstTreatment } : {}),
    ...(registered ? { gst_no: gstNo } : {}),
    discount_type: 'item_level',
    is_discount_before_tax: true,
    custom_fields: meta.customFields.map((c) => ({ api_name: c.api, value: String(b.custom?.[c.api] ?? '').trim() })),
    ...(meta.product ? { tags: option ? [{ tag_id: meta.product.tagId, tag_option_id: option.id }] : [] } : {}),
    notes: b.notes || '',
    terms: b.terms || '',
    line_items: lines.map((l) => ({
      ...(l.lineItemId ? { line_item_id: l.lineItemId } : {}),
      item_id: l.itemId,
      description: l.description || '',
      quantity: Number(l.quantity),
      rate: Number(l.rate) || 0,
      discount: Number(l.discount) > 0 ? `${Number(l.discount)}%` : 0,
      tax_id: l.taxId,
      ...(l.warehouseId || loc ? { location_id: l.warehouseId || loc.id } : {}),
      // Sent the way the Books screen sends them: by label, with the CRM deal id as value and the
      // deal number as value_formatted. Books silently drops CRM lookups sent any other way.
      item_custom_fields: meta.lineFields.map((f) => {
        const v = l.fields?.[f.id];
        return { label: f.label, value: String(v?.value || ''), value_formatted: String(v?.label || v?.value || '') };
      }),
    })),
  };
  return body;
}

app.post('/api/normal-dcs', wrap(async (req, res) => {
  const body = await normalDcBody(req.body);
  // a typed Delivery challan# is used as is; empty = Books numbers it from the location's series
  const r = await zoho('POST', '/deliverychallans', { body, query: body.deliverychallan_number ? { ignore_auto_number_generation: true } : {} });
  const d = r.deliverychallan;
  console.log(`Delivery challan created in Books: ${d.deliverychallan_number} (${d.deliverychallan_id})`);
  res.json({ id: d.deliverychallan_id, number: d.deliverychallan_number, total: d.total, url: zohoDcUrl(d.deliverychallan_id) });
}));

// A normal DC from Books in the app's form shape, for editing
app.get('/api/normal-dcs/:id/form', wrap(async (req, res) => {
  const meta = await normalDcMeta();
  const { deliverychallan: c } = await zoho('GET', `/deliverychallans/${req.params.id}`);
  // Books keeps only a copy of the shipping address on the challan: find the customer's saved address with the same text
  const findAddressId = async (copy) => {
    const text = fmtAddress(copy);
    if (!text) return '';
    const { contact: k } = await zoho('GET', `/contacts/${c.customer_id}`);
    return [k.billing_address, k.shipping_address, ...(k.addresses || [])].find((a) => a?.address_id && fmtAddress(a) === text)?.address_id || '';
  };
  // line discount: "10%" or "10.00%" as text, else work it out from the amount
  const pctOf = (l) => {
    if (typeof l.discount === 'string' && l.discount.includes('%')) return parseFloat(l.discount) || '';
    const gross = (Number(l.quantity) || 0) * (Number(l.rate) || 0);
    const amt = Number(l.discount_amount) || 0;
    return gross && amt ? r2(amt / gross * 100) : '';
  };
  res.json({
    id: c.deliverychallan_id, number: c.deliverychallan_number, status: c.status || c.challan_status || '',
    header: {
      customerId: c.customer_id, placeOfSupply: c.place_of_supply || '', locationId: c.location_id || '',
      dcNumber: c.deliverychallan_number || '', referenceNumber: c.reference_number || '', date: c.date, challanType: c.challan_type || 'others',
      productOptionId: (c.tags || []).find((t) => t.tag_id === meta.product?.tagId)?.tag_option_id || '',
      notes: c.notes || '', terms: c.terms || '',
      custom: Object.fromEntries((c.custom_fields || []).map((f) => [f.api_name, f.value ?? ''])),
      billingAddressId: c.billing_address_id || await findAddressId(c.billing_address),
      shippingAddressId: c.shipping_address_id || await findAddressId(c.shipping_address),
      gstTreatment: c.gst_treatment || '', gstNo: c.gst_no || '',
    },
    lines: (c.line_items || []).map((l) => ({
      lineItemId: l.line_item_id, itemId: l.item_id, description: l.description || '', hsn: l.hsn_or_sac || '', unit: l.unit || '',
      quantity: l.quantity, rate: l.rate, discount: pctOf(l), taxId: l.tax_id || '', warehouseId: l.location_id || '',
      // line custom fields keyed by field id, like the form keeps them: { value: <CRM id>, label: 'Deal/2026/1114' }
      fields: Object.fromEntries((l.item_custom_fields || []).filter((f) => f.value).map((f) => [f.customfield_id, { value: String(f.value), label: f.value_formatted || String(f.value) }])),
    })),
  });
}));

// Save changes to a normal DC in Books (Books allows editing draft and open challans)
app.put('/api/normal-dcs/:id', wrap(async (req, res) => {
  const body = await normalDcBody(req.body);
  const r = await zoho('PUT', `/deliverychallans/${req.params.id}`, { body, query: body.deliverychallan_number ? { ignore_auto_number_generation: true } : {} });
  const d = r.deliverychallan;
  console.log(`Delivery challan updated in Books: ${d.deliverychallan_number} (${d.deliverychallan_id})`);
  res.json({ id: d.deliverychallan_id, number: d.deliverychallan_number, total: d.total, url: zohoDcUrl(d.deliverychallan_id) });
}));

// Anything not answered above: unknown API route, bad JSON body, unexpected crash.
// Always reply in JSON so the app can show the real reason.
app.use('/api', (req, res) => res.status(404).json({ error: `Unknown API: ${req.method} ${req.originalUrl}` }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request data is not valid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Too large — files can be at most 10 MB each' });
  console.error('Unhandled error:', err);
  res.status(500).json({ error: `Server error: ${err.message}` });
});
process.on('unhandledRejection', (e) => console.error('Unhandled promise rejection:', e));

app.listen(PORT, HOST, () => {
  const cfg = configOk();
  console.log(`Job Work server on http://${HOST}:${PORT}`);
  if (!cfg.ok) console.warn(`⚠ Missing in server/.env: ${cfg.missing.join(', ')}`);
});
