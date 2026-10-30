import { useEffect, useState } from 'react';

// "Dispatch From" on a normal DC: entered as a proper address, saved in the Books custom field
// as plain lines (name / address / address 2 / "City, State - PIN" / "GSTIN: …").
const EMPTY = { name: '', street1: '', street2: '', city: '', state: '', zip: '', gstin: '' };

export function composeDispatch(p) {
  const place = [[p.city, p.state].filter(Boolean).join(', '), p.zip].filter(Boolean).join(' - ');
  // no name: both address lines go on one line, so reading it back can't mistake address for name
  const street = p.name.trim() ? [p.street1, p.street2] : [[p.street1, p.street2].map((x) => x.trim()).filter(Boolean).join(', ')];
  return [p.name, ...street, place, p.gstin && `GSTIN: ${p.gstin}`]
    .map((x) => String(x || '').trim()).filter(Boolean).join('\n');
}

// Back from the saved text. Text typed in another layout (e.g. in Zoho) lands in the address lines.
export function parseDispatch(text, stateNames) {
  const lines = String(text || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const p = { ...EMPTY };
  const g = lines.findIndex((l) => /^GSTIN\s*:/i.test(l));
  if (g >= 0) p.gstin = lines.splice(g, 1)[0].replace(/^GSTIN\s*:\s*/i, '');
  const placeRe = /^(.*?),\s*(.+?)(?:\s*-\s*(\d{6}))?$/;
  const pi = lines.findIndex((l) => { const m = l.match(placeRe); return m && stateNames.includes(m[2]); });
  if (pi >= 0) {
    const m = lines.splice(pi, 1)[0].match(placeRe);
    Object.assign(p, { city: m[1], state: m[2], zip: m[3] || '' });
  }
  // lines left: name / address / address 2 (one line = address only)
  if (lines.length === 1) p.street1 = lines[0];
  else if (lines.length > 1) { p.name = lines[0]; p.street1 = lines[1]; p.street2 = lines.slice(2).join(', '); }
  return p;
}

export default function DispatchFromEditor({ value, onChange, locations, states }) {
  const stateNames = states.map((s) => s.name);
  const [p, setP] = useState(() => parseDispatch(value, stateNames));

  // value changed from outside (challan loaded for edit): refill the boxes
  useEffect(() => { if ((value || '') !== composeDispatch(p)) setP(parseDispatch(value, stateNames)); }, [value]);

  const set = (patch) => { const n = { ...p, ...patch }; setP(n); onChange(composeDispatch(n)); };
  const fromLocation = (id) => {
    const l = locations.find((x) => x.id === id);
    if (l) set({ name: p.name, street1: l.parts.street1, street2: l.parts.street2, city: l.parts.city, state: l.parts.state, zip: l.parts.zip, gstin: l.gstin });
  };
  const text = composeDispatch(p);

  return (
    <div className="dispatch-ed span4">
      <div className="lbl-row">
        <span className="party-title">Dispatch From</span>
        <select className="dispatch-fill" value="" onChange={(e) => fromLocation(e.target.value)}>
          <option value="">Fill from location…</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>
      <div className="form4">
        <label className="span2">Name<input value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. company / warehouse name" /></label>
        <label>GSTIN<input value={p.gstin} maxLength={15} onChange={(e) => set({ gstin: e.target.value.toUpperCase().trim() })} /></label>
        <div />
        <label className="span2">Address<input value={p.street1} onChange={(e) => set({ street1: e.target.value })} /></label>
        <label className="span2">Address 2<input value={p.street2} onChange={(e) => set({ street2: e.target.value })} /></label>
        <label>City<input value={p.city} onChange={(e) => set({ city: e.target.value })} /></label>
        <label>State
          <select value={p.state} onChange={(e) => set({ state: e.target.value })}>
            <option value="">Select state…</option>
            {p.state && !stateNames.includes(p.state) && <option>{p.state}</option>}
            {stateNames.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label>PIN code<input value={p.zip} maxLength={6} onChange={(e) => set({ zip: e.target.value.replace(/\D/g, '') })} /></label>
      </div>
      {text && <div className="addr-block dispatch-preview"><span className="sub">Saved in Zoho as:</span>{text}</div>}
    </div>
  );
}
