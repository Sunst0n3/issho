// A modal sheet that slides up from the bottom (kana chart details).
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../ui.tsx';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function BottomSheet({ title, onClose, children }: {
  /** Accessible name for the dialog. */
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('.hm-sheet-close')?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, []);

  // Keep Tab inside the sheet while it is open.
  const trapTab = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return createPortal(
    <div className="hm-sheet-layer">
      <div className="hm-sheet-backdrop" aria-hidden="true" onClick={onClose} />
      <div ref={panel} className="hm-sheet" role="dialog" aria-modal="true" aria-label={title} onKeyDown={trapTab}>
        <div className="hm-sheet-grip" aria-hidden="true" />
        <button type="button" className="icon-btn hm-sheet-close" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={22} />
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );
}
