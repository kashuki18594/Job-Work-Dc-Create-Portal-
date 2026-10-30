import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, lookup } from '../api';
import { toast } from '../components/Toaster';
import { inr, r2 } from '../calc';
import ItemPicker from '../components/ItemPicker';
import TaxSelect from '../components/TaxSelect';
import DealPicker from '../components/DealPicker';
import DispatchFromEditor from '../components/DispatchFromEditor';

const today = () => new Date().toISOString().slice(0, 10);
const blank = (warehouseId = '') => ({ key: Math.random(), itemId: '', description: '', hsn: '', unit: '', quantity: '', rate: '', discount: '', taxId: '', warehouseId, fields: {} });
const TREATMENT = {
  business_gst: 'Registered Business - Regular', business_registered_composition: 'Registered Business - Composition',
  business_none: 'Unregistered Business', consumer: 'Consumer', overseas: 'Overseas', business_sez: 'Special Economic Zone',
  deemed_export: 'Deemed Export',
};
const REGISTERED = ['business_gst', 'business_registered_composition', 'business_sez', 'deemed_export'];
const GSTIN_RE = /^[0-9]{2}[A-Z0-9]{13}$/;
const DISPATCH = 'cf_dispatch_from'; // Books custom field, edited with its own address form below the customer addresses

