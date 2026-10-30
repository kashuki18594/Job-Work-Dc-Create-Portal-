import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useFloating from './useFloating';

const itemSub = (i) => `${i.sku}${i.stock_on_hand != null ? ` · Stock ${i.stock_on_hand}` : ''}${i.purchase_rate ? ` · Cost ₹${i.purchase_rate}` : ''}`;

// Searchable picker over a cached Zoho list (items by default; pass idKey/codeKey/subOf for vendors).
// The list renders in a portal with fixed position so scrolling table wrappers can't clip it.
// onCreate(query), when given, adds a "+ Create item" row at the end of the list.
// The × button clears the selection: onChange(null).
export default function ItemPicker({ items, value, onChange, placeholder = 'Search item / SKU', idKey = 'item_id', codeKey = 'sku', subOf = itemSub, onCreate }) {
  const selected = items.find((i) => i[idKey] === value);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const box = useRef(null);
  const input = useRef(null);
  const listEl = useRef(null);
  const pos = useFloating(open, input);

  useEffect(() => {
    const close = (e) => !box.current?.contains(e.target) && !listEl.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  useEffect(() => { listEl.current?.children[hi]?.scrollIntoView({ block: 'nearest' }); }, [hi]);

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    const f = t ? items.filter((i) => i.name.toLowerCase().includes(t) || (i[codeKey] || '').toLowerCase().includes(t)) : items;
    return f.slice(0, 40);
  }, [q, items, codeKey]);

  const pick = (i) => { onChange(i); setOpen(false); setQ(''); };

  return (
    <div className={`picker ${selected ? 'has-value' : ''}`} ref={box}>
      {selected && !open && (
        <button type="button" className="picker-clear" title="Clear" onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(null); setQ(''); }}>×</button>
      )}
      <input
        ref={input}
        value={open ? q : selected ? selected.name : ''}
        placeholder={selected ? selected.name : placeholder}
        onFocus={() => { setOpen(true); setHi(0); }}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, list.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          if (e.key === 'Enter' && list[hi]) { e.preventDefault(); pick(list[hi]); }
          if (e.key === 'Escape' || e.key === 'Tab') setOpen(false);
        }}
      />
      {selected && !open && selected[codeKey] && <div className="sub">{selected[codeKey]}</div>}
      {open && pos && createPortal(
        <ul className="picker-list" ref={listEl} style={pos}>
          {list.length === 0 && <li className="muted">No match</li>}
          {list.map((i, idx) => (
            <li key={i[idKey]} className={idx === hi ? 'hi' : ''} onMouseDown={() => pick(i)} onMouseEnter={() => setHi(idx)}>
              <div>{i.name}</div>
              <div className="sub">{subOf(i)}</div>
            </li>
          ))}
          {onCreate && (
            <li className="create" onMouseDown={(e) => { e.preventDefault(); setOpen(false); onCreate(q.trim()); setQ(''); }}>
              + Create new item in Books{q.trim() ? ` “${q.trim()}”` : ''}
            </li>
          )}
        </ul>,
        document.body,
      )}
    </div>
  );
}
