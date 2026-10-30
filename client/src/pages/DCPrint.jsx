import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { inr, r2 } from '../calc';
import { isIntra, lineTax, stateOf } from '../gst';
import { Party, PrintBottom, PrintHeader, PrintShell, ddmmyyyy, stateName, taxCell } from '../components/PrintParts';

export default function DCPrint() {
  const { id } = useParams();
  const [dc, setDc] = useState(null);
  const [st, setSt] = useState(null);
  const [locs, setLocs] = useState([]);
  useEffect(() => {
    Promise.all([api.get(`/api/dcs/${id}`), api.get('/api/settings')]).then(([d, s]) => { setDc(d); setSt(s); });
    api.get('/api/zoho/locations').then(setLocs).catch(() => {}); // header falls back to Settings without it
  }, [id]);
  if (!dc || !st) return null;

  return (
    <PrintShell warn={dc.status === 'draft' && 'Draft — not yet confirmed'}>
      {(copyLabel) => <Challan dc={dc} st={st} loc={locs.find((l) => l.location_id === dc.locationId)} copyLabel={copyLabel} />}
    </PrintShell>
  );
}

function Challan({ dc, st, loc, copyLabel }) {
  const co = st.company;
  // parties: DC values first, then the older vendor / company fields
  const bill = { name: dc.billToName || dc.vendorName, address: dc.billingAddress || dc.vendorAddress, gstin: dc.billToGstin ?? dc.vendorGstin };
  const ship = { name: dc.shipToName || dc.vendorName, address: dc.shippingAddress || bill.address, gstin: dc.shipToGstin ?? dc.vendorGstin };
  const from = { name: dc.dispatchName || co.name, address: dc.dispatchFrom || co.address, gstin: dc.dispatchGstin || co.gstin };
  bill.state = dc.billToState || stateOf(bill.gstin) || dc.vendorState || '';
  ship.state = dc.shipToState || stateOf(ship.gstin) || bill.state;
  from.state = dc.dispatchState || stateOf(from.gstin) || co.state;
  const pos = dc.placeOfSupply || ship.state;

  const intra = isIntra(pos, from.gstin || co.gstin);
  const defRate = Number(dc.gstRate ?? st.dcGstRate ?? 18);
  const lines = dc.lines.map((l) => ({ ...l, ...lineTax({ ...l, gstRate: l.gstRate ?? defRate }, intra) }));
  const sum = (k) => r2(lines.reduce((a, l) => a + l[k], 0));
  const qty = lines.reduce((a, l) => a + l.pcs, 0);
  const taxable = sum('taxable');
  const cgst = sum('cgst'), sgst = sum('sgst'), igst = sum('igst');
  const exact = r2(taxable + cgst + sgst + igst);
  const grand = Math.round(exact);

  return (
    <div className="paper dc">
      <PrintHeader co={co} loc={loc} number={dc.dcNo} copyLabel={copyLabel} />

      <section className="dc-meta">
        <div><i>Challan date</i>{ddmmyyyy(dc.date)}</div>
        <div><i>Reverse charges</i>{dc.reverseCharge || 'No'}</div>
        <div><i>E-way bill no</i>{dc.ewayBillNo || '—'}</div>
        <div><i>Transportation mode</i>{dc.transportMode || 'By Road'}</div>
        <div><i>Vehicle no</i>{dc.vehicleNo || '—'}</div>
        <div><i>Place of supply</i>{stateName(pos) || '—'}</div>
        <div><i>Order no</i>{dc.workOrder || '—'}</div>
        <div><i>Order date</i>{ddmmyyyy(dc.orderDate) || '—'}</div>
        <div><i>Contact person</i>{dc.contactPerson || '—'}</div>
        <div><i>Mob. no</i>{dc.contactMobile || '—'}</div>
        <div><i>No of boxes</i>{dc.packages || '—'}</div>
        <div><i>MDF number</i>{dc.mdfNo || '—'}</div>
        <div className="span2"><i>Terms</i>{dc.terms || '—'}</div>
      </section>

      <section className="dc-parties">
        <Party title="Details of Receiver / Bill to" p={bill} />
        <Party title="Details of Consignee / Shipped to" p={ship} />
        <Party title="Dispatch from" p={from} />
      </section>

      <table className="dc-items">
        <thead>
          <tr>
            <th>#</th><th className="l">Raw item sent (SKU)</th><th className="l">Coating</th><th className="l">New item received back</th>
            <th>HSN / SAC</th><th>UOM</th><th className="r">Qty</th><th className="r">Rate</th><th className="r">Amount</th><th className="r">Disc.</th>
            <th className="r">Taxable value</th><th className="r">CGST</th><th className="r">SGST</th><th className="r">IGST</th><th className="r">Total</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.id}>
              <td className="c">{i + 1}</td>
              <td className="l"><div className="dc-item">{l.rawName}</div>{l.rawSku && l.rawSku !== l.rawName && <div className="dc-muted">{l.rawSku}</div>}</td>
              <td className="l">{l.coating}</td>
              <td className="l"><div className="dc-item">{l.coatedName}</div>{l.coatedSku && l.coatedSku !== l.coatedName && <div className="dc-muted">{l.coatedSku}</div>}</td>
              <td className="c">{l.hsn}</td>
              <td className="c">{l.unit || 'Nos'}</td>
              <td className="r">{l.pcs}</td>
              <td className="r">{inr(l.rawCostPerPc)}</td>
              <td className="r">{inr(l.amount)}</td>
              <td className="r">{l.discount ? inr(l.discount) : '—'}</td>
              <td className="r">{inr(l.taxable)}</td>
              <td className="r tax">{taxCell(l.cgst, l.rate / 2)}</td>
              <td className="r tax">{taxCell(l.sgst, l.rate / 2)}</td>
              <td className="r tax">{taxCell(l.igst, l.rate)}</td>
              <td className="r b">{inr(l.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={6} className="r">Total</td><td className="r">{qty}</td><td />
            <td className="r">{inr(sum('amount'))}</td><td className="r">{inr(sum('discount'))}</td><td className="r">{inr(taxable)}</td>
            <td className="r">{inr(cgst)}</td><td className="r">{inr(sgst)}</td><td className="r">{inr(igst)}</td><td className="r">{inr(exact)}</td>
          </tr>
        </tfoot>
      </table>

      <PrintBottom co={co} terms={co.terms} rcm={dc.reverseCharge}
        t={{ taxable, cgst, sgst, igst, roundOff: r2(grand - exact), grand }} />
    </div>
  );
}