// Normal DC: the Zoho Books delivery challan form. New: saved into Books as a draft challan.
// With an :id it edits that challan: loaded from Books, saved back to it.
export default function NormalDCForm() {
  const nav = useNavigate();
  const { id } = useParams();
  const [dcNo, setDcNo] = useState('');
  const [meta, setMeta] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [items, setItems] = useState([]);
  const [cust, setCust] = useState(null); // details of the selected customer
  const [h, setH] = useState({ dcNumber: '', customerId: '', placeOfSupply: '', locationId: '', referenceNumber: '', date: today(), challanType: 'others', productOptionId: '', notes: '', terms: '', custom: {},
    billingAddressId: '', shippingAddressId: '', gstTreatment: '', gstNo: '' });
  const [warehouseId, setWarehouseId] = useState('');
  const [lines, setLines] = useState([blank()]);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState([]); // attachments, uploaded to Books after the challan is created
  const [newAddr, setNewAddr] = useState(null); // 'billingAddressId' | 'shippingAddressId' while the address form is open
  const setErr = (m) => m && toast.error(m);

  useEffect(() => {
    Promise.all([api.get('/api/normal-dc/meta'), lookup('customers'), lookup('items'), id ? api.get(`/api/normal-dcs/${id}/form`) : null])
      .then(([m, c, it, f]) => {
        setMeta(m); setCustomers(c); setItems(it);
        if (f) return loadForEdit(f);
        const loc = m.locations[0];
        if (loc) { setH((x) => ({ ...x, locationId: loc.id })); setWarehouseId(loc.id); setLines([blank(loc.id)]); }
      })
      .catch((e) => setErr(`Could not load: ${e.message}`));
  }, [id]);

  // edit: everything as saved in Books; stock is only shown, the saved warehouse stays
  function loadForEdit(f) {
    setDcNo(f.number);
    setH((x) => ({ ...x, ...f.header }));
    setWarehouseId(f.header.locationId);
    const ls = f.lines.map((l) => ({ ...blank(), ...l, key: l.lineItemId, stock: null }));
    setLines(ls.length ? ls : [blank(f.header.locationId)]);
    api.get(`/api/zoho/customers/${f.header.customerId}`).then(setCust).catch((e) => setErr(`Could not load customer: ${e.message}`));
    for (const l of ls) {
      api.get(`/api/zoho/items/${l.itemId}`)
        .then((d) => setLines((xs) => xs.map((x) => (x.key === l.key ? { ...x, stock: d.stockByLocation || {} } : x))))
        .catch(() => {});
    }
  }

  if (!meta || (id && !dcNo)) return <p className="muted">{id ? 'Loading the challan from Zoho Books…' : 'Loading customers, items and Books settings…'}</p>;

  const loc = meta.locations.find((l) => l.id === h.locationId);
  const intra = !!loc && !!h.placeOfSupply && loc.state === h.placeOfSupply;
  const scope = h.placeOfSupply && loc ? (intra ? 'intra' : 'inter') : '';
  const byId = (id) => items.find((i) => i.item_id === id);
  // where stock goes out from: the location itself or one of its sub-locations (e.g. Chennai, Chennai (Table Space))
  const optionsFor = (locId) => { const l = meta.locations.find((x) => x.id === locId); return l ? [{ id: l.id, name: l.name }, ...l.warehouses] : []; };
  const whOptions = optionsFor(h.locationId);
  // like Books: keep the chosen place if it has stock, else the sub-location with the most stock
  const bestWarehouse = (stock, opts, current) => {
    if (!stock || (current && stock[current] > 0)) return current;
    const best = opts.filter((o) => stock[o.id] > 0).sort((a, b) => stock[b.id] - stock[a.id])[0];
    return best?.id || current;
  };
  const taxById = (id) => meta.taxes.find((t) => t.tax_id === id);
  const stateName = (code) => meta.states.find((s) => s.code === code)?.name || code;
  // searchable by name, Zoho code (TN) or GST state code (33)
  const statePicks = meta.states.map((x) => ({ code: x.code, name: `[${x.code}] - ${x.name}`, info: `${x.code} · GST code ${x.gst}` }));

  // the item's own Books tax for this scope, else the same % in the other scope
  const taxFor = (item, curTaxId, sc) => {
    const own = sc === 'inter' ? item?.taxInterId : item?.taxIntraId;
    if (own) return own;
    const cur = taxById(curTaxId);
    return (cur && meta.taxes.find((t) => t.scope === sc && t.pct === cur.pct && t.group === (sc === 'intra')))?.tax_id || curTaxId;
  };
  const retax = (sc) => sc && setLines((ls) => ls.map((l) => (l.itemId ? { ...l, taxId: taxFor(byId(l.itemId), l.taxId, sc) } : l)));

  // header change; a new place of supply or location switches line taxes between intra and inter
  const setHead = (patch) => setH((x) => {
    const n = { ...x, ...patch };
    const nl = meta.locations.find((l) => l.id === n.locationId);
    if ('placeOfSupply' in patch || 'locationId' in patch) retax(nl && n.placeOfSupply ? (nl.state === n.placeOfSupply ? 'intra' : 'inter') : '');
    return n;
  });
  const setCf = (k, v) => setH((x) => ({ ...x, custom: { ...x.custom, [k]: v } }));

  async function pickCustomer(c) {
    if (!c) { setCust(null); return setHead({ customerId: '', billingAddressId: '', shippingAddressId: '', gstTreatment: '', gstNo: '' }); }
    setHead({ customerId: c.contact_id });
    try {
      const d = await api.get(`/api/zoho/customers/${c.contact_id}`);
      setCust(d);
      // defaults from the customer in Books; all can be changed for this challan
      setHead({
        billingAddressId: d.billingAddressId, shippingAddressId: d.shippingAddressId, gstTreatment: d.gstTreatment || 'business_none', gstNo: d.gstNo,
        ...(d.placeOfSupply ? { placeOfSupply: d.placeOfSupply } : {}),
      });
    } catch (e) { setErr(`Could not load customer: ${e.message}`); }
  }

  // choosing an address; a billing address tied to a GST registration brings its GSTIN and treatment
  function pickAddress(k, id, added) {
    const a = added || cust?.addresses.find((x) => x.id === id);
    const t = a?.taxInfoId && cust?.taxInfos.find((x) => x.id === a.taxInfoId);
    setHead({ [k]: id, ...(k === 'billingAddressId' && t?.gstin ? { gstNo: t.gstin, gstTreatment: t.treatment || 'business_gst' } : {}) });
  }

  function setLine(i, patch) {
    setLines((ls) => ls.map((l, idx) => {
      if (idx !== i) return l;
      const n = { ...l, ...patch };
      if ('itemId' in patch && patch.itemId !== l.itemId) {
        const it = byId(patch.itemId);
        Object.assign(n, { hsn: it?.hsn_or_sac || '', unit: it?.unit || '', rate: it?.rate || '', taxId: it ? taxFor(it, '', scope || 'intra') : '', stock: null });
        if (patch.itemId) loadStock(l.key, patch.itemId);
      }
      return n;
    }));
  }
  // stock per sub-location for the line's item, then pick where it goes out from
  async function loadStock(key, itemId) {
    try {
      const d = await api.get(`/api/zoho/items/${itemId}`);
      setLines((ls) => ls.map((l) => (l.key !== key || l.itemId !== itemId ? l
        : { ...l, stock: d.stockByLocation || {}, warehouseId: bestWarehouse(d.stockByLocation, optionsFor(h.locationId), l.warehouseId) })));
    } catch (e) { setErr(`Could not load stock for the item: ${e.message}`); }
  }
  function setWarehouse(id) {
    setWarehouseId(id);
    setLines((ls) => ls.map((l) => ({ ...l, warehouseId: id })));
  }
  function pickLocation(id) {
    setHead({ locationId: id });
    setWarehouseId(id);
    setLines((ls) => ls.map((l) => ({ ...l, warehouseId: bestWarehouse(l.stock, optionsFor(id), id) })));
  }

  // money, the way Books shows it: line amount after % discount; tax summary by CGST / SGST / IGST rate
  const money = lines.map((l) => {
    const amount = r2((Number(l.quantity) || 0) * (Number(l.rate) || 0) * (1 - (Number(l.discount) || 0) / 100));
    const t = taxById(l.taxId);
    return { amount, tax: t ? r2(amount * t.pct / 100) : 0, t };
  });
  const sub = r2(money.reduce((a, m) => a + m.amount, 0));
  const taxLines = {};
  for (const m of money) {
    if (!m.t || !m.tax) continue;
    const parts = m.t.group || m.t.scope === 'intra'
      ? [[`CGST ${m.t.pct / 2}%`, r2(m.tax / 2)], [`SGST ${m.t.pct / 2}%`, r2(m.tax - r2(m.tax / 2))]]
      : [[`IGST ${m.t.pct}%`, m.tax]];
    for (const [k, v] of parts) taxLines[k] = r2((taxLines[k] || 0) + v);
  }
  const taxTotal = r2(Object.values(taxLines).reduce((a, v) => a + v, 0));
  const exact = r2(sub + taxTotal);
  const total = Math.round(exact);

  async function save() {
    const miss = [];
    if (!h.customerId) miss.push('Customer');
    if (REGISTERED.includes(h.gstTreatment) && !GSTIN_RE.test(h.gstNo)) miss.push('GSTIN (15 characters)');
    if (!h.placeOfSupply) miss.push('Place of supply');
    if (!h.date) miss.push('Delivery challan date');
    if (!h.challanType) miss.push('Challan type');
    lines.forEach((l, i) => {
      if (!l.itemId) return;
      const m = [!(Number(l.quantity) > 0) && 'Quantity', !l.taxId && 'Tax', !l.warehouseId && 'Warehouse',
        ...meta.lineFields.filter((f) => f.required && !l.fields[f.id]?.value).map((f) => f.label)].filter(Boolean);
      if (m.length) miss.push(`Line ${i + 1}: ${m.join(', ')}`);
    });
    if (!lines.some((l) => l.itemId)) miss.push('At least one item');
    if (miss.length) return setErr(`Fill required fields — ${miss.join(' · ')}`);
    setBusy(true);
    try {
      const body = { ...h, lines: lines.filter((l) => l.itemId) };
      const r = id ? await api.put(`/api/normal-dcs/${id}`, body) : await api.post('/api/normal-dcs', body);
      toast.success(`Delivery challan ${r.number} ${id ? 'updated' : 'created'} in Zoho Books`);
      // the challan exists now; an attachment that fails is reported but doesn't undo it
      for (const f of files) {
        try { await uploadAttachment(r.id, f); }
        catch (e) { toast.error(`${r.number} saved, but ${f.name} was not attached: ${e.message}. Attach it in Zoho.`); }
      }
      if (files.length) toast.success(`${files.length} file(s) processed for ${r.number}`);
      nav('/?kind=normal');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const req = (t) => <span>{t} <b className="req">*</b></span>;
  const cfs = meta.customFields;

  return (
    <>
      <div className="head"><h1>{id ? `Edit ${dcNo}` : 'New Delivery Challan'} <span className="chip chip-normal">Normal · Zoho Books</span></h1></div>

      <section className="card">
        <div className="form2">
          <label>{req('Customer name')}
            <ItemPicker items={customers} value={h.customerId} onChange={pickCustomer} placeholder="Search customer / GSTIN"
              idKey="contact_id" codeKey="info" subOf={(c) => c.info || ''} />
          </label>
          <div />
        </div>
        {cust && (
          <div className="form4" style={{ marginTop: 12 }}>
            {[['billingAddressId', 'Billing address'], ['shippingAddressId', 'Shipping address']].map(([k, label]) => (
              <label key={k} className="span2">
                <span className="lbl-row">{label}<button type="button" className="link" onClick={() => setNewAddr(k)}>+ New address</button></span>
                <select value={h[k]} onChange={(e) => pickAddress(k, e.target.value)}>
                  {cust.addresses.length === 0 && <option value="">No address saved on this customer</option>}
                  {cust.addresses.map((a) => <option key={a.id} value={a.id}>{a.text}</option>)}
                </select>
                <AddressBlock a={cust.addresses.find((a) => a.id === h[k])} />
              </label>
            ))}
            <label>GST treatment
              <select value={h.gstTreatment} onChange={(e) => setHead({ gstTreatment: e.target.value })}>
                {Object.entries(TREATMENT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            {REGISTERED.includes(h.gstTreatment) && (
              <label>{req('GSTIN')}
                <input value={h.gstNo} maxLength={15} onChange={(e) => setHead({ gstNo: e.target.value.toUpperCase().trim() })}
                  className={GSTIN_RE.test(h.gstNo) ? '' : 'need'} placeholder="e.g. 07AAECB6158P1Z5" />
              </label>
            )}
          </div>
        )}
        {cfs.some((c) => c.api === DISPATCH) && (
          <div className="form4" style={{ marginTop: 12 }}>
            <DispatchFromEditor value={h.custom[DISPATCH] || ''} onChange={(v) => setCf(DISPATCH, v)} locations={meta.locations} states={meta.states} />
          </div>
        )}
        <div className="form4" style={{ marginTop: 12 }}>
          <label>{req('Place of supply')}
            <ItemPicker items={statePicks} value={h.placeOfSupply} onChange={(x) => setHead({ placeOfSupply: x?.code || '' })}
              placeholder="Search state / code" idKey="code" codeKey="info" subOf={(x) => x.info} />
          </label>
          <label>Location
            <select value={h.locationId} onChange={(e) => pickLocation(e.target.value)}>
              {meta.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            {loc && <span className="sub">Source of supply: {stateName(loc.state)}</span>}
          </label>
        </div>
      </section>

      <section className="card">
        <div className="form4">
          <label>Delivery challan#
            <input value={h.dcNumber} onChange={(e) => setHead({ dcNumber: e.target.value.toUpperCase() })} placeholder="Leave empty: Zoho numbers it" />
          </label>
          <label>Reference#<input value={h.referenceNumber} onChange={(e) => setHead({ referenceNumber: e.target.value })} /></label>
          <label>{req('Delivery challan date')}<input type="date" value={h.date} onChange={(e) => setHead({ date: e.target.value })} /></label>
          <label>{req('Challan type')}
            <select value={h.challanType} onChange={(e) => setHead({ challanType: e.target.value })}>
              {meta.challanTypes.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
          {cfs.filter((c) => !c.multiline).map((c) => c.options ? (
            <label key={c.api}>{c.required ? req(c.label) : c.label}
              <select value={h.custom[c.api] || ''} onChange={(e) => setCf(c.api, e.target.value)}>
                <option value="">— Select —</option>
                {c.options.map((o) => <option key={o}>{o}</option>)}
              </select>
            </label>
          ) : (
            <label key={c.api} className={c.type === 'number' || c.type === 'phone' || /vehicle/i.test(c.label) ? '' : 'span2'}>{c.required ? req(c.label) : c.label}
              <input type={c.type === 'number' ? 'number' : c.type === 'phone' ? 'tel' : 'text'} min={c.type === 'number' ? 0 : undefined}
                value={h.custom[c.api] || ''} onChange={(e) => setCf(c.api, c.type === 'phone' ? e.target.value.replace(/[^0-9+ -]/g, '') : e.target.value)} />
            </label>
          ))}
          {meta.product && (
            <label>Product
              <select value={h.productOptionId} onChange={(e) => setHead({ productOptionId: e.target.value })}>
                <option value="">— None —</option>
                {meta.product.options.map((o) => <option key={o.id} value={o.id}>{'  '.repeat(o.depth)}{o.name}</option>)}
              </select>
            </label>
          )}
          {cfs.filter((c) => c.multiline && c.api !== DISPATCH).map((c) => (
            <label key={c.api} className="span2">{c.required ? req(c.label) : c.label}<textarea rows={2} value={h.custom[c.api] || ''} onChange={(e) => setCf(c.api, e.target.value)} /></label>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="item-bar">
          <h2>Item table</h2>
          {loc && (
            <label className="inline">Warehouse location <span className="sub">(set all lines)</span>
              <select value={warehouseId} onChange={(e) => setWarehouse(e.target.value)}>
                {whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="scroll">
          <table className="grid edit">
            <thead>
              <tr>
                <th>#</th><th style={{ minWidth: 300 }}>Item details</th>
                {meta.lineFields.map((f) => <th key={f.id} style={{ minWidth: 170 }}>{f.required ? req(f.label) : f.label}</th>)}
                <th>{req('Quantity')}</th><th>Rate</th><th>Discount %</th>
                <th style={{ minWidth: 190 }}>{req('Tax')}</th><th className="r">Amount</th><th></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const it = byId(l.itemId);
                return (
                  <tr key={l.key}>
                    <td>{i + 1}</td>
                    <td>
                      <ItemPicker items={items} value={l.itemId} onChange={(x) => setLine(i, { itemId: x?.item_id || '' })} />
                      {l.itemId && <>
                        <textarea rows={1} placeholder="Add a description to your item" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} style={{ marginTop: 6 }} />
                        <div className="sub">{[it?.product_type === 'service' ? 'SERVICE' : 'GOODS', l.hsn && `HSN ${l.hsn}`, l.stock && `Stock at this warehouse ${l.stock[l.warehouseId] ?? 0} ${l.unit}`].filter(Boolean).join(' · ')}</div>
                        {whOptions.length > 0 && (
                          <label className="inline line-wh">Warehouse
                            <select value={l.warehouseId} onChange={(e) => setLine(i, { warehouseId: e.target.value })}>
                              {whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}{l.stock ? ` — stock ${l.stock[w.id] ?? 0} ${l.unit}` : ''}</option>)}
                            </select>
                          </label>
                        )}
                        {l.stock && Number(l.quantity) > (l.stock[l.warehouseId] ?? 0) && (
                          <div className="sub warn">Only {l.stock[l.warehouseId] ?? 0} {l.unit} in {whOptions.find((w) => w.id === l.warehouseId)?.name}</div>
                        )}
                      </>}
                    </td>
                    {meta.lineFields.map((f) => (
                      <td key={f.id}>
                        {f.crmModule === 'Deals'
                          ? <DealPicker value={l.fields[f.id] || null} hint={cust?.name} invalid={l.itemId && f.required && !l.fields[f.id]?.value}
                              onChange={(v) => setLine(i, { fields: { ...l.fields, [f.id]: v } })} />
                          : <input value={l.fields[f.id]?.value || ''} onChange={(e) => setLine(i, { fields: { ...l.fields, [f.id]: { value: e.target.value } } })} />}
                      </td>
                    ))}
                    <td>
                      <input type="number" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} style={{ width: 80 }} className={l.itemId && !(Number(l.quantity) > 0) ? 'need' : ''} />
                      {l.unit && <div className="sub">{l.unit}</div>}
                    </td>
                    <td><input type="number" step="0.01" value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} style={{ width: 95 }} /></td>
                    <td><input type="number" step="0.01" min="0" max="100" value={l.discount} onChange={(e) => setLine(i, { discount: e.target.value })} style={{ width: 70 }} /></td>
                    <td><TaxSelect taxes={meta.taxes} value={l.taxId} onChange={(v) => setLine(i, { taxId: v })} scope={scope} /></td>
                    <td className="r strong">{inr(money[i].amount)}</td>
                    <td><button className="x" title="Remove" onClick={() => setLines(lines.length > 1 ? lines.filter((_, j) => j !== i) : [blank(warehouseId)])}>×</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button className="btn" onClick={() => setLines([...lines, blank(warehouseId)])}>+ Add new row</button>

        <div className="nd-bottom">
          <div className="nd-notes">
            <label>Customer notes<textarea rows={3} value={h.notes} onChange={(e) => setHead({ notes: e.target.value })} placeholder="Enter any notes to be displayed in your transaction" /></label>
          </div>
          <table className="nd-totals"><tbody>
            <tr><td>Sub total</td><td>{inr(sub)}</td></tr>
            {Object.entries(taxLines).map(([k, v]) => <tr key={k}><td>{k}</td><td>{inr(v)}</td></tr>)}
            <tr><td>Round off</td><td>{inr(r2(total - exact))}</td></tr>
            <tr className="grand"><td>Total (Rs.)</td><td>{inr(total)}</td></tr>
          </tbody></table>
        </div>
        <p className="hint">{scope === 'intra' ? 'Place of supply is the same state as the location: CGST + SGST.' : scope === 'inter' ? 'Place of supply is another state: IGST.' : 'Pick place of supply and location to set the tax.'} Rate, HSN and tax come from the item in Books. Totals here are a preview; Books calculates the final figures.</p>
      </section>

      <section className="card nd-foot">
        <label>Terms & conditions<textarea rows={4} value={h.terms} onChange={(e) => setHead({ terms: e.target.value })} placeholder="Enter the terms and conditions of your business to be displayed in your transaction" /></label>
        <Attachments files={files} setFiles={setFiles} />
      </section>

      <div className="actions">
        <button className="btn" onClick={() => nav(-1)} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Saving in Zoho Books…' : id ? 'Save changes in Zoho Books' : 'Save in Zoho Books (draft)'}</button>
      </div>
      {newAddr && cust && (
        <AddressModal customerId={h.customerId} customerName={cust.name} states={meta.states} taxInfos={cust.taxInfos} onClose={() => setNewAddr(null)}
          onSaved={(a) => {
            setCust((c) => ({ ...c, addresses: [...c.addresses, a] }));
            pickAddress(newAddr, a.id, a);
            toast.success('Address added to the customer in Zoho Books');
            setNewAddr(null);
          }} />
      )}
    </>
  );
}

// "+ New address": the Books address form. Saved on the customer in Books, then selected on this challan.
const COUNTRIES = ['India', 'United Arab Emirates', 'United States', 'United Kingdom', 'Singapore', 'Germany', 'Italy', 'China', 'Nepal', 'Bangladesh', 'Sri Lanka', 'Saudi Arabia', 'Qatar', 'Oman', 'Australia', 'Canada'];
const PHONE_CODES = ['+91', '+971', '+1', '+44', '+65', '+49', '+39', '+86', '+977', '+880', '+94', '+966', '+974', '+968', '+61'];

function AddressModal({ customerId, customerName, states, taxInfos, onClose, onSaved }) {
  const [a, setA] = useState({ attention: '', country: 'India', taxInfoId: '', address: '', street2: '', city: '', state: '', zip: '', phoneCode: '+91', phone: '', fax: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setA({ ...a, [k]: e.target.value });
  const india = a.country === 'India';

  async function save() {
    const miss = [
      !a.address.trim() && 'Address', !a.city.trim() && 'City', !a.state.trim() && 'State',
      (india ? !/^[0-9]{6}$/.test(a.zip.trim()) : !a.zip.trim()) && (india ? 'Pin code (6 digits)' : 'Pin / ZIP code'),
      a.phone && !/^[0-9 -]{6,15}$/.test(a.phone.trim()) && 'Phone (6–15 digits)',
    ].filter(Boolean);
    if (miss.length) return toast.error(`Fill: ${miss.join(', ')}`);
    setBusy(true);
    try { onSaved(await api.post(`/api/zoho/customers/${customerId}/address`, a)); }
    catch (e) { toast.error(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal-head"><h2>New address · {customerName}</h2><button className="x" onClick={onClose} disabled={busy}>×</button></div>
        <div className="form2">
          <label className="span2">Attention<input value={a.attention} onChange={set('attention')} autoFocus /></label>
          <label className="span2">Country/Region
            <select value={a.country} onChange={(e) => setA({ ...a, country: e.target.value, state: '', taxInfoId: e.target.value === 'India' ? a.taxInfoId : '' })}>
              {COUNTRIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          {india && (
            <label className="span2">Tax information
              <select value={a.taxInfoId} onChange={set('taxInfoId')} disabled={!taxInfos.length}>
                <option value="">{taxInfos.length ? '— None —' : 'No GST registration saved on this customer'}</option>
                {taxInfos.map((t) => <option key={t.id} value={t.id}>{[t.gstin, t.placeOfSupply, t.legalName].filter(Boolean).join(' · ')}</option>)}
              </select>
            </label>
          )}
          <label className="span2"><span>Address <b className="req">*</b></span><textarea rows={2} value={a.address} onChange={set('address')} placeholder="Street 1" /></label>
          <label className="span2"><textarea rows={2} value={a.street2} onChange={set('street2')} placeholder="Street 2" /></label>
          <label className="span2"><span>City <b className="req">*</b></span><input value={a.city} onChange={set('city')} /></label>
          <label><span>State <b className="req">*</b></span>
            {india ? (
              <select value={a.state} onChange={set('state')}>
                <option value="">Select state…</option>
                {states.map((s) => <option key={s.code} value={s.name}>{s.name}</option>)}
              </select>
            ) : <input value={a.state} onChange={set('state')} />}
          </label>
          <label><span>Pin code <b className="req">*</b></span>
            <input value={a.zip} maxLength={india ? 6 : 12} onChange={(e) => setA({ ...a, zip: india ? e.target.value.replace(/\D/g, '') : e.target.value })} />
          </label>
          <label>Phone
            <span className="phone-in">
              <select value={a.phoneCode} onChange={set('phoneCode')}>{PHONE_CODES.map((c) => <option key={c}>{c}</option>)}</select>
              <input value={a.phone} onChange={(e) => setA({ ...a, phone: e.target.value.replace(/[^0-9 -]/g, '') })} />
            </span>
          </label>
          <label>Fax number<input value={a.fax} onChange={set('fax')} /></label>
        </div>
        <p className="hint">Saved on the customer in Zoho Books, so it is also available on invoices and other challans.</p>
        <div className="actions">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Saving in Books…' : 'Save address'}</button>
        </div>
      </div>
    </div>
  );
}

// An address the way Books prints it: one part per line
function AddressBlock({ a }) {
  if (!a) return null;
  return <div className="addr-block">{(a.lines?.length ? a.lines : [a.text]).map((x, i) => <div key={i} className={i === 0 ? 'strong' : ''}>{x}</div>)}</div>;
}

const MAX_FILES = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// "Attach File(s) to Delivery Challan": up to 5 files, 10 MB each (the Books limits)
function Attachments({ files, setFiles }) {
  function add(list) {
    const next = [...files];
    for (const f of list) {
      if (next.length >= MAX_FILES) { toast.error(`At most ${MAX_FILES} files`); break; }
      if (f.size > MAX_BYTES) { toast.error(`${f.name} is ${kb(f.size)} — max 10 MB per file`); continue; }
      if (next.some((x) => x.name === f.name && x.size === f.size)) continue;
      next.push(f);
    }
    setFiles(next);
  }
  return (
    <div className="attach">
      <div className="attach-title">Attach file(s) to delivery challan</div>
      <label className="btn attach-btn">
        <input type="file" multiple hidden onChange={(e) => { add([...e.target.files]); e.target.value = ''; }} disabled={files.length >= MAX_FILES} />
        ⤒ Upload file
      </label>
      <div className="sub">You can upload a maximum of {MAX_FILES} files, 10MB each</div>
      {files.length > 0 && (
        <ul className="attach-list">
          {files.map((f, i) => (
            <li key={f.name + f.size}><span>{f.name}</span><span className="sub">{kb(f.size)}</span>
              <button className="x" title="Remove" onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function uploadAttachment(dcId, file) {
  const res = await fetch(`/api/normal-dcs/${dcId}/attachment`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    body: file,
  }).catch(() => null);
  if (!res) throw new Error('app server not reachable');
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `upload failed (${res.status})`);
}
