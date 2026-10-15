import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.tsx';
import UpdatePrompt from './components/UpdatePrompt.tsx';
import { applyStoredTheme } from './components/home/theme.ts';
import { requestPersistentStorage } from './lib/backup.ts';
import { getSettings } from './lib/db.ts';
import { installAudioUnlock } from './speech/audio.ts';
import { installSpeechUnlock } from './speech/tts.ts';
import { startSync } from './sync/index.ts';
import { silenceInDev } from './devSilence.ts';
import './styles/global.css';

// Development stays silent unless localStorage 'issho.dev-sound' is '1'.
if (import.meta.env.DEV) silenceInDev();

// Development: window.__issho.devSeed(N) seeds a course at day N for manual checks.
if (import.meta.env.DEV) {
  void import('./srs/devSeed.ts').then((m) => {
    (window as Window & { __issho?: { devSeed: typeof m.devSeed } }).__issho = { devSeed: m.devSeed };
  });
}

// Before the first render, so a forced light or dark theme never flashes the system one.
applyStoredTheme();
startSync();
installSpeechUnlock();
installAudioUnlock();
// Onboarding asks for persistent storage; repeating it on later launches is a cheap no-op
// and covers people who onboarded before it was granted.
void getSettings().then((s) => (s.onboarded ? requestPersistentStorage() : false));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
      <UpdatePrompt />
    </BrowserRouter>
  </StrictMode>,
);
