import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { inr, r2 } from '../calc';
import { stateOf } from '../gst';
import { toast } from '../components/Toaster';
import { Party, PrintBottom, PrintHeader, PrintShell, ddmmyyyy, stateName, taxCell } from '../components/PrintParts';

// Print of a normal DC (read live from Zoho Books) in the same layout as the job work DC.
export default function NormalDCPrint() {
  const { id } = useParams();
  const [dc, setDc] = useState(null);
  const [st, setSt] = useState(null);
  useEffect(() => {
    Promise.all([api.get(`/api/normal-dcs/${id}`), api.get('/api/settings')])
      .then(([d, s]) => { setDc(d); setSt(s); })
      .catch((e) => toast.error(`Could not load the challan from Zoho Books: ${e.message}`));
  }, [id]);
  if (!dc || !st) return <p className="muted" style={{ padding: 24 }}>Loading challan from Zoho Books…</p>;

  return (
    <PrintShell warn={dc.status === 'draft' && 'Draft — mark it as Open in the app or Zoho before sending'}>
      {(copyLabel) => <Challan dc={dc} co={st.company} copyLabel={copyLabel} />}
    </PrintShell>
  );
}

function Challan({ dc, co, copyLabel }) {
  const cf = dc.custom;
  const loc = dc.location;
  const bill = { name: dc.customer.name, address: dc.customer.billing.join('\n'), gstin: dc.customer.gstin, state: stateOf(dc.customer.gstin) || dc.customer.billState };
  const ship = { name: dc.customer.name, address: dc.customer.shipping.join('\n') || bill.address, gstin: dc.customer.shipGstin, state: stateOf(dc.customer.shipGstin) || dc.customer.shipState || bill.state };
  // only what is written in the challan's "Dispatch From" field
  const from = { name: '', address: cf['Dispatch From'] || '—', gstin: '', state: '' };
  const dealLabels = [...new Set(dc.lines.flatMap((l) => Object.keys(l.deals)))];
  const t = dc.totals;
  const qty = dc.lines.reduce((a, l) => a + l.quantity, 0);
  const grand = t.total;
  const roundOff = r2(grand - (t.taxable + t.cgst + t.sgst + t.igst));

  return (
    <div className="paper dc">
      <PrintHeader co={co} loc={loc} number={dc.number} copyLabel={copyLabel} />

      <section className="dc-meta">
        <div><i>Challan date</i>{ddmmyyyy(dc.date)}</div>
        <div><i>Challan type</i>{dc.challanType || '—'}</div>
        <div><i>Place of supply</i>{stateName(dc.placeOfSupply) || '—'}</div>
        <div><i>Reference#</i>{dc.reference || '—'}</div>
        <div><i>Reverse charges</i>{dc.reverseCharge}</div>
        <div><i>E-way bill no</i>{dc.ewayBill || '—'}</div>
        <div><i>Transportation mode</i>{cf['Transportation Mode'] || '—'}</div>
        <div><i>Vehicle no</i>{cf['Vehicle No'] || '—'}</div>
        <div><i>Product</i>{dc.product || '—'}</div>
        <div><i>Contact person</i>{cf['Contact Person'] || '—'}</div>
        <div><i>Mob. no</i>{cf['Mobile No'] || '—'}</div>
        <div><i>No of boxes</i>{cf['No of Boxes'] || '—'}</div>
        <div><i>Delivery type</i>{cf['Delivery Type Specify(Reason)'] || '—'}</div>
      </section>

      <section className="dc-parties">
        <Party title="Details of Receiver / Bill to" p={bill} />
        <Party title="Details of Consignee / Shipped to" p={ship} />
        <Party title="Dispatch from" p={from} />
      </section>

      <table className="dc-items">
        <thead>
          <tr>
            <th>#</th><th className="l">Item & description</th>
            {dealLabels.map((d) => <th key={d} className="l">{d}</th>)}
            <th>HSN / SAC</th><th>UOM</th><th className="r">Qty</th><th className="r">Rate</th><th className="r">Amount</th><th className="r">Disc.</th>
            <th className="r">Taxable value</th><th className="r">CGST</th><th className="r">SGST</th><th className="r">IGST</th><th className="r">Total</th>
          </tr>
        </thead>
        <tbody>
          {dc.lines.map((l, i) => (
            <tr key={l.id}>
              <td className="c">{i + 1}</td>
              <td className="l">
                <div className="dc-item">{l.name}</div>
                <div className="dc-muted">{[l.sku && l.sku !== l.name && l.sku, l.description, l.warehouse].filter(Boolean).join(' · ')}</div>
              </td>
              {dealLabels.map((d) => <td key={d} className="l">{l.deals[d] || '—'}</td>)}
              <td className="c">{l.hsn}</td>
              <td className="c">{l.unit}</td>
              <td className="r">{l.quantity}</td>
              <td className="r">{inr(l.rate)}</td>
              <td className="r">{inr(l.amount)}</td>
              <td className="r">{l.discount ? inr(l.discount) : '—'}</td>
              <td className="r">{inr(l.taxable)}</td>
              <td className="r tax">{taxCell(l.cgst, l.cgstPct)}</td>
              <td className="r tax">{taxCell(l.sgst, l.sgstPct)}</td>
              <td className="r tax">{taxCell(l.igst, l.igstPct)}</td>
              <td className="r b">{inr(l.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={4 + dealLabels.length} className="r">Total</td><td className="r">{qty}</td><td />
            <td className="r">{inr(t.amount)}</td><td className="r">{inr(t.discount)}</td><td className="r">{inr(t.taxable)}</td>
            <td className="r">{inr(t.cgst)}</td><td className="r">{inr(t.sgst)}</td><td className="r">{inr(t.igst)}</td>
            <td className="r">{inr(r2(t.taxable + t.cgst + t.sgst + t.igst))}</td>
          </tr>
        </tfoot>
      </table>

      <PrintBottom co={co} terms={dc.terms} notes={dc.notes} rcm={dc.reverseCharge}
        t={{ taxable: t.taxable, cgst: t.cgst, sgst: t.sgst, igst: t.igst, roundOff, grand }} />
    </div>
  );
}
