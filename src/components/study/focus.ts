// Moving between cards and lessons: start each one at the top of the page, and
// keep keyboard focus in the content when the focused button disappears.

import { useLayoutEffect, type RefObject } from 'react';

/** Scrolls back to the top whenever `key` changes. */
export function useScrollToTop(key: unknown): void {
  useLayoutEffect(() => {
    const page = document.scrollingElement;
    if (page) page.scrollTop = 0;
  }, [key]);
}

/**
 * When `key` changes and focus fell back to the page (the button that had it
 * was removed), moves it to the first heading inside `container`.
 */
export function useFocusHeading(container: RefObject<HTMLElement | null>, key: unknown): void {
  useLayoutEffect(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    const heading = container.current?.querySelector<HTMLElement>('h1, h2');
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [container, key]);
}
