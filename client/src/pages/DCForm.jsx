import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { addToLookup, api, lookup } from '../api';
import { toast } from '../components/Toaster';
import { inr, r2 } from '../calc';
import { isIntra, lineTax, stateOf } from '../gst';
import ItemPicker from '../components/ItemPicker';
import NewItemModal from '../components/NewItemModal';

// choosing a location: its address and GSTIN become "Dispatch from" (and the print header)
const locationPatch = (l, co) => ({
  locationId: l.location_id, dispatchName: co.name || '', dispatchFrom: l.address.join('\n'), dispatchGstin: l.gstin || co.gstin || '', dispatchState: '',
});
const blank = (gstRate = 18) => ({ key: Math.random(), rawItemId: '', coating: '', coatedItemId: '', hsn: '', unit: '', pcs: '', rawCostPerPc: '', discount: '', gstRate, locationId: '', stock: null });
const RATES = [0, 5, 12, 18, 28];

// header fields printed on the DC (see PRINT_KEYS on the server)
const HEADER = {
  dcNo: '', vendorId: '', locationId: '', vehicleNo: '', ewayBillNo: '', transporter: '', transportMode: 'By Road', remarks: '',
  reverseCharge: 'No', placeOfSupply: '', workOrder: '', orderDate: '', contactPerson: '', contactMobile: '', packages: '', mdfNo: '', terms: '',
  billToName: '', billingAddress: '', billToGstin: '', billToState: '',
  shipToName: '', shippingAddress: '', shipToGstin: '', shipToState: '',
  dispatchName: '', dispatchFrom: '', dispatchGstin: '', dispatchState: '',
};

