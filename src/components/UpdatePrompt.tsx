// "New version — Reload" bar for service-worker updates (vite-plugin-pwa, prompt mode).
// Installed iOS PWAs rarely check for a new service worker on their own, so we
// also check whenever the app returns to the foreground (at most every 30 min).
// "Ready to use offline" shows once the service worker controls this page (it
// claims the page on first install), not merely once it installed: until then
// the page still loads from the network and going offline would break it.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { Icon } from './ui.tsx';

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const OFFLINE_READY_MS = 4000;

export default function UpdatePrompt() {
  const registration = useRef<ServiceWorkerRegistration | undefined>(undefined);
  const lastCheck = useRef(0);

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      registration.current = reg;
      lastCheck.current = Date.now();
    },
    onRegisterError(error) {
      console.warn('service worker registration failed', error);
    },
  });

  useEffect(() => {
    const check = () => {
      const reg = registration.current;
      if (!reg || document.visibilityState !== 'visible' || !navigator.onLine) return;
      if (Date.now() - lastCheck.current < CHECK_INTERVAL_MS) return;
      lastCheck.current = Date.now();
      reg.update().catch(() => {});
    };
    document.addEventListener('visibilitychange', check);
    const timer = setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      document.removeEventListener('visibilitychange', check);
      clearInterval(timer);
    };
  }, []);

  const controlled = useControlled(offlineReady);

  useEffect(() => {
    if (!offlineReady || !controlled) return;
    const t = setTimeout(() => setOfflineReady(false), OFFLINE_READY_MS);
    return () => clearTimeout(t);
  }, [offlineReady, controlled, setOfflineReady]);

  if (!needRefresh && !(offlineReady && controlled)) return null;

  return (
    <div role="status" aria-live="polite" style={barStyle}>
      {needRefresh ? (
        <>
          <span style={{ flex: 1, minWidth: 0, fontWeight: 700 }}>New version available</span>
          <button type="button" className="btn small primary" onClick={() => void updateServiceWorker(true)}>
            <Icon name="refresh" size={18} />
            Reload
          </button>
          <button type="button" className="icon-btn" aria-label="Later" onClick={() => setNeedRefresh(false)}>
            <Icon name="close" size={20} />
          </button>
        </>
      ) : (
        <span style={{ flex: 1, padding: '10px 0' }}>Ready to use offline</span>
      )}
    </div>
  );
}

/** Whether a service worker controls this page; watched while `watch` is true. */
function useControlled(watch: boolean): boolean {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  const [controlled, setControlled] = useState(() => Boolean(sw?.controller));
  useEffect(() => {
    if (!watch || !sw) return;
    const check = () => setControlled(Boolean(sw.controller));
    check();
    sw.addEventListener('controllerchange', check);
    return () => sw.removeEventListener('controllerchange', check);
  }, [watch, sw]);
  return controlled;
}

const barStyle: CSSProperties = {
  position: 'fixed',
  top: 'calc(8px + var(--safe-top))',
  left: 12,
  right: 12,
  zIndex: 50,
  maxWidth: 536,
  margin: '0 auto',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 6px 6px 16px',
  borderRadius: 'var(--r-lg)',
  background: 'var(--card)',
  color: 'var(--ink)',
  border: '1px solid var(--line-strong)',
  boxShadow: '0 6px 24px color-mix(in srgb, var(--ink) 14%, transparent)',
  fontSize: 15,
};
