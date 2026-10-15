import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const boot = vi.hoisted(() => ({
  themeAtFirstRender: undefined as string | undefined,
  startSync: vi.fn(),
  installSpeechUnlock: vi.fn(),
  installAudioUnlock: vi.fn(),
  silenceInDev: vi.fn(),
  devSeed: vi.fn(async () => {}),
}));

vi.mock('./App.tsx', () => ({
  default: function App() {
    boot.themeAtFirstRender ??= document.documentElement.dataset.theme ?? 'system';
    return <p>App</p>;
  },
}));
vi.mock('./components/UpdatePrompt.tsx', () => ({ default: () => <p>Update prompt</p> }));
vi.mock('./sync/index.ts', () => ({ startSync: boot.startSync }));
vi.mock('./speech/tts.ts', () => ({ installSpeechUnlock: boot.installSpeechUnlock }));
vi.mock('./speech/audio.ts', () => ({ installAudioUnlock: boot.installAudioUnlock }));
vi.mock('./devSilence.ts', () => ({ silenceInDev: boot.silenceInDev }));
vi.mock('./srs/devSeed.ts', () => ({ devSeed: boot.devSeed }));

describe('app start', () => {
  it('applies the remembered theme before the first render and starts sync, speech, audio and the update prompt', async () => {
    localStorage.setItem('issho.theme', 'dark');
    document.body.innerHTML = '<div id="root"></div>';

    await act(async () => {
      await import('./main.tsx');
    });

    expect(boot.themeAtFirstRender).toBe('dark');
    expect(boot.startSync).toHaveBeenCalledTimes(1);
    expect(boot.installSpeechUnlock).toHaveBeenCalledTimes(1);
    expect(boot.installAudioUnlock).toHaveBeenCalledTimes(1);
    expect(document.getElementById('root')!.textContent).toBe('AppUpdate prompt');
  });

  it('keeps development silent and exposes the dev seeding helper', async () => {
    expect(import.meta.env.DEV).toBe(true);
    expect(boot.silenceInDev).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect((window as Window & { __issho?: { devSeed: unknown } }).__issho?.devSeed).toBe(boot.devSeed));
  });

  // Checked at release, when the temporary localhost-silence block in main.tsx is removed (TECH-DESIGN §3.5.6).
  it.todo('does not silence a production build opened on localhost');
});
