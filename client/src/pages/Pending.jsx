import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { inr } from '../calc';

export default function Pending() {
  const [rows, setRows] = useState(null);
  const [vendor, setVendor] = useState('');
  useEffect(() => { api.get('/api/reports/pending').then(setRows); }, []);
  if (!rows) return <p className="muted">Loading…</p>;
  const vendors = [...new Set(rows.map((r) => r.vendorName))];
  const shown = rows.filter((r) => !vendor || r.vendorName === vendor);
  const byV = vendors.map((v) => {
    const rs = rows.filter((r) => r.vendorName === v);
    return { v, pcs: rs.reduce((a, r) => a + r.balance, 0), value: rs.reduce((a, r) => a + r.value, 0) };
  });
  const exportCsv = () => {
    const head = ['DC No', 'DC Date', 'Days', 'Job worker', 'Raw item', 'Coating', 'New item', 'Sent', 'Received', 'Scrap', 'Balance', 'Value'];
    const body = shown.map((r) => [r.dcNo, r.date, r.days, r.vendorName, r.rawName, r.coating, r.coatedName, r.sent, r.received, r.scrap, r.balance, r.value]);
    const csv = [head, ...body].map((row) => row.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `pending-job-work-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };
  return (
    <>
      <div className="head"><h1>Material pending with job workers</h1><button className="btn" onClick={exportCsv}>Export CSV</button></div>
      <div className="tiles">
        {byV.map((x) => (
          <button key={x.v} className={`tile ${vendor === x.v ? 'on' : ''}`} onClick={() => setVendor(vendor === x.v ? '' : x.v)}>
            <div className="sub">{x.v}</div><div className="big">{x.pcs} pcs</div><div className="sub">₹{inr(x.value)} raw value</div>
          </button>
        ))}
        {byV.length === 0 && <p className="muted">Nothing pending. 🎉</p>}
      </div>
      <p className="hint">Total raw value here should equal the <b>Job Work Clearing</b> account balance in Books (after all vendor bills are entered).</p>
      <table className="grid">
        <thead><tr><th>DC No</th><th>Date</th><th className="r">Days</th><th>Job worker</th><th>Raw item</th><th>Coating</th><th>New item</th><th className="r">Sent</th><th className="r">Recd</th><th className="r">Scrap</th><th className="r">Balance</th><th className="r">Value ₹</th></tr></thead>
        <tbody>{shown.map((r, i) => (
          <tr key={i}>
            <td><Link to={`/dc/${r.dcId}`}>{r.dcNo}</Link></td><td>{r.date}</td>
            <td className={`r ${r.days > 300 ? 'warn strong' : ''}`} title={r.days > 300 ? 'Approaching 1-year job work limit' : ''}>{r.days}</td>
            <td>{r.vendorName}</td><td>{r.rawName}</td><td>{r.coating}</td><td>{r.coatedName}</td>
            <td className="r">{r.sent}</td><td className="r">{r.received}</td><td className="r">{r.scrap}</td><td className="r strong">{r.balance}</td><td className="r">{inr(r.value)}</td>
          </tr>
        ))}</tbody>
      </table>
    </>
  );
}
