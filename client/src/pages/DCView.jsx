import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { toast } from '../components/Toaster';
import { balance, inr, r2 } from '../calc';
import { isIntra, lineTax, stateOf } from '../gst';
import Status from '../components/Status';
import { stateName } from '../components/PrintParts';

export default function DCView() {
  const { id } = useParams();
  const nav = useNavigate();
  const [dc, setDc] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState('');
  const [mode, setMode] = useState(''); // receive | close | cancel | confirm
  const [rcv, setRcv] = useState({ date: new Date().toISOString().slice(0, 10), vendorInvoiceNo: '', vendorChallanNo: '', remarks: '', pcs: {} });
  const [closeNote, setCloseNote] = useState('');

  const [short, setShort] = useState(null); // stock shortages, checked when the Confirm panel opens
  useEffect(() => {
    if (mode !== 'confirm') return;
    setShort(null);
    api.get(`/api/dcs/${id}/stock-check`).then(setShort).catch((e) => { toast.error(`Could not check stock: ${e.message}`); setShort([]); });
  }, [mode, id]);

  const load = () => api.get(`/api/dcs/${id}`).then(setDc).catch((e) => { setLoadErr(e.message); toast.error(e.message); });
  useEffect(() => { load(); }, [id]);

  const DONE = { po: 'Purchase order created in Zoho Books', undo: 'Last receipt undone', confirm: 'DC confirmed — posted to Zoho Books', receive: 'Purchase receive created in Zoho — stock added', close: 'DC closed', cancel: 'DC cancelled — stock reversed, PO cancelled' };
  async function act(name, url, body) {
    setBusy(name);
    try { setDc(await api.post(url, body)); setMode(''); toast.success(DONE[name]); return true; }
    catch (e) { toast.error(e.message); load(); return false; }
    finally { setBusy(''); }
  }

  if (!dc) return <p className="muted">{loadErr ? 'Could not load this DC.' : 'Loading…'}</p>;

  const open = ['confirmed', 'partial'].includes(dc.status);
  const pendingLines = dc.lines.filter((l) => balance(l) > 0);
  const t = dc.lines.reduce((a, l) => ({ pcs: a.pcs + l.pcs, rec: a.rec + l.receivedPcs, scr: a.scr + l.scrapPcs, raw: a.raw + l.pcs * l.rawCostPerPc}), { pcs: 0, rec: 0, scr: 0, raw: 0 });

  // same figures as the form and the print
  const billGstin = dc.billToGstin ?? dc.vendorGstin;
  const shipGstin = dc.shipToGstin ?? dc.vendorGstin;
  const pos = dc.placeOfSupply || dc.shipToState || stateOf(shipGstin) || dc.billToState || stateOf(billGstin) || dc.vendorState || '';
  const intra = isIntra(pos, dc.dispatchGstin);
  const money = dc.lines.map((l) => ({ ...l, ...lineTax({ ...l, gstRate: l.gstRate ?? dc.gstRate ?? 18 }, intra) }));
  const sum = (k) => r2(money.reduce((a, l) => a + l[k], 0));
  const exact = r2(sum('taxable') + sum('cgst') + sum('sgst') + sum('igst'));
  const grand = Math.round(exact);
  const taxText = (amt, rate) => (amt ? <>{inr(amt)}<div className="sub">{rate}%</div></> : '—');
  const party = (name, address, gstin, state) => [name, address, gstin && `GSTIN: ${gstin}`, (state || stateOf(gstin)) && `State: ${stateName(state || stateOf(gstin))}`].filter(Boolean).join('\n') || '—';

  return (
    <>
      <div className="head">
        <div>
          <h1>{dc.dcNo} <Status s={dc.status} /></h1>
          <div className="muted">{dc.vendorName} · {dc.date}{dc.zoho?.poNumber ? ` · PO ${dc.zoho.poNumber}` : ''}</div>
        </div>
        <div className="btns">
          <Link className="btn" to="/">← Back</Link>
          <a className="btn" href={`/dc/${dc.id}/print`} target="_blank" rel="noreferrer">Print DC</a>
          {dc.status === 'draft' && <>
            <Link className="btn" to={`/dc/${dc.id}/edit`}>Edit</Link>
            <button className="btn danger-o" onClick={async () => { if (confirm('Delete this draft DC?')) { await api.del(`/api/dcs/${dc.id}`); nav('/'); } }}>Delete</button>
          </>}
          {['draft', 'confirming'].includes(dc.status) && <button className="btn primary" onClick={() => setMode('confirm')}>Confirm DC</button>}
          {open && !dc.zoho?.poId && <button className="btn primary" disabled={!!busy} onClick={() => act('po', `/api/dcs/${dc.id}/confirm`)}>{busy === 'po' ? 'Creating PO…' : 'Create PO'}</button>}
          {open && dc.zoho?.poId && <button className="btn primary" onClick={() => setMode('receive')}>Receive material</button>}
          {['partial', 'received'].includes(dc.status) && dc.receipts.length > 0 && <button className="btn danger-o" disabled={!!busy} onClick={() => { if (confirm('Undo the last receipt? Its stock entry in Zoho will be reversed or deleted.')) act('undo', `/api/dcs/${dc.id}/undo-receipt`); }}>Undo last receipt</button>}
          {['confirmed', 'partial', 'received'].includes(dc.status) && <button className="btn" onClick={() => setMode('close')}>Close DC</button>}
          {['confirmed', 'confirming'].includes(dc.status) && t.rec === 0 && <button className="btn danger-o" onClick={() => setMode('cancel')}>Cancel DC</button>}
        </div>
      </div>

      {mode === 'confirm' && (
        <section className="card accent">
          <h2>Confirm DC {dc.dcNo}</h2>
          <p>This will post to Zoho Books:</p>
          <ol>
            <li><b>Inventory adjustment</b> — raw stock OUT: {dc.lines.map((l) => `${l.rawName} −${l.pcs}`).join(', ')} — one adjustment per location: {[...new Set(dc.lines.map((l) => l.locationName || '—'))].join(', ')}</li>
            <li><b>Purchase order</b> to {dc.vendorName} for the new items: {dc.lines.map((l) => `${l.coatedName} × ${l.pcs} @ ₹${inr(l.rawCostPerPc)}`).join(', ')} — reference {dc.dcNo}</li>
          </ol>
          {short === null && <p className="muted">Checking stock in Zoho…</p>}
          {short?.length > 0 && (
            <div className="warn">
              <b>Not enough stock. This DC can't be confirmed:</b>
              <ul>{short.map((x) => <li key={x.item + x.location}>{x.item}: need {x.required}, only {x.available} at {x.location || 'this location'}</li>)}</ul>
            </div>
          )}
          <p className="hint">After confirming, item lines can't be edited. To undo, use Cancel DC (allowed until something is received).</p>
          <div className="actions">
            <button className="btn" onClick={() => setMode('')}>Back</button>
            <button className="btn primary" disabled={!!busy || short === null || short.length > 0} onClick={() => act('confirm', `/api/dcs/${dc.id}/confirm`)}>{busy ? 'Posting to Books…' : 'Confirm & post'}</button>
          </div>
        </section>
      )}

      {mode === 'receive' && (
        <section className="card accent">
          <h2>Receive material — purchase receive on PO {dc.zoho?.poNumber}</h2>
          <div className="form4">
            <label>Receipt date<input type="date" value={rcv.date} onChange={(e) => setRcv({ ...rcv, date: e.target.value })} /></label>
            <label>Vendor invoice no<input value={rcv.vendorInvoiceNo} onChange={(e) => setRcv({ ...rcv, vendorInvoiceNo: e.target.value })} placeholder="e.g. SCI/26-27/033" /></label>
            <label>Vendor dispatch challan<input value={rcv.vendorChallanNo} onChange={(e) => setRcv({ ...rcv, vendorChallanNo: e.target.value })} /></label>
            <label>Remarks<input value={rcv.remarks} onChange={(e) => setRcv({ ...rcv, remarks: e.target.value })} /></label>
          </div>
          <table className="grid">
            <thead><tr><th>New item</th><th>Coating</th><th className="r">Sent</th><th className="r">Already recd</th><th className="r">Pending</th><th>Receiving now</th><th className="r">PO rate / pc</th><th className="r">PO value</th></tr></thead>
            <tbody>
              {pendingLines.map((l) => {
                const n = Number(rcv.pcs[l.id]) || 0;
                const cpp = l.rawCostPerPc;
                return (
                  <tr key={l.id}>
                    <td>{l.coatedName}<div className="sub">from {l.rawName}</div></td><td>{l.coating}</td>
                    <td className="r">{l.pcs}</td><td className="r">{l.receivedPcs}</td><td className="r strong">{balance(l)}</td>
                    <td>
                      <input type="number" min="0" max={balance(l)} value={rcv.pcs[l.id] ?? ''} style={{ width: 80 }}
                        onChange={(e) => setRcv({ ...rcv, pcs: { ...rcv.pcs, [l.id]: e.target.value } })} />
                      <button className="link" onClick={() => setRcv({ ...rcv, pcs: { ...rcv.pcs, [l.id]: balance(l) } })}>all</button>
                    </td>
                    <td className="r">{inr(cpp)}</td><td className="r">{inr(n * cpp)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="hint">Creates a <b>Purchase Receive</b> in Zoho against PO {dc.zoho?.poNumber} for the pcs entered — stock of the new items goes up at the PO location. Then convert the PO to a <b>Bill</b> in Books and put the job worker's actual price there.</p>
          <div className="actions">
            <button className="btn" onClick={() => setMode('')}>Back</button>
            <button className="btn primary" disabled={!!busy} onClick={() => act('receive', `/api/dcs/${dc.id}/receive`, {
              ...rcv, lines: Object.entries(rcv.pcs).map(([lineId, pcs]) => ({ lineId, pcs: Number(pcs) })),
            }).then((ok) => ok && setRcv({ ...rcv, vendorInvoiceNo: '', vendorChallanNo: '', remarks: '', pcs: {} }))}>{busy ? 'Posting…' : 'Save receipt'}</button>
          </div>
        </section>
      )}

      {mode === 'close' && (
        <section className="card accent">
          <h2>Close DC</h2>
          {pendingLines.length ? (
            <>
              <p>These pending pcs will be marked <b>short / scrap</b>:</p>
              <ul>{pendingLines.map((l) => <li key={l.id}>{l.coatedName} ({l.coating}) — {balance(l)} pcs</li>)}</ul>
              <p className="hint">Nothing is posted to Books: the raw material was already booked out at Confirm. The PO keeps these pcs as not received — close or adjust the PO in Books if needed.</p>
              <label>Note<input value={closeNote} onChange={(e) => setCloseNote(e.target.value)} placeholder="e.g. 5 pcs damaged in coating" /></label>
            </>
          ) : <p>Everything is received. Closing marks the DC as complete.</p>}
          <div className="actions">
            <button className="btn" onClick={() => setMode('')}>Back</button>
            <button className="btn primary" disabled={!!busy} onClick={() => act('close', `/api/dcs/${dc.id}/close`, { notes: closeNote })}>{busy ? 'Posting…' : 'Close DC'}</button>
          </div>
        </section>
      )}

      {mode === 'cancel' && (
        <section className="card accent danger">
          <h2>Cancel DC</h2>
          <p>Raw stock will be added back (reverse adjustment){dc.zoho?.poNumber ? ` and PO ${dc.zoho.poNumber} will be cancelled` : ''} in Books.</p>
          <div className="actions">
            <button className="btn" onClick={() => setMode('')}>Back</button>
            <button className="btn danger" disabled={!!busy} onClick={() => act('cancel', `/api/dcs/${dc.id}/cancel`)}>{busy ? 'Posting…' : 'Cancel DC'}</button>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Challan details</h2>
        <div className="kv">
          <div><span>Job worker</span>{dc.vendorName}</div>
          <div><span>GSTIN</span>{dc.vendorGstin || '—'}</div>
          <div><span>Challan date</span>{dc.date}</div>
          <div><span>Place of supply</span>{pos || '—'}</div>
          <div><span>Reverse charges</span>{dc.reverseCharge || 'No'}</div>
          <div><span>Transport mode</span>{dc.transportMode || '—'}</div>
          <div><span>Vehicle no</span>{dc.vehicleNo || '—'}</div>
          <div><span>E-way bill no</span>{dc.ewayBillNo || '—'}</div>
          <div><span>Purchase order</span>{dc.zoho?.poNumber || '—'}</div>
        </div>
        <h2>Reference details</h2>
        <div className="kv">
          <div><span>Order no</span>{dc.workOrder || '—'}</div>
          <div><span>Order date</span>{dc.orderDate || '—'}</div>
          <div><span>Contact person</span>{dc.contactPerson || '—'}</div>
          <div><span>Mob. no</span>{dc.contactMobile || '—'}</div>
          <div><span>No of boxes</span>{dc.packages || '—'}</div>
          <div><span>MDF number</span>{dc.mdfNo || '—'}</div>
          <div><span>Terms</span>{dc.terms || '—'}</div>
        </div>
        <h2>Parties</h2>
        <div className="kv addr">
          <div><span>Receiver / Bill to</span>{party(dc.billToName, dc.billingAddress || dc.vendorAddress, billGstin, dc.billToState)}</div>
          <div><span>Consignee / Shipped to</span>{party(dc.shipToName, dc.shippingAddress || dc.billingAddress || dc.vendorAddress, shipGstin, dc.shipToState)}</div>
          <div><span>Dispatch from</span>{party(dc.dispatchName, dc.dispatchFrom, dc.dispatchGstin, dc.dispatchState)}</div>
        </div>
      </section>

      <section className="card">
        <h2>Items</h2>
        <div className="scroll">
          <table className="grid">
            <thead><tr><th>#</th><th>Raw item sent</th><th>Coating</th><th>New item</th><th>HSN</th><th>UOM</th><th className="r">Qty</th><th className="r">Rate</th><th className="r">Amount</th><th className="r">Discount</th><th className="r">Taxable value</th><th className="r">CGST</th><th className="r">SGST</th><th className="r">IGST</th><th className="r">Total</th><th className="r">Recd</th><th className="r">Scrap</th><th className="r">Balance</th></tr></thead>
            <tbody>
              {money.map((l, i) => (
                <tr key={l.id}>
                  <td>{i + 1}</td><td>{l.rawName}<div className="sub">{[l.rawSku, l.locationName].filter(Boolean).join(' · ')}</div></td><td>{l.coating}</td><td>{l.coatedName}<div className="sub">{l.coatedSku}</div></td>
                  <td>{l.hsn}</td><td>{l.unit}</td><td className="r">{l.pcs}</td><td className="r">{inr(l.rawCostPerPc)}</td>
                  <td className="r">{inr(l.amount)}</td><td className="r">{inr(l.discount)}</td><td className="r">{inr(l.taxable)}</td>
                  <td className="r">{taxText(l.cgst, l.rate / 2)}</td><td className="r">{taxText(l.sgst, l.rate / 2)}</td><td className="r">{taxText(l.igst, l.rate)}</td>
                  <td className="r strong">{inr(l.total)}</td>
                  <td className="r">{l.receivedPcs}</td><td className="r">{l.scrapPcs}</td>
                  <td className={`r strong ${balance(l) > 0 && dc.status !== 'draft' ? 'warn' : ''}`}>{balance(l)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={6} className="r">Totals</td><td className="r">{t.pcs}</td><td></td><td className="r">{inr(sum('amount'))}</td><td className="r">{inr(sum('discount'))}</td><td className="r">{inr(sum('taxable'))}</td><td className="r">{inr(sum('cgst'))}</td><td className="r">{inr(sum('sgst'))}</td><td className="r">{inr(sum('igst'))}</td><td className="r strong">{inr(exact)}</td><td className="r">{t.rec}</td><td className="r">{t.scr}</td><td className="r strong">{t.pcs - t.rec - t.scr}</td></tr></tfoot>
          </table>
        </div>
        <div className="nd-bottom">
          <div />
          <table className="nd-totals"><tbody>
            <tr><td>Sub total</td><td>{inr(sum('amount'))}</td></tr>
            <tr><td>Discount</td><td>{inr(sum('discount'))}</td></tr>
            <tr><td>Taxable value</td><td>{inr(sum('taxable'))}</td></tr>
            <tr><td>CGST</td><td>{inr(sum('cgst'))}</td></tr>
            <tr><td>SGST</td><td>{inr(sum('sgst'))}</td></tr>
            <tr><td>IGST</td><td>{inr(sum('igst'))}</td></tr>
            <tr><td>Round off</td><td>{inr(r2(grand - exact))}</td></tr>
            <tr className="grand"><td>Total (Rs.)</td><td>{inr(grand)}</td></tr>
          </tbody></table>
        </div>
      </section>

      {dc.receipts.length > 0 && (
        <section className="card">
          <h2>Receipts</h2>
          <table className="grid">
            <thead><tr><th>Date</th><th>Purchase receive</th><th>Vendor invoice</th><th>Vendor challan</th><th>Items</th><th className="r">Pcs</th><th className="r">PO value</th></tr></thead>
            <tbody>{dc.receipts.map((r) => (
              <tr key={r.id}><td>{r.date}</td><td>{r.receiveNumber || (r.adjustmentId ? 'adjustment' : '—')}</td><td>{r.vendorInvoiceNo}</td><td>{r.vendorChallanNo}</td>
                <td>{r.lines.map((x) => `${x.item} × ${x.pcs}`).join(', ')}</td>
                <td className="r">{r.lines.reduce((a, x) => a + x.pcs, 0)}</td><td className="r">{inr(r.lines.reduce((a, x) => a + x.value, 0))}</td></tr>
            ))}</tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h2>Activity</h2>
        <ul className="log">{dc.log.slice().reverse().map((x, i) => <li key={i}><span>{new Date(x.at).toLocaleString('en-IN')}</span>{x.msg}</li>)}</ul>
      </section>
    </>
  );
}
