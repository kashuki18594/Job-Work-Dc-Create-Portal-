import { useEffect, useState } from 'react';
import { api, lookup } from '../api';
import { toast } from '../components/Toaster';

export default function Settings() {
  const [s, setS] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [items, setItems] = useState([]);
  const [taxes, setTaxes] = useState([]);
  const [locations, setLocations] = useState([]);
  const setErr = (m) => m && toast.error(m);

  useEffect(() => {
    api.get('/api/settings').then(setS);
    Promise.all([lookup('accounts'), lookup('items'), lookup('taxes'), lookup('locations')])
      .then(([a, i, t, l]) => { setAccounts(a); setItems(i); setTaxes(t); setLocations(l); })
      .catch((e) => setErr(`Could not load from Zoho: ${e.message}`));
  }, []);
  if (!s) return <p className="muted">Loading…</p>;

  const set = (k, v) => setS({ ...s, [k]: v });
  const setCo = (k, v) => setS({ ...s, company: { ...s.company, [k]: v } });

  async function saveAll() {
    try {
      const out = {
        ...s,
        clearingAccountName: accounts.find((a) => a.account_id === s.clearingAccountId)?.name || s.clearingAccountName,
        scrapAccountName: accounts.find((a) => a.account_id === s.scrapAccountId)?.name || s.scrapAccountName,
        coatingServiceItemName: items.find((a) => a.item_id === s.coatingServiceItemId)?.name || s.coatingServiceItemName,
        coatings: typeof s.coatings === 'string' ? s.coatings.split(',').map((x) => x.trim()).filter(Boolean) : s.coatings,
      };
      setS(await api.put('/api/settings', out)); toast.success('Settings saved');
    } catch (e) { setErr(e.message); }
  }
  async function refresh() {
    toast.info('Reloading from Zoho Books…');
    const [a, i, t] = await Promise.all([lookup('accounts', true), lookup('items', true), lookup('taxes', true), lookup('vendors', true)]);
    setAccounts(a); setItems(i); setTaxes(t); toast.success('Reloaded from Zoho Books');
  }

  const AccountSel = ({ k, types, empty = 'Select account…' }) => (
    <select value={s[k] || ''} onChange={(e) => set(k, e.target.value)}>
      <option value="">{empty}</option>
      {accounts.filter((a) => !types || types.includes(a.type)).map((a) => <option key={a.account_id} value={a.account_id}>{a.name} — {a.type}</option>)}
    </select>
  );
  const TaxSel = ({ k, empty }) => (
    <select value={s[k] || ''} onChange={(e) => set(k, e.target.value)}>
      <option value="">{empty}</option>
      {taxes.map((t) => <option key={t.tax_id} value={t.tax_id}>{t.name} ({t.pct}%)</option>)}
    </select>
  );

  return (
    <>
      <div className="head"><h1>Settings</h1><div className="btns"><button className="btn" onClick={refresh}>Reload Zoho data</button><button className="btn primary" onClick={saveAll}>Save settings</button></div></div>

      <section className="card">
        <h2>Zoho Books posting</h2>
        <div className="form2">
          <label>Material sent account * <span className="sub">Expense, e.g. "Job Work Material Consumed" — raw material sent on Confirm DC is booked here</span><AccountSel k="clearingAccountId" /></label>
          <label>Tax on PO lines <span className="sub">Optional, e.g. IGST18 for inter-state job workers</span>
            <select value={s.purchaseTaxId || ''} onChange={(e) => set('purchaseTaxId', e.target.value)}>
              <option value="">Use item / vendor default</option>
              {taxes.map((t) => <option key={t.tax_id} value={t.tax_id}>{t.name} ({t.pct}%)</option>)}
            </select>
          </label>
          <label>Adjustment reason<input value={s.adjustmentReason} onChange={(e) => set('adjustmentReason', e.target.value)} /></label>
        </div>
      </section>

      <section className="card">
        <h2>New item defaults <span className="sub">— used by “+ Create new item” on a DC line</span></h2>
        <div className="form2">
          <label>Sales account<AccountSel k="itemSalesAccountId" types={['income', 'other_income']} empty="Default: Sales Accounts" /></label>
          <label>Purchase account<AccountSel k="itemPurchaseAccountId" types={['cost_of_goods_sold', 'expense']} empty="Default: Cost of Goods Sold" /></label>
          <label>Inventory account<AccountSel k="itemInventoryAccountId" types={['stock']} empty="Default: Inventory Asset" /></label>
          <label>Intra-state tax<TaxSel k="itemTaxIntraId" empty="Default: GST18" /></label>
          <label>Inter-state tax<TaxSel k="itemTaxInterId" empty="Default: IGST18" /></label>
        </div>
      </section>

      <section className="card">
        <h2>Calculation</h2>
        <div className="form4">
          <label>Sqft factor<input type="number" step="0.001" value={s.sqftFactor} onChange={(e) => set('sqftFactor', Number(e.target.value))} /></label>
          <label>Coatings (comma separated)<input value={Array.isArray(s.coatings) ? s.coatings.join(', ') : s.coatings} onChange={(e) => set('coatings', e.target.value)} /></label>
        </div>
      </section>

      <section className="card">
        <h2>Company details (DC print)</h2>
        <div className="form2">
          <label>Name<input value={s.company.name} onChange={(e) => setCo('name', e.target.value)} /></label>
          <label>GSTIN<input value={s.company.gstin} onChange={(e) => setCo('gstin', e.target.value)} /></label>
          <label>Address<input value={s.company.address} onChange={(e) => setCo('address', e.target.value)} /></label>
          <label>State<input value={s.company.state} onChange={(e) => setCo('state', e.target.value)} /></label>
          <label>Phone<input value={s.company.phone} onChange={(e) => setCo('phone', e.target.value)} /></label>
          <label>Dispatch from address <span className="sub">Warehouse goods leave from; default on new DCs. Blank = company address</span>
            <textarea rows={2} value={s.company.dispatchAddress || ''} onChange={(e) => setCo('dispatchAddress', e.target.value)} /></label>
          <label>Logo <span className="sub">Printed on the DC. PNG or JPG, up to 500 KB</span>
            <input type="file" accept="image/png,image/jpeg" onChange={(e) => {
              const f = e.target.files[0];
              if (!f) return;
              if (f.size > 500 * 1024) return setErr('Logo must be up to 500 KB');
              const r = new FileReader();
              r.onload = () => setCo('logo', r.result);
              r.readAsDataURL(f);
            }} />
            {s.company.logo && <span className="lbl-row"><img src={s.company.logo} alt="" style={{ height: 48 }} /><button type="button" className="link" onClick={() => setCo('logo', '')}>Remove</button></span>}
          </label>
          <label>PAN<input value={s.company.pan || ''} onChange={(e) => setCo('pan', e.target.value)} /></label>
          <label>CIN<input value={s.company.cin || ''} onChange={(e) => setCo('cin', e.target.value)} /></label>
          <label>Registered office<input value={s.company.regdOffice || ''} onChange={(e) => setCo('regdOffice', e.target.value)} /></label>
          <label>Default GST % on DC print<input type="number" value={s.dcGstRate ?? 18} onChange={(e) => set('dcGstRate', Number(e.target.value))} /></label>
        </div>
        <h3>Bank details</h3>
        <div className="form2">
          <label>Beneficiary<input value={s.company.bankBeneficiary || ''} onChange={(e) => setCo('bankBeneficiary', e.target.value)} /></label>
          <label>Bank<input value={s.company.bankName || ''} onChange={(e) => setCo('bankName', e.target.value)} /></label>
          <label>Bank address<input value={s.company.bankAddress || ''} onChange={(e) => setCo('bankAddress', e.target.value)} /></label>
          <label>Account no<input value={s.company.bankAccount || ''} onChange={(e) => setCo('bankAccount', e.target.value)} /></label>
          <label>IFSC<input value={s.company.bankIfsc || ''} onChange={(e) => setCo('bankIfsc', e.target.value.toUpperCase())} /></label>
        </div>
        <h3>Terms & conditions <span className="sub">— one per line</span></h3>
        <textarea rows={4} value={s.company.terms || ''} onChange={(e) => setCo('terms', e.target.value)} />
      </section>
    </>
  );
}
