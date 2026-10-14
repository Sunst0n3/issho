// The session's header (close, progress, count) and the "Stop for now?" confirm.

import { useEffect, useId, useRef } from 'react';
import { Icon, ProgressBar } from '../ui.tsx';

export function SessionHeader({ progress, label, onClose }: { progress: number; label: string; onClose: () => void }) {
  return (
    <div className="topbar st-header">
      <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
        <Icon name="close" size={22} />
      </button>
      <ProgressBar value={progress} label="Session progress" />
      <span className="st-count" aria-live="polite">{label}</span>
    </div>
  );
}

export function StopDialog({ onKeepGoing, onStop }: { onKeepGoing: () => void; onStop: () => void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const keepGoing = useRef(onKeepGoing);
  keepGoing.current = onKeepGoing;

  useEffect(() => {
    const opener = document.activeElement;
    keepRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') keepGoing.current();
      if (e.key !== 'Tab' || !dialogRef.current) return;
      // Modal: Tab cycles through the dialog's buttons and never reaches the page behind.
      e.preventDefault();
      const buttons = [...dialogRef.current.querySelectorAll('button')];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = at < 0 ? 0 : (at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <div className="st-backdrop" onClick={onKeepGoing}>
      <div ref={dialogRef} className="st-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}>
        <h2 id={titleId} className="st-dialog-title">Stop for now? <span>Your progress is saved.</span></h2>
        <div className="st-dialog-actions">
          <button ref={keepRef} type="button" className="btn secondary" onClick={onKeepGoing}>Keep going</button>
          <button type="button" className="btn ink" onClick={onStop}>Stop</button>
        </div>
      </div>
    </div>
  );
}
