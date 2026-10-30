import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from './Toaster';
import ItemPicker from './ItemPicker';
import TaxSelect from './TaxSelect';

const isAlloy = (b) => String(b || '').trim().toLowerCase() === 'alloy';
// Alloy naming rule: <Product Name>_<Unit>_<Finish Code>, e.g. 100.01A_2.8m_NA (Name and SKU)
const alloySku = (pn, unit, fc) => [pn, unit, fc].map((x) => String(x ?? '').trim()).join('_');
// for Alloy these custom fields sit at the top, because they build the name
const NAME_PARTS = ['cf_generic_name', 'cf_finish_code'];

// Create an inventory item in Zoho Books, laid out like the Books item form.
// `initial` pre-fills fields (e.g. copied from the raw item when creating the coated item).
export default function NewItemModal({ initial, items, onClose, onCreated }) {
  const [meta, setMeta] = useState(null);
  const [f, setF] = useState({
    name: '', sku: '', unit: '', brand: '', manufacturer: '', hsn_or_sac: '',
    rate: 0, description: '', purchase_rate: 0, purchase_description: '', custom: {},
    taxPreference: 'taxable', taxIntraId: '', taxInterId: '', taxExemptionId: '',
    ...initial,
  });
  const [skuTouched, setSkuTouched] = useState(!!initial?.sku && initial.sku !== initial.name);
  const setErr = (m) => m && toast.error(m);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/api/item-meta').then((m) => {
      setMeta(m);
      setF((x) => ({ ...x, taxIntraId: x.taxIntraId || m.defaults.taxIntra?.id || '', taxInterId: x.taxInterId || m.defaults.taxInter?.id || '' }));
    }).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [busy]);

  const alloy = isAlloy(f.brand);
  const autoName = alloySku(f.custom.cf_generic_name, f.unit, f.custom.cf_finish_code);
  const name = alloy ? autoName : f.name;
  const sku = alloy ? autoName : f.sku;

  const set = (k, v) => setF((x) => ({ ...x, [k]: v, ...(k === 'name' && !skuTouched ? { sku: v } : {}) }));
  const setCf = (k, v) => setF((x) => ({ ...x, custom: { ...x.custom, [k]: v } }));
  const d = meta?.defaults;
  const units = (meta?.units || []).map((u) => ({ id: u.unit, name: u.unit, info: u.info }));
  const withCurrent = (list, v) => (v && !list.includes(v) ? [v, ...list] : list);

  async function create() {
    const miss = [];
    if (!alloy) [['name', 'Name'], ['sku', 'SKU']].filter(([k]) => !String(f[k]).trim()).forEach(([, l]) => miss.push(l));
    if (!f.unit) miss.push('Unit');
    if (f.rate === '') miss.push('Selling price');
    if (f.purchase_rate === '') miss.push('Cost price');
    if (f.taxPreference === 'taxable' && (!f.taxIntraId || !f.taxInterId)) miss.push('Intra / Inter-state tax');
    if (f.taxPreference === 'non_taxable' && !f.taxExemptionId) miss.push('Exemption reason');
    if (alloy) meta?.customFields.filter((c) => !c.checkbox && !String(f.custom[c.api] ?? '').trim()).forEach((c) => miss.push(c.label));
    if (miss.length) return setErr(`Fill: ${miss.join(', ')}`);
    if (items.some((i) => i.sku && i.sku.toLowerCase() === sku.trim().toLowerCase())) return setErr(`SKU ${sku} already exists in Books`);
    setBusy(true);
    try { onCreated(await api.post('/api/zoho/items', { ...f, name, sku })); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const req = (label, on = true) => <span>{label}{on && <b className="req">*</b>}</span>;
  const cfLabel = (api) => meta?.customFields.find((c) => c.api === api)?.label || api;
  const unitPicker = (
    <ItemPicker items={units} value={f.unit} onChange={(u) => set('unit', u?.id || '')} placeholder="Search unit"
      idKey="id" codeKey="info" subOf={(u) => u.info || ''} />
  );

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal">
        <div className="modal-head"><h2>New item in Zoho Books</h2><button className="x" onClick={onClose} disabled={busy}>×</button></div>

        <div className="form2">
          <label>Brand
            <select value={f.brand} onChange={(e) => set('brand', e.target.value)}>
              <option value="">— No brand —</option>
              {withCurrent(meta?.brands || [], f.brand).map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
          <label>Manufacturer
            <select value={f.manufacturer} onChange={(e) => set('manufacturer', e.target.value)}>
              <option value="">— None —</option>
              {withCurrent(meta?.manufacturers || [], f.manufacturer).map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>

          {alloy ? <>
            <label>{req(cfLabel('cf_generic_name'))}<input autoFocus value={f.custom.cf_generic_name ?? ''} onChange={(e) => setCf('cf_generic_name', e.target.value)} placeholder="e.g. 100.01A" /></label>
            <label>{req('Unit')}{unitPicker}</label>
            <label>{req(cfLabel('cf_finish_code'))}<input value={f.custom.cf_finish_code ?? ''} onChange={(e) => setCf('cf_finish_code', e.target.value)} placeholder="e.g. NA" /></label>
            <div />
            <label>Name <span className="sub">auto: Product Name_Unit_Finish Code</span><input value={name} disabled /></label>
            <label>SKU <span className="sub">same as Name</span><input value={sku} disabled /></label>
          </> : <>
            <label>{req('Name')}<input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
            <label>{req('SKU')}<input value={f.sku} onChange={(e) => { setSkuTouched(true); set('sku', e.target.value); }} /></label>
            <label>{req('Unit')}{unitPicker}</label>
            <div />
          </>}

          <label>Type<input value="Goods — inventory tracked" disabled /></label>
          <label>HSN code<input value={f.hsn_or_sac} onChange={(e) => set('hsn_or_sac', e.target.value)} /></label>
          <label>{req('Tax preference')}
            <select value={f.taxPreference} onChange={(e) => set('taxPreference', e.target.value)}>
              <option value="taxable">Taxable</option>
              <option value="non_taxable">Non-Taxable</option>
            </select>
          </label>
          {f.taxPreference === 'taxable' ? <>
            <div />
            <label>{req('Intra-state tax')}
              <TaxSelect taxes={meta?.taxes || []} value={f.taxIntraId} onChange={(v) => set('taxIntraId', v)} scope="intra" />
            </label>
            <label>{req('Inter-state tax')}
              <TaxSelect taxes={meta?.taxes || []} value={f.taxInterId} onChange={(v) => set('taxInterId', v)} scope="inter" />
            </label>
          </> : (
            <label>{req('Exemption reason')}
              <select value={f.taxExemptionId} onChange={(e) => set('taxExemptionId', e.target.value)}>
                <option value="">Select reason…</option>
                {(meta?.exemptions || []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
          )}
        </div>

        <h3>Sales information</h3>
        <div className="form2">
          <label>{req('Selling price (INR)')}<input type="number" step="0.01" value={f.rate} onChange={(e) => set('rate', e.target.value)} /></label>
          <label>Account<input value={d?.sales?.name || 'not found'} disabled /></label>
          <label className="span2">Description<textarea rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} /></label>
        </div>

        <h3>Purchase information</h3>
        <div className="form2">
          <label>{req('Cost price (INR)')}<input type="number" step="0.01" value={f.purchase_rate} onChange={(e) => set('purchase_rate', e.target.value)} /></label>
          <label>Account<input value={d?.purchase?.name || 'not found'} disabled /></label>
          <label>Description<textarea rows={2} value={f.purchase_description} onChange={(e) => set('purchase_description', e.target.value)} /></label>
          <label>Inventory account<input value={d?.inventory?.name || 'not found'} disabled /></label>
        </div>

        <h3>Additional information {alloy ? <span className="sub">— required for brand Alloy</span> : <span className="sub">— optional (required for brand Alloy)</span>}</h3>
        <div className="form2">
          {(meta?.customFields || []).filter((c) => !(alloy && NAME_PARTS.includes(c.api))).map((c) => c.checkbox ? (
            <label key={c.api} className="check"><input type="checkbox" checked={!!f.custom[c.api]} onChange={(e) => setCf(c.api, e.target.checked)} />{c.label}</label>
          ) : (
            <label key={c.api}>{req(c.label, alloy)}<input value={f.custom[c.api] ?? ''} onChange={(e) => setCf(c.api, e.target.value)} /></label>
          ))}
        </div>

        <div className="actions">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={create} disabled={busy || !meta}>{busy ? 'Creating in Books…' : 'Create item'}</button>
        </div>
      </div>
    </div>
  );
}
