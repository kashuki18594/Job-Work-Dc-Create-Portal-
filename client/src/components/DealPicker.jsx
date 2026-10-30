import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import useFloating from './useFloating';

// Search Zoho CRM deals (for the Deal Number / Stock Out Deal lookups on a challan line).
// value = { value: <CRM deal id>, label: 'Deal/2026/1114' } or null. With an empty search
// it looks for `hint` (the customer's name) first, so that customer's deals come up on top.
export default function DealPicker({ value, onChange, hint = '', invalid }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [list, setList] = useState(null);
  const [hi, setHi] = useState(0);
  const box = useRef(null);
  const input = useRef(null);
  const listEl = useRef(null);
  const pos = useFloating(open, input, 320);

  useEffect(() => {
    const close = (e) => !box.current?.contains(e.target) && !listEl.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  // search CRM 300 ms after typing stops; the latest answer wins
  useEffect(() => {
    if (!open) return;
    const term = q.trim() || hint;
    let live = true;
    setList(null);
    const t = setTimeout(async () => {
      try {
        let d = await api.get(`/api/crm/deals?q=${encodeURIComponent(term)}`);
        // customer has no deals: show the recent ones instead
        if (!q.trim() && !d.length && term) d = await api.get('/api/crm/deals');
        if (live) setList(d);
      } catch { if (live) setList([]); }
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [q, open, hint]);

  const pick = (d) => { onChange({ value: d.id, label: d.number }); setOpen(false); setQ(''); };

  return (
    <div className={`picker ${value ? 'has-value' : ''}`} ref={box}>
      {value && !open && (
        <button type="button" className="picker-clear" title="Clear" onMouseDown={(e) => e.preventDefault()} onClick={() => onChange(null)}>×</button>
      )}
      <input
        ref={input}
        className={invalid ? 'need' : ''}
        value={open ? q : value?.label || ''}
        placeholder={value ? value.label : 'Search deal'}
        onFocus={() => { setOpen(true); setHi(0); }}
        onChange={(e) => { setQ(e.target.value); setHi(0); }}
        onKeyDown={(e) => {
          if (!list) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, list.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          if (e.key === 'Enter' && list[hi]) { e.preventDefault(); pick(list[hi]); }
          if (e.key === 'Escape' || e.key === 'Tab') setOpen(false);
        }}
      />
      {open && pos && createPortal(
        <ul className="picker-list" ref={listEl} style={pos}>
          {list === null && <li className="muted">Searching Zoho CRM…</li>}
          {list?.length === 0 && <li className="muted">No deal found</li>}
          {list?.map((d, idx) => (
            <li key={d.id} className={idx === hi ? 'hi' : ''} onMouseDown={() => pick(d)} onMouseEnter={() => setHi(idx)}>
              <div className="strong">{d.number}</div>
              <div className="sub">{[d.name, d.account !== d.name && d.account, d.stage].filter(Boolean).join(' · ')}</div>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  );
}
