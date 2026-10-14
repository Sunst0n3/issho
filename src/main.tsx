import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.tsx';
import UpdatePrompt from './components/UpdatePrompt.tsx';
import { requestPersistentStorage } from './lib/backup.ts';
import { getSettings } from './lib/db.ts';
import { installSpeechUnlock } from './speech/tts.ts';
import { startSync } from './sync/index.ts';
import './styles/global.css';

startSync();
installSpeechUnlock();
// Onboarding asks for persistent storage; repeating it on later launches is a cheap no-op
// and covers people who onboarded before it was granted.
void getSettings().then((s) => (s.onboarded ? requestPersistentStorage() : false));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
      <UpdatePrompt />
    </BrowserRouter>
  </StrictMode>,
);
