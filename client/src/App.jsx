import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from './api';
import DCList from './pages/DCList';
import DCForm from './pages/DCForm';
import NewDC from './pages/NewDC';
import NormalDCForm from './pages/NormalDCForm';
import DCView from './pages/DCView';
import DCPrint from './pages/DCPrint';
import NormalDCPrint from './pages/NormalDCPrint';
import Pending from './pages/Pending';
import Settings from './pages/Settings';
import Toaster from './components/Toaster';

export default function App() {
  const loc = useLocation();
  const [health, setHealth] = useState(null);
  useEffect(() => { api.get('/api/health').then(setHealth).catch((e) => setHealth({ ok: false, error: e.message })); }, []);

  if (loc.pathname.endsWith('/print')) return <><Routes><Route path="/dc/:id/print" element={<DCPrint />} /><Route path="/normal-dc/:id/print" element={<NormalDCPrint />} /></Routes><Toaster /></>;

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Job Work<span>Manager</span></div>
        <nav>
          <NavLink to="/" end>Delivery Challans</NavLink>
          <NavLink to="/dc/new" end={false}>+ New DC</NavLink>
          <NavLink to="/pending">Pending with job worker</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className={`conn ${health?.ok ? 'ok' : 'bad'}`}>
          {health == null ? 'Checking Zoho…' : health.ok ? `● Zoho Books: ${health.organization}` : `● Zoho not connected`}
          {health && !health.ok && <div className="sub">{health.error}</div>}
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<DCList />} />
          <Route path="/dc/new" element={<NewDC />} />
          <Route path="/dc/new/job-work" element={<DCForm />} />
          <Route path="/dc/new/normal" element={<NormalDCForm />} />
          <Route path="/dc/normal/:id/edit" element={<NormalDCForm />} />
          <Route path="/dc/:id/edit" element={<DCForm />} />
          <Route path="/dc/:id" element={<DCView />} />
          <Route path="/pending" element={<Pending />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
      <Toaster />
    </div>
  );
}
