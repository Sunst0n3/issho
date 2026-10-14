import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeStroke, mistakeMessage } from './describe.ts';
import { STROKE_FIXTURES } from './fixtures.ts';
import { StrokeAnimation, StrokeOrderStrip } from './StrokeOrder.tsx';
import { useStrokes } from './useStrokes.ts';

const { strokesFor } = vi.hoisted(() => ({ strokesFor: vi.fn<(char: string) => Promise<string[] | undefined>>() }));
vi.mock('../lib/data.ts', () => ({ strokesFor }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  strokesFor.mockReset();
});

const MIZU = STROKE_FIXTURES['水'];

describe('StrokeOrderStrip', () => {
  it('draws one frame per stroke: done in ink, current in shu, the rest faint', () => {
    const view = render(<StrokeOrderStrip strokes={MIZU} label="Stroke order for 水" />);
    const frames = view.getAllByRole('listitem');
    expect(frames).toHaveLength(4);
    expect(view.getByRole('list', { name: 'Stroke order for 水' })).toBeTruthy();

    const third = frames[2];
    expect(third.querySelector('.stroke-badge')?.textContent).toBe('3');
    expect(third.querySelector('svg')?.getAttribute('aria-label')).toBe('Stroke 3 of 4');
    const classes = [...third.querySelectorAll('path')].map((p) => p.getAttribute('class'));
    expect(classes).toEqual(['done', 'done', 'current', 'todo']);
  });
});

describe('StrokeAnimation', () => {
  it('animates every stroke in order and can be replayed', () => {
    vi.useFakeTimers();
    const view = render(<StrokeAnimation strokes={MIZU} label="水" />);
    const runs = view.container.querySelectorAll<SVGPathElement>('.sa-run');
    expect(runs).toHaveLength(4);
    const delays = [...runs].map((p) => parseInt(p.style.getPropertyValue('--wp-delay'), 10));
    expect(delays[0]).toBe(0);
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThan(delays[i - 1]);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    const first = view.container.querySelector('.sa-run');
    fireEvent.click(view.getByRole('button', { name: 'Replay stroke order' }));
    // The animated group is re-mounted so the CSS animation starts over.
    expect(view.container.querySelector('.sa-run')).not.toBe(first);
  });

  it('waits for the play button when autoPlay is off', () => {
    const view = render(<StrokeAnimation strokes={MIZU} autoPlay={false} />);
    expect(view.container.querySelectorAll('.sa-run')).toHaveLength(0);
    expect(view.container.querySelectorAll('.sa-ink path')).toHaveLength(4);
    fireEvent.click(view.getByRole('button', { name: 'Play stroke order' }));
    expect(view.container.querySelectorAll('.sa-run')).toHaveLength(4);
  });

  it('speeds up with a higher speed', () => {
    const total = (speed: number) => {
      const view = render(<StrokeAnimation strokes={MIZU} speed={speed} />);
      const last = [...view.container.querySelectorAll<SVGPathElement>('.sa-run')].pop()!;
      const t = parseInt(last.style.getPropertyValue('--wp-delay'), 10);
      cleanup();
      return t;
    };
    expect(total(2)).toBeLessThan(total(1) * 0.6);
  });
});

describe('useStrokes', () => {
  it('loads strokes, then serves the same character from memory', async () => {
    strokesFor.mockResolvedValue([...MIZU]);
    const { result, unmount } = renderHook(() => useStrokes('水'));
    expect(result.current).toEqual({ loading: true, missing: false });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toEqual({ strokes: MIZU, loading: false, missing: false });
    unmount();

    const again = renderHook(() => useStrokes('水'));
    expect(again.result.current.strokes).toEqual(MIZU);
    expect(strokesFor).toHaveBeenCalledTimes(1);
  });

  it('reports characters KanjiVG does not have, and load failures', async () => {
    strokesFor.mockResolvedValueOnce(undefined);
    const missing = renderHook(() => useStrokes('☃'));
    await waitFor(() => expect(missing.result.current.missing).toBe(true));

    strokesFor.mockRejectedValueOnce(new Error('offline'));
    const failed = renderHook(() => useStrokes('木'));
    await waitFor(() => expect(failed.result.current.error?.message).toBe('offline'));
    expect(failed.result.current).toMatchObject({ loading: false, missing: false });
  });

  it('never returns the previous character while the next one loads', async () => {
    strokesFor.mockImplementation(async (c) => (c === '日' ? [...STROKE_FIXTURES['日']] : new Promise(() => {})));
    const { result, rerender } = renderHook(({ c }) => useStrokes(c), { initialProps: { c: '日' } });
    await waitFor(() => expect(result.current.strokes).toEqual(STROKE_FIXTURES['日']));
    rerender({ c: '田' });
    expect(result.current).toEqual({ loading: true, missing: false });
  });

  it('is idle without a character', () => {
    const { result } = renderHook(() => useStrokes(undefined));
    expect(result.current).toEqual({ loading: false, missing: false });
    expect(strokesFor).not.toHaveBeenCalled();
  });
});

describe('describeStroke and mistakeMessage', () => {
  it('describes where a stroke starts and where it goes', () => {
    expect(describeStroke(MIZU[2])).toBe('a stroke, top right, sweeping down-left');
    expect(describeStroke(STROKE_FIXTURES['口'][1])).toBe('a long stroke, top left, left to right, then down');
    expect(describeStroke(STROKE_FIXTURES['必'][0])).toMatch(/^a short stroke, top/);
  });

  it('explains mistakes, preferring stroke-order slips', () => {
    expect(mistakeMessage({ ok: false, score: 0.3, reason: 'position', drewStroke: 2 }, 1)).toBe(
      'That looks like stroke 3. Stroke 2 comes first.',
    );
    expect(mistakeMessage({ ok: false, score: 0.3, drewStroke: 0 }, 1)).toMatch(/stroke 1 again/);
    expect(mistakeMessage({ ok: false, score: 0.2, reason: 'direction' }, 0)).toMatch(/direction/);
    expect(mistakeMessage({ ok: false, score: 0.2, reason: 'too-short' }, 0)).toMatch(/longer/);
  });
});
