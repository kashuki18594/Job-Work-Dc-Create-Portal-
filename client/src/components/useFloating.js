import { useLayoutEffect, useState } from 'react';

const LIST_MAX_H = 300;

// Fixed-position style for a dropdown attached to `anchor` (rendered in a portal so
// scrolling wrappers can't clip it). Opens upward when there's no room below.
export default function useFloating(open, anchor, minWidth = 280) {
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchor.current.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      const up = below < Math.min(LIST_MAX_H, 200) && r.top > below;
      setPos({ left: r.left, width: Math.max(r.width, minWidth), ...(up ? { bottom: window.innerHeight - r.top + 2 } : { top: r.bottom + 2 }), maxHeight: Math.min(LIST_MAX_H, (up ? r.top : below) - 8) });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open]);
  return pos;
}
