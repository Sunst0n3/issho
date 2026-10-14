import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.tsx';
import UpdatePrompt from './components/UpdatePrompt.tsx';
import { applyStoredTheme } from './components/home/theme.ts';
import { requestPersistentStorage } from './lib/backup.ts';
import { getSettings } from './lib/db.ts';
import { installSpeechUnlock } from './speech/tts.ts';
import { startSync } from './sync/index.ts';
import { silenceInDev } from './devSilence.ts';
import './styles/global.css';

// TEMPORARY while testing on this machine: also silence local production builds.
if (import.meta.env.DEV || ['localhost', '127.0.0.1'].includes(location.hostname)) silenceInDev();

// Before the first render, so a forced light or dark theme never flashes the system one.
applyStoredTheme();
startSync();
installSpeechUnlock();
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
