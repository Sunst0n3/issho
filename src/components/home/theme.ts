// Appearance: follow the system, or force light or dark. The choice lives in
// localStorage so it applies before IndexedDB has loaded (no flash on launch).

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'issho.theme';

export function storedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** The browser chrome (status bar on phones) follows the page background. */
function syncThemeColor(choice: ThemeChoice) {
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  if (!metas.length) return;
  const paper = choice === 'system'
    ? ''
    : getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  metas.forEach((meta) => {
    meta.dataset.systemColor ??= meta.content;
    meta.content = paper || meta.dataset.systemColor;
  });
}

export function applyTheme(choice: ThemeChoice): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  syncThemeColor(choice);
}

export function setTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage blocked: the choice still applies until the app is closed.
  }
  applyTheme(choice);
}

/** Call once at startup, before the first render. */
export function applyStoredTheme(): void {
  applyTheme(storedTheme());
}