export default function DCForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const [items, setItems] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [locations, setLocations] = useState([]); // Books locations and sub-locations
  const lastMain = useRef(null);
  const [settings, setSettings] = useState(null);
  const [maps, setMaps] = useState([]);
  const [h, setH] = useState({ ...HEADER, date: new Date().toISOString().slice(0, 10) });
  const [addrBusy, setAddrBusy] = useState(false);
  const [newItem, setNewItem] = useState(null); // { idx, field, initial }
  const [lines, setLines] = useState([blank()]);
  const setErr = (m) => m && toast.error(m);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      lookup('items'), lookup('vendors'), api.get('/api/settings'), api.get('/api/mappings'),
      id ? api.get(`/api/dcs/${id}`) : null, lookup('locations').catch(() => []),
    ]).then(([it, ve, st, mp, dc, lo]) => {
      setItems(it); setVendors(ve); setSettings(st); setMaps(mp);
      const locs = lo.filter((l) => l.type !== 'line_item_only');
      setLocations(lo);
      lastMain.current = dc?.locationId || null;
      if (dc) {
        if (dc.status !== 'draft') return nav(`/dc/${id}`);
        setH({ ...Object.fromEntries(Object.keys(HEADER).map((k) => [k, dc[k] ?? HEADER[k]])), date: dc.date });
        setLines(dc.lines.map((l) => ({ ...l, key: l.id, discount: l.discount || '', gstRate: l.gstRate ?? dc.gstRate ?? st.dcGstRate ?? 18 })));
        dc.lines.forEach((l) => loadStock(l.id, l.rawItemId));
      } else {
        const co = st.company || {};
        // default location: the stock location from Settings (or its parent), else the primary one
        const set = lo.find((l) => l.location_id === st.locationId);
        const def = (set && (locs.find((l) => l.location_id === set.location_id) || locs.find((l) => l.location_id === set.parent)))
          || locs.find((l) => l.primary) || locs[0];
        setH((x) => ({ ...x, ...(def ? locationPatch(def, co) : { dispatchName: co.name || '', dispatchFrom: co.dispatchAddress || co.address || '', dispatchGstin: co.gstin || '' }) }));
        setLines([blank(st.dcGstRate ?? 18)]);
      }
    }).catch((e) => setErr(e.message)).finally(() => setLoading(false));
  }, [id]);

  const byId = (iid) => items.find((i) => i.item_id === iid);

  const mapFor = (rawItemId, coating) => maps.find((m) => m.rawItemId === rawItemId && m.coating === coating);

  // stock per location for the line's raw item; a line with no location yet goes to where the stock is
  async function loadStock(key, itemId) {
    try {
      const { stockByLocation: stock = {} } = await api.get(`/api/zoho/items/${itemId}`);
      const best = Object.entries(stock).sort((a, b) => b[1] - a[1])[0];
      setLines((ls) => ls.map((l) => (l.key !== key ? l : { ...l, stock, locationId: l.locationId || (best?.[1] > 0 ? best[0] : '') })));
    } catch (e) { setErr(`Could not load stock: ${e.message}`); }
  }

  // the first line's main location fills Dispatch from and the print header
  const firstLoc = locations.find((x) => x.location_id === lines[0]?.locationId);
  const mainId = firstLoc?.parent || firstLoc?.location_id || '';
  useEffect(() => {
    const main = locations.find((x) => x.location_id === mainId);
    if (!main || mainId === lastMain.current) return;
    lastMain.current = mainId;
    setH((x) => ({ ...x, ...locationPatch(main, settings?.company || {}) }));
  }, [mainId, locations]);

  function setLine(i, patch) {
    setLines((ls) => ls.map((l, idx) => {
      if (idx !== i) return l;
      const n = { ...l, ...patch };
      // auto-fill the new item used last time for this raw item + coating
      if (('rawItemId' in patch || 'coating' in patch) && n.rawItemId && n.coating) {
        const m = mapFor(n.rawItemId, n.coating);
        if (m && byId(m.coatedItemId)) n.coatedItemId = m.coatedItemId;
      }
      if ('rawItemId' in patch && patch.rawItemId !== l.rawItemId) {
        // new raw item: take its rate, HSN, unit and GST from Books, don't keep the previous item's
        const it = byId(patch.rawItemId);
        n.rawCostPerPc = 'rawCostPerPc' in patch ? patch.rawCostPerPc : (it?.purchase_rate || '');
        n.hsn = it?.hsn_or_sac || '';
        n.unit = it?.unit || '';
        n.stock = null;
        if (patch.rawItemId) loadStock(l.key, patch.rawItemId);
        if (it?.gstRate != null) n.gstRate = it.gstRate;
      }
      return n;
    }));
  }

  // "+ Create item" from a line. A coated item starts as a copy of the line's raw item
  // (brand, HSN, unit, additional info) with the raw item's cost.
  async function startCreate(idx, field, q) {
    const l = lines[idx];
    if (field === 'coatedItemId' && l.rawItemId) {
      try {
        const raw = await api.get(`/api/zoho/items/${l.rawItemId}`);
        const name = q || [raw.name, l.coating].filter(Boolean).join(' ');
        return setNewItem({ idx, field, initial: {
          name, sku: name, unit: raw.unit, brand: raw.brand, manufacturer: raw.manufacturer, hsn_or_sac: raw.hsn_or_sac,
          rate: raw.rate || 0, description: raw.description, purchase_rate: Number(l.rawCostPerPc) || raw.purchase_rate || 0,
          // new finish: coating as Finish, Finish Code left for the user (raw item's code would be wrong)
          custom: { ...raw.custom, cf_finish_code: '', ...(l.coating ? { cf_finish: l.coating } : {}) },
        } });
      } catch (e) { setErr(`Could not read raw item: ${e.message}`); }
    }
    setNewItem({ idx, field, initial: { name: q, sku: q } });
  }

  function itemCreated(row) {
    setItems(addToLookup('items', row));
    setLine(newItem.idx, { [newItem.field]: row.item_id, ...(newItem.field === 'rawItemId' ? { rawCostPerPc: row.purchase_rate || '' } : {}) });
    setNewItem(null);
  }

  // new job worker: fill bill-to / ship-to from the contact's addresses in Books
  async function pickVendor(vendorId) {
    const clear = { billToName: '', billingAddress: '', billToGstin: '', billToState: '', shipToName: '', shippingAddress: '', shipToGstin: '', shipToState: '' };
    if (!vendorId) return setH((x) => ({ ...x, vendorId: '', ...clear }));
    setH((x) => ({ ...x, vendorId }));
    setAddrBusy(true);
    try {
      const v = await api.get(`/api/zoho/vendors/${vendorId}`);
      setH((x) => (x.vendorId !== vendorId ? x : {
        ...x, ...clear,
        billToName: v.vendorName || '', billingAddress: v.vendorAddress || '', billToGstin: v.vendorGstin || '',
        shipToName: v.vendorName || '', shippingAddress: v.vendorShipAddress || v.vendorAddress || '', shipToGstin: v.vendorGstin || '',
      }));
    } catch (e) { setErr(`Could not load vendor address: ${e.message}`); } finally { setAddrBusy(false); }
  }

  // HSN, UOM, Qty and Rate are required on every line that has a raw item
  const missing = (l) => [
    !String(l.hsn || '').trim() && 'HSN / SAC', !String(l.unit || '').trim() && 'UOM',
    !l.locationId && 'Location', !(Number(l.pcs) > 0) && 'Qty', !(Number(l.rawCostPerPc) > 0) && 'Rate',
  ].filter(Boolean);
  const need = (l, empty) => (l.rawItemId && empty ? 'need' : '');

  async function save() {
    const bad = lines.map((l, i) => l.rawItemId && missing(l).length && `Line ${i + 1}: ${missing(l).join(', ')}`).filter(Boolean);
    if (!h.dcNo.trim()) bad.unshift('DC No');
    if (bad.length) return setErr(`Fill required fields — ${bad.join(' · ')}`);
    setBusy(true);
    try {
      const body = {
        ...h,
        vendorName: vendors.find((v) => v.contact_id === h.vendorId)?.name,
        lines: lines.filter((l) => l.rawItemId).map((l) => {
          const raw = byId(l.rawItemId) || {}, coated = byId(l.coatedItemId) || {};
          return {
            id: l.id, rawItemId: l.rawItemId, rawName: raw.name || l.rawName, rawSku: raw.sku || l.rawSku, hsn: l.hsn || raw.hsn_or_sac, unit: l.unit || raw.unit,
            coating: l.coating, coatedItemId: l.coatedItemId, coatedName: coated.name || l.coatedName, coatedSku: coated.sku || l.coatedSku,
            pcs: Number(l.pcs), rawCostPerPc: Number(l.rawCostPerPc), locationId: l.locationId, locationName: locations.find((x) => x.location_id === l.locationId)?.name || l.locationName || '', discount: Number(l.discount) || 0, gstRate: l.gstRate,
          };
        }),
      };
      const dc = id ? await api.put(`/api/dcs/${id}`, body) : await api.post('/api/dcs', body);
      nav(`/dc/${dc.id}`);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  if (loading) return <p className="muted">Loading items & vendors from Zoho Books…</p>;

  const pos = h.placeOfSupply || h.shipToState || stateOf(h.shipToGstin);
  const intra = isIntra(pos, h.dispatchGstin);
  const money = lines.map((l) => lineTax(l, intra));
  const tot = (k) => r2(money.reduce((a, m) => a + m[k], 0));
  const qty = lines.reduce((a, l) => a + (Number(l.pcs) || 0), 0);
  // GST rate picker sits in the tax column that applies: CGST (half rate) or IGST (full rate)
  const ratePick = (l, i, half) => (
    <select value={l.gstRate} onChange={(e) => setLine(i, { gstRate: Number(e.target.value) })} style={{ width: 72 }}>
      {RATES.map((r) => <option key={r} value={r}>{half ? r / 2 : r}%</option>)}
    </select>
  );
  const set = (k) => (e) => setH({ ...h, [k]: e.target.value });
  const party = (title, p, addrKey) => (
    <div className="party-edit">
      <div className="party-title">{title}</div>
      <label>Name<input value={h[`${p}Name`]} onChange={set(`${p}Name`)} /></label>
      <label>Address<textarea rows={3} value={h[addrKey]} onChange={set(addrKey)} /></label>
      <div className="form2">
        <label>GSTIN<input value={h[`${p}Gstin`]} onChange={(e) => setH({ ...h, [`${p}Gstin`]: e.target.value.toUpperCase() })} /></label>
        <label>State<input value={h[`${p}State`]} onChange={set(`${p}State`)} placeholder={stateOf(h[`${p}Gstin`]) || 'e.g. 07-Delhi'} /></label>
      </div>
    </div>
  );

  return (
    <>
      <div className="head"><h1>{id ? 'Edit DC (draft)' : 'New Delivery Challan — Job Work'}</h1></div>

      <section className="card">
        <h2>Challan details</h2>
        <div className="form4">
          <label><span>DC No <b className="req">*</b></span>
            <input value={h.dcNo} onChange={(e) => setH({ ...h, dcNo: e.target.value.toUpperCase() })} placeholder="e.g. JW/26-27/0001"
              className={h.dcNo.trim() ? '' : 'need'} />
          </label>
          <label>Job worker *
            <ItemPicker items={vendors} value={h.vendorId} onChange={(v) => pickVendor(v?.contact_id || '')} placeholder="Search vendor / company / GSTIN"
              idKey="contact_id" codeKey="info" subOf={(v) => v.info || 'No GSTIN'} />
          </label>
          <label>Challan date<input type="date" value={h.date} onChange={set('date')} /></label>
          <label>Reverse charges
            <select value={h.reverseCharge} onChange={set('reverseCharge')}><option>No</option><option>Yes</option></select>
          </label>
          <label>Transport mode
            <select value={h.transportMode} onChange={set('transportMode')}>
              {['By Road', 'By Rail', 'By Air', 'By Ship', 'By Hand'].map((m) => <option key={m}>{m}</option>)}
            </select>
          </label>
          <label>Vehicle no<input value={h.vehicleNo} onChange={(e) => setH({ ...h, vehicleNo: e.target.value.toUpperCase() })} /></label>
          <label>E-way bill no<input value={h.ewayBillNo} onChange={set('ewayBillNo')} /></label>
          <label>Place of supply<input value={h.placeOfSupply} onChange={set('placeOfSupply')} placeholder={h.shipToState || stateOf(h.shipToGstin) || 'from Ship to GSTIN'} /></label>
        </div>
      </section>

      <section className="card">
        <h2>Reference details</h2>
        <div className="form4">
          <label>Order no<input value={h.workOrder} onChange={set('workOrder')} /></label>
          <label>Order date<input type="date" value={h.orderDate} onChange={set('orderDate')} /></label>
          <label>Contact person<input value={h.contactPerson} onChange={set('contactPerson')} /></label>
          <label>Mob. no<input value={h.contactMobile} onChange={set('contactMobile')} /></label>
          <label>No of boxes<input value={h.packages} onChange={set('packages')} /></label>
          <label>MDF number<input value={h.mdfNo} onChange={set('mdfNo')} /></label>
          <label className="span2">Terms<input value={h.terms} onChange={set('terms')} /></label>
        </div>
      </section>

      <section className="card">
        <h2>Parties {addrBusy && <span className="sub">loading from Books…</span>}</h2>
        <div className="form3">
          {party('Receiver / Bill to', 'billTo', 'billingAddress')}
          {party('Consignee / Shipped to', 'shipTo', 'shippingAddress')}
          {party('Dispatch from', 'dispatch', 'dispatchFrom')}
        </div>
        <p className="hint">Printed on the DC only — not sent to Zoho Books. Bill to / Ship to fill from the job worker in Books; Dispatch from comes from Settings. State fills from the GSTIN when left blank.</p>
      </section>

      <section className="card">
        <h2>Material sent & item expected back</h2>
        <div className="scroll">
          <table className="grid edit">
            <thead>
              <tr>
                <th>#</th><th style={{ minWidth: 200 }}>Raw item sent (SKU)</th><th style={{ minWidth: 190 }}>Location <b className="req">*</b></th><th>Coating</th><th style={{ minWidth: 200 }}>New item received back</th>
                <th>HSN / SAC <b className="req">*</b></th><th>UOM <b className="req">*</b></th><th>Qty <b className="req">*</b></th><th>Rate <b className="req">*</b></th><th className="r">Amount</th><th>Discount</th><th className="r">Taxable value</th>
                <th className="r">CGST</th><th className="r">SGST</th><th className="r">IGST</th><th className="r">Total</th><th></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const m = money[i];
                const raw = byId(l.rawItemId);
                return (
                  <tr key={l.key}>
                    <td>{i + 1}</td>
                    <td><ItemPicker items={items} value={l.rawItemId} onChange={(it) => setLine(i, { rawItemId: it?.item_id || '' })} onCreate={(q) => startCreate(i, 'rawItemId', q)} /></td>
                    <td>
                      <select value={l.locationId || ''} onChange={(e) => setLine(i, { locationId: e.target.value })} className={need(l, !l.locationId)}>
                        <option value="">Select…</option>
                        {locations.map((x) => <option key={x.location_id} value={x.location_id}>{x.name}{l.stock ? ` (${l.stock[x.location_id] ?? 0})` : ''}</option>)}
                      </select>
                    </td>
                    <td><input list="coatings" value={l.coating} onChange={(e) => setLine(i, { coating: e.target.value })} style={{ width: 130 }} /></td>
                    <td><ItemPicker items={items} value={l.coatedItemId} onChange={(it) => setLine(i, { coatedItemId: it?.item_id || '' })} placeholder="Coated item" onCreate={(q) => startCreate(i, 'coatedItemId', q)} /></td>
                    <td><input value={l.hsn || ''} onChange={(e) => setLine(i, { hsn: e.target.value })} style={{ width: 85 }} className={need(l, !String(l.hsn || '').trim())} /></td>
                    <td><input value={l.unit || ''} onChange={(e) => setLine(i, { unit: e.target.value })} style={{ width: 55 }} className={need(l, !String(l.unit || '').trim())} /></td>
                    <td>
                      <input type="number" value={l.pcs} onChange={(e) => setLine(i, { pcs: e.target.value })} style={{ width: 65 }} className={need(l, !(Number(l.pcs) > 0))} />
                      {l.stock && l.locationId && Number(l.pcs) > (l.stock[l.locationId] ?? 0) && <div className="sub warn">Stock {l.stock[l.locationId] ?? 0}</div>}
                    </td>
                    <td>
                      <input type="number" step="0.01" value={l.rawCostPerPc} onChange={(e) => setLine(i, { rawCostPerPc: e.target.value })} style={{ width: 95 }}
                        className={need(l, !(Number(l.rawCostPerPc) > 0))} placeholder={l.rawItemId ? 'Enter rate' : ''} />
                      {l.rawItemId && !(Number(l.rawCostPerPc) > 0) && <div className="sub warn">No rate in Books</div>}
                    </td>
                    <td className="r">{inr(m.amount)}</td>
                    <td><input type="number" step="0.01" value={l.discount} onChange={(e) => setLine(i, { discount: e.target.value })} style={{ width: 75 }} /></td>
                    <td className="r">{inr(m.taxable)}</td>
                    <td className="r">{intra ? <>{ratePick(l, i, true)}<div className="sub">{inr(m.cgst)}</div></> : '—'}</td>
                    <td className="r">{intra ? <>{l.gstRate / 2}%<div className="sub">{inr(m.sgst)}</div></> : '—'}</td>
                    <td className="r">{intra ? '—' : <>{ratePick(l, i, false)}<div className="sub">{inr(m.igst)}</div></>}</td>
                    <td className="r strong">{inr(m.total)}</td>
                    <td><button className="x" title="Remove" onClick={() => setLines(lines.length > 1 ? lines.filter((_, j) => j !== i) : [blank(settings?.dcGstRate ?? 18)])}>×</button></td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={7} className="r">Totals</td><td className="strong">{qty}</td><td></td>
                <td className="r">{inr(tot('amount'))}</td><td className="r">{inr(tot('discount'))}</td><td className="r">{inr(tot('taxable'))}</td>
                <td className="r">{inr(tot('cgst'))}</td><td className="r">{inr(tot('sgst'))}</td><td className="r">{inr(tot('igst'))}</td>
                <td className="r strong">{inr(tot('total'))}</td><td></td>
              </tr>
            </tfoot>
          </table>
        </div>
        <datalist id="coatings">{(settings?.coatings || []).map((c) => <option key={c} value={c} />)}</datalist>
        <button className="btn" onClick={() => setLines([...lines, blank(settings?.dcGstRate ?? 18)])}>+ Add line</button>
        <p className="hint">Rate (purchase rate), HSN, UOM and GST % come from the raw item in Books — correct them if needed. {intra ? 'Same state as dispatch: CGST + SGST.' : 'Other state than dispatch: IGST.'} The new item fills in by itself when the same raw item and coating were used on an earlier DC.</p>
      </section>

      <div className="actions">
        <button className="btn" onClick={() => nav(-1)}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save draft'}</button>
      </div>
      {newItem && <NewItemModal initial={newItem.initial} items={items} onClose={() => setNewItem(null)} onCreated={itemCreated} />}
    </>
  );
}
