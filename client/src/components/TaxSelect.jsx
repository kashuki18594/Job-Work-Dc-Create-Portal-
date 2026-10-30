import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useFloating from './useFloating';

const detail = (t) => [`${t.pct}%`, t.group ? 'CGST + SGST' : t.spec.toUpperCase()].filter(Boolean).join(' · ');

// Tax dropdown in the Books style: sections "Tax groups" / "GST taxes", name left, "18% · IGST" right.
// scope = 'intra' | 'inter' limits the list to taxes usable there (plus Exempt / Nil Rated).
export default function TaxSelect({ taxes, value, onChange, scope }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef(null);
  const listEl = useRef(null);
  const pos = useFloating(open, box, 300);
  const selected = taxes.find((t) => t.tax_id === value);

  useEffect(() => {
    const close = (e) => !box.current?.contains(e.target) && !listEl.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const sections = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = taxes.filter((t) => (!scope || !t.scope || t.scope === scope) && (!s || t.name.toLowerCase().includes(s)));
    return [['Tax groups', list.filter((t) => t.group)], ['GST taxes', list.filter((t) => !t.group)]].filter(([, l]) => l.length);
  }, [taxes, scope, q]);

  const pick = (t) => { onChange(t.tax_id); setOpen(false); setQ(''); };

  return (
    <div className="taxsel" ref={box}>
      <button type="button" className={`taxsel-btn ${open ? 'on' : ''}`} onClick={() => setOpen(!open)}>
        {selected ? <><span>{selected.name}</span><span className="taxsel-meta">{detail(selected)}</span></> : <span className="muted">Select tax…</span>}
        <span className="taxsel-caret">▾</span>
      </button>
      {open && pos && createPortal(
        <div className="taxsel-list" ref={listEl} style={pos}>
          <input autoFocus className="taxsel-search" placeholder="Search tax" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} />
          {sections.length === 0 && <div className="muted taxsel-empty">No match</div>}
          {sections.map(([title, list]) => (
            <div key={title}>
              <div className="taxsel-head">{title}</div>
              {list.map((t) => (
                <div key={t.tax_id} className={`taxsel-row ${t.tax_id === value ? 'sel' : ''}`} onMouseDown={(e) => { e.preventDefault(); pick(t); }}>
                  <span>{t.name}</span><span className="taxsel-meta">{detail(t)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
