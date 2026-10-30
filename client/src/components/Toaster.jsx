import { useEffect, useState } from 'react';

// Tiny global toast store: toast.error('…') / toast.success('…') from anywhere.
let items = [];
let seq = 0;
const subs = new Set();
const emit = () => subs.forEach((f) => f(items));

function push(kind, msg, ms) {
  if (!msg) return;
  const text = String(msg);
  const same = items.find((t) => t.kind === kind && t.text === text);
  if (same) items = items.filter((t) => t !== same); // repeat: move to top, don't stack
  const t = { id: ++seq, kind, text };
  items = [...items, t].slice(-5);
  emit();
  if (ms) setTimeout(() => dismiss(t.id), ms);
}
export function dismiss(id) {
  items = items.filter((t) => t.id !== id);
  emit();
}
export const toast = {
  error: (msg) => push('error', msg, 0),   // stays until closed
  success: (msg) => push('success', msg, 3000),
  info: (msg) => push('info', msg, 3000),
};

export default function Toaster() {
  const [list, setList] = useState(items);
  useEffect(() => {
    subs.add(setList);
    // promises nobody caught (e.g. a failed delete) still show up
    const unhandled = (e) => toast.error(e.reason?.message || String(e.reason));
    window.addEventListener('unhandledrejection', unhandled);
    return () => { subs.delete(setList); window.removeEventListener('unhandledrejection', unhandled); };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <span className="toast-icon">{t.kind === 'error' ? '!' : t.kind === 'success' ? '✓' : 'i'}</span>
          <span className="toast-text">{t.text}</span>
          <button className="toast-x" title="Close" onClick={() => dismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
