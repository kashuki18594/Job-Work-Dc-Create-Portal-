import { Fragment, useState } from 'react';
import { inr, r2 } from '../calc';

// Shared pieces of the A4 delivery challan print (job work DC and normal DC).

// "33-Tamil Nadu" -> "Tamil Nadu": states print by name only
export const stateName = (s) => String(s || '').replace(/^\s*\d{1,2}\s*-\s*/, '');

export const ddmmyyyy = (d) => (d ? d.split('-').reverse().join('-') : '');

// Indian numbering: crore / lakh / thousand
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]} ${ONES[n % 10]}`.trim());
const three = (n) => [n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred` : '', two(n % 100)].filter(Boolean).join(' ');
function words(n) {
  n = Math.floor(n);
  if (!n) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  if (crore) parts.push(`${words(crore)} Crore`);
  for (const [div, name] of [[1e5, 'Lakh'], [1e3, 'Thousand']]) { const q = Math.floor(n / div); n %= div; if (q) parts.push(`${two(q)} ${name}`); }
  if (n) parts.push(three(n));
  return parts.join(' ');
}
export const rupeesInWords = (amt) => `Rupees ${words(amt)} Only.`;

const COPIES = ['Original for Recipient', 'Duplicate for Transporter', 'Triplicate for Supplier'];

// Copy selector + Print button; renders one page per chosen copy via children(copyLabel)
export function PrintShell({ warn, children }) {
  const [copy, setCopy] = useState(0); // index into COPIES, or -1 = all three
  return (
    <div className="print-wrap">
      <div className="noprint printbar">
        <div className="seg">
          {COPIES.map((c, i) => <button key={c} className={copy === i ? 'on' : ''} onClick={() => setCopy(i)}>{c.split(' ')[0]}</button>)}
          <button className={copy === -1 ? 'on' : ''} onClick={() => setCopy(-1)}>All 3</button>
        </div>
        <button className="btn primary" onClick={() => window.print()}>Print</button>
        {warn && <span className="warn">{warn}</span>}
      </div>
      {(copy === -1 ? COPIES : [COPIES[copy]]).map((c) => <Fragment key={c}>{children(c)}</Fragment>)}
    </div>
  );
}

// PAN is characters 3–12 of a GSTIN
const panOf = (gstin) => { const p = String(gstin || '').slice(2, 12); return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p) ? p : ''; };

// Company block from the DC's location (address, GSTIN, PAN, contact); Settings fill whatever the location lacks
export function PrintHeader({ co, loc, number, copyLabel }) {
  const gstin = loc?.gstin || co.gstin;
  const address = loc?.address?.length ? loc.address : [co.address];
  const contact = loc?.phone || co.phone; // location email is not printed
  return (
    <header className="dc-top">
      <div className="dc-brand">
        {co.logo && <img className="dc-logo" src={co.logo} alt="" />}
        <div>
          <div className="dc-co">{co.name}</div>
          {address.map((x) => <div key={x}>{x}</div>)}
          {contact && <div>{contact}</div>}
          <div>GSTIN: {gstin}</div>
          {(panOf(gstin) || co.pan) && <div>PAN: {panOf(gstin) || co.pan}</div>}
          {co.cin && <div>CIN: {co.cin}</div>}
        </div>
      </div>
      <div className="dc-titlebox">
        <div className="dc-title">Delivery Challan</div>
        <div className="dc-copy">{copyLabel}</div>
        <div className="dc-no">{number}</div>
      </div>
    </header>
  );
}

export function Party({ title, p }) {
  return (
    <div className="dc-party">
      <i>{title}</i>
      {p.name && <div className="dc-pname">{p.name}</div>}
      <div className="dc-addr">{p.address}</div>
      <div className="dc-pids">
        {p.gstin && <span><b>GSTIN</b> {p.gstin}</span>}
        {p.state && <span><b>State</b> {stateName(p.state)}</span>}
      </div>
    </div>
  );
}

export const taxCell = (amt, rate) => (amt ? <><small>{rate}%</small>{inr(amt)}</> : '—');

// Amount in words, bank details, terms (and notes) on the left; totals and signature on the right
export function PrintBottom({ co, t, terms, notes, rcm = 'No' }) {
  const gst = r2(t.cgst + t.sgst + t.igst);
  const lines = String(terms || '').split('\n').map((x) => x.trim()).filter(Boolean);
  return (
    <>
      <section className="dc-bottom">
        <div className="dc-left">
          <div className="dc-words"><i>Amount in words</i>{rupeesInWords(t.grand)}</div>
          {notes && <div className="dc-block"><i>Notes</i>{notes}</div>}
          {co.bankAccount && (
            <div className="dc-block">
              <i>Bank details</i>
              <table className="dc-kv"><tbody>
                <tr><td>Beneficiary</td><td>{co.bankBeneficiary}</td></tr>
                <tr><td>Banker</td><td>{co.bankName}</td></tr>
                {co.bankAddress && <tr><td>Bank address</td><td>{co.bankAddress}</td></tr>}
                <tr><td>Account no</td><td>{co.bankAccount}</td></tr>
                <tr><td>IFSC code</td><td>{co.bankIfsc}</td></tr>
              </tbody></table>
            </div>
          )}
          {lines.length > 0 && <div className="dc-block"><i>Terms & conditions</i><ol>{lines.map((x) => <li key={x}>{x}</li>)}</ol></div>}
        </div>

        <div className="dc-right">
          <table className="dc-totals"><tbody>
            <tr><td>Total amount before tax</td><td>{inr(t.taxable)}</td></tr>
            <tr><td>Add: CGST</td><td>{inr(t.cgst)}</td></tr>
            <tr><td>Add: SGST</td><td>{inr(t.sgst)}</td></tr>
            <tr><td>Add: IGST</td><td>{inr(t.igst)}</td></tr>
            <tr className="sep"><td>Total amount GST</td><td>{inr(gst)}</td></tr>
            <tr><td>Add/Less: Round off</td><td>{inr(t.roundOff)}</td></tr>
            <tr className="grand"><td>Total amount after tax</td><td>₹ {inr(t.grand)}</td></tr>
            <tr><td>GST payable under RCM</td><td>{rcm === 'Yes' ? inr(gst) : '0.00'}</td></tr>
          </tbody></table>
          <div className="dc-certify">Certified that the information given above is true and correct.</div>
          <div className="dc-sign"><b>For {co.name}</b><span>Authorised Signatory</span></div>
        </div>
      </section>
      {co.regdOffice && <footer className="dc-foot">Regd. Office: {co.regdOffice}</footer>}
    </>
  );
}
