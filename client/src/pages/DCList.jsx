import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { inr } from '../calc';
import { toast } from '../components/Toaster';
import Status from '../components/Status';

export default function DCList() {
  const [params, setParams] = useSearchParams();
  const kind = params.get('kind') === 'normal' ? 'normal' : 'job-work';
  return (
    <>
      <div className="head">
        <h1>Delivery Challans</h1>
        <Link className="btn primary" to="/dc/new">+ New DC</Link>
      </div>
      <div className="seg kind-seg">
        <button className={kind === 'job-work' ? 'on' : ''} onClick={() => setParams({})}>Job Work <span className="sub">in this app</span></button>
        <button className={kind === 'normal' ? 'on' : ''} onClick={() => setParams({ kind: 'normal' })}>Normal <span className="sub">in Zoho Books</span></button>
      </div>
      {kind === 'normal' ? <NormalList /> : <JobWorkList />}
    </>
  );
}

function JobWorkList() {
  const [rows, setRows] = useState(null);
  const [f, setF] = useState('open');
  const [q, setQ] = useState('');
  const nav = useNavigate();
  useEffect(() => { api.get('/api/dcs').then(setRows).catch((e) => { toast.error(e.message); setRows([]); }); }, []);
  if (!rows) return <p className="muted">Loading…</p>;

  const open = ['draft', 'confirming', 'confirmed', 'partial', 'received'];
  const shown = rows
    .filter((r) => f === 'all' || (f === 'open' ? open.includes(r.status) : r.status === f))
    .filter((r) => !q || `${r.dcNo} ${r.vendorName} ${r.poNumber}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <div className="toolbar">
        {['open', 'draft', 'confirmed', 'partial', 'received', 'closed', 'cancelled', 'all'].map((k) => (
          <button key={k} className={`tab ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{k[0].toUpperCase() + k.slice(1)}</button>
        ))}
        <input className="search" placeholder="Search DC / vendor / PO" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <table className="grid">
        <thead><tr><th>DC No</th><th>Date</th><th>Job worker</th><th>PO</th><th>Status</th><th className="r">Sent</th><th className="r">Received</th><th className="r">Scrap</th><th className="r">Balance</th></tr></thead>
        <tbody>
          {shown.length === 0 && <tr><td colSpan={9} className="muted center">No challans here yet.</td></tr>}
          {shown.map((r) => (
            <tr key={r.id} className="click" onClick={() => nav(`/dc/${r.id}`)}>
              <td className="strong">{r.dcNo}</td><td>{r.date}</td><td>{r.vendorName}</td><td>{r.poNumber}</td>
              <td><Status s={r.status} /></td>
              <td className="r">{r.pcs}</td><td className="r">{r.received}</td><td className="r">{r.scrap}</td>
              <td className={`r ${r.balance > 0 && r.status !== 'draft' ? 'warn' : ''}`}>{r.balance}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// Books status names; Books lists a delivered challan as "fulfilled"
const STATUS = { draft: 'Draft', open: 'Open', fulfilled: 'Delivered', delivered: 'Delivered', invoiced: 'Invoiced', returned: 'Returned' };

// Normal DCs live in Zoho Books; this lists them straight from Books, with print and status actions.
function NormalList() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const load = () => api.get('/api/normal-dcs').then(setRows).catch((e) => { toast.error(e.message); setRows([]); });
  useEffect(() => { load(); }, []);
  if (!rows) return <p className="muted">Loading from Zoho Books…</p>;
  const shown = rows.filter((r) => !q || `${r.number} ${r.customerName} ${r.reference}`.toLowerCase().includes(q.toLowerCase()));

  async function mark(r, status) {
    setBusy(r.id + status);
    try {
      await api.post(`/api/normal-dcs/${r.id}/status/${status}`);
      toast.success(`${r.number} marked as ${status === 'open' ? 'Open' : 'Delivered'} in Zoho Books`);
      await load();
    } catch (e) { toast.error(e.message); } finally { setBusy(''); }
  }

  return (
    <>
      <div className="toolbar">
        <span className="muted">Latest {rows.length} from Zoho Books</span>
        <input className="search" placeholder="Search DC / customer / reference" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <table className="grid">
        <thead><tr><th>DC No</th><th>Date</th><th>Customer</th><th>Reference</th><th>Location</th><th>Status</th><th className="r">Total ₹</th><th></th></tr></thead>
        <tbody>
          {shown.length === 0 && <tr><td colSpan={8} className="muted center">No delivery challans in Books yet.</td></tr>}
          {shown.map((r) => (
            <tr key={r.id}>
              <td className="strong">{r.number}</td><td>{r.date}</td><td>{r.customerName}</td><td>{r.reference}</td><td>{r.location}</td>
              <td><span className={`chip chip-${r.status}`}>{STATUS[r.status] || r.status}</span></td>
              <td className="r">{inr(r.total)}</td>
              <td className="row-actions">
                <a className="btn sm" href={`/normal-dc/${r.id}/print`} target="_blank" rel="noreferrer">Print</a>
                {['draft', 'open'].includes(r.status) && <Link className="btn sm" to={`/dc/normal/${r.id}/edit`}>Edit</Link>}
                {r.status === 'draft' && <button className="btn sm" disabled={!!busy} onClick={() => mark(r, 'open')}>{busy === r.id + 'open' ? '…' : 'Mark as Open'}</button>}
                {r.status === 'open' && <button className="btn sm" disabled={!!busy} onClick={() => mark(r, 'delivered')}>{busy === r.id + 'delivered' ? '…' : 'Mark as Delivered'}</button>}
                <a className="btn sm" href={r.url} target="_blank" rel="noreferrer">Zoho ↗</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
