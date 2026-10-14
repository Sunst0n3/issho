import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const boot = vi.hoisted(() => ({
  themeAtFirstRender: undefined as string | undefined,
  startSync: vi.fn(),
  installSpeechUnlock: vi.fn(),
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

describe('app start', () => {
  it('applies the remembered theme before the first render and starts sync, speech and the update prompt', async () => {
    localStorage.setItem('issho.theme', 'dark');
    document.body.innerHTML = '<div id="root"></div>';

    await act(async () => {
      await import('./main.tsx');
    });

    expect(boot.themeAtFirstRender).toBe('dark');
    expect(boot.startSync).toHaveBeenCalledTimes(1);
    expect(boot.installSpeechUnlock).toHaveBeenCalledTimes(1);
    expect(document.getElementById('root')!.textContent).toBe('AppUpdate prompt');
  });
});
