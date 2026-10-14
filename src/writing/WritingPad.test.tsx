import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createRef, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STROKE_FIXTURES } from './fixtures.ts';
import { samplePath, type Point } from './path.ts';
import { WritingPad, type WritingPadHandle } from './WritingPad.tsx';

// jsdom does no layout: give the pad a 327 px square box (3 px per KanjiVG unit).
const SIZE = 327;
const SCALE = SIZE / 109;

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: SIZE, bottom: SIZE, width: SIZE, height: SIZE, toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const HITO = STROKE_FIXTURES['人'];

function setup(mode: 'trace' | 'guided' | 'memory' = 'trace', strokes: readonly string[] = HITO) {
  const ref = createRef<WritingPadHandle>();
  const onStrokeResult = vi.fn();
  const onComplete = vi.fn();
  const view = render(
    <WritingPad ref={ref} strokes={strokes} mode={mode} label="人" onStrokeResult={onStrokeResult} onComplete={onComplete} />,
  );
  const svg = view.getByRole('img');
  return { ref, onStrokeResult, onComplete, svg, container: view.container };
}

/** Drags a pointer through the given box points. */
function draw(svg: Element, pts: readonly Point[], pointerId = 1, pointerType = 'touch') {
  const at = (p: Point) => ({ pointerId, pointerType, isPrimary: true, button: 0, clientX: p.x * SCALE, clientY: p.y * SCALE });
  fireEvent.pointerDown(svg, at(pts[0]));
  for (const p of pts.slice(1, -1)) fireEvent.pointerMove(svg, at(p));
  fireEvent.pointerUp(svg, at(pts[pts.length - 1]));
}

const strokePoints = (d: string) => samplePath(d, 24);
const reversed = (d: string) => [...strokePoints(d)].reverse();

describe('WritingPad', () => {
  it('accepts a correct stroke and snaps it to the model stroke', () => {
    const { svg, onStrokeResult, onComplete, container } = setup();
    draw(svg, strokePoints(HITO[0]));

    expect(onStrokeResult).toHaveBeenCalledTimes(1);
    expect(onStrokeResult).toHaveBeenCalledWith(0, true, expect.objectContaining({ ok: true }));
    const ink = container.querySelectorAll('.wp-ink path');
    expect(ink).toHaveLength(1);
    expect(ink[0].getAttribute('d')).toBe(HITO[0]);
    expect(svg.getAttribute('aria-label')).toBe('Writing pad for 人: 1 of 2 strokes drawn');
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('rejects a reversed stroke with a shu flash, then completes', () => {
    const { svg, onStrokeResult, onComplete, container } = setup();
    draw(svg, strokePoints(HITO[0]));
    draw(svg, reversed(HITO[1]));

    expect(onStrokeResult).toHaveBeenLastCalledWith(1, false, expect.objectContaining({ ok: false, reason: 'direction' }));
    expect(container.querySelectorAll('.wp-ink path')).toHaveLength(1);
    expect(container.querySelector('.wp-flash')).not.toBeNull();
    expect(container.querySelector('[aria-live]')?.textContent).toMatch(/^Stroke 2: /);

    draw(svg, strokePoints(HITO[1]));
    expect(container.querySelector('.wp-flash')).toBeNull();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({ mistakes: 1, hintsUsed: 0, strokeCount: 2, gaveUp: false, failedStrokes: 1 });
    expect(svg.getAttribute('aria-label')).toMatch(/2 of 2 strokes drawn, complete$/);

    // Finished: further input is ignored.
    draw(svg, strokePoints(HITO[0]));
    expect(onStrokeResult).toHaveBeenCalledTimes(3);
  });

  it('names the stroke drawn out of order', () => {
    const { svg, onStrokeResult } = setup();
    draw(svg, strokePoints(HITO[1]));
    expect(onStrokeResult).toHaveBeenCalledWith(0, false, expect.objectContaining({ ok: false, drewStroke: 1 }));
  });

  it('shows the stroke automatically after two misses, counting one hint', () => {
    const { svg, onComplete, container } = setup('memory');
    draw(svg, reversed(HITO[0]));
    expect(container.querySelector('.wp-hint')).toBeNull();
    draw(svg, reversed(HITO[0]));
    const hint = container.querySelector('.wp-hint');
    expect(hint?.getAttribute('d')).toBe(HITO[0]);
    draw(svg, reversed(HITO[0]));

    draw(svg, strokePoints(HITO[0]));
    expect(container.querySelector('.wp-hint')).toBeNull();
    draw(svg, strokePoints(HITO[1]));
    expect(onComplete).toHaveBeenCalledWith({ mistakes: 3, hintsUsed: 1, strokeCount: 2, gaveUp: false, failedStrokes: 1 });
  });

  it('ignores stray taps and a second finger', () => {
    const { svg, onStrokeResult, container } = setup();
    draw(svg, [{ x: 50, y: 50 }, { x: 50.3, y: 50.2 }]);
    expect(onStrokeResult).not.toHaveBeenCalled();

    const pts = strokePoints(HITO[0]);
    const at = (p: Point, pointerId: number) => ({ pointerId, pointerType: 'touch', isPrimary: pointerId === 1, clientX: p.x * SCALE, clientY: p.y * SCALE });
    fireEvent.pointerDown(svg, at(pts[0], 1));
    fireEvent.pointerDown(svg, at({ x: 90, y: 90 }, 2));
    for (const p of pts.slice(1)) {
      fireEvent.pointerMove(svg, at(p, 1));
      fireEvent.pointerMove(svg, at({ x: 90, y: 20 }, 2));
    }
    fireEvent.pointerUp(svg, at({ x: 90, y: 20 }, 2));
    fireEvent.pointerUp(svg, at(pts[pts.length - 1], 1));
    expect(onStrokeResult).toHaveBeenCalledTimes(1);
    expect(onStrokeResult).toHaveBeenCalledWith(0, true, expect.anything());
    expect(container.querySelectorAll('.wp-ink path')).toHaveLength(1);
  });

  it('recovers when a stroke’s pointerup never arrives', () => {
    // Lifted outside the pad without pointer capture: the pad must not stay locked
    // on that pointer and ignore every later stroke as a "second finger".
    const { svg, onStrokeResult } = setup();
    const pts = strokePoints(HITO[0]);
    const at = (p: Point, pointerId: number, pointerType = 'touch') =>
      ({ pointerId, pointerType, isPrimary: true, button: 0, clientX: p.x * SCALE, clientY: p.y * SCALE });
    fireEvent.pointerDown(svg, at(pts[0], 1));
    fireEvent.pointerMove(svg, at(pts[8], 1));
    draw(svg, pts, 2); // the next touch
    expect(onStrokeResult).toHaveBeenCalledTimes(1);
    expect(onStrokeResult).toHaveBeenLastCalledWith(0, true, expect.anything());

    // A mouse pressing again with the same pointer id.
    const second = strokePoints(HITO[1]);
    fireEvent.pointerDown(svg, at(second[0], 1, 'mouse'));
    fireEvent.pointerMove(svg, at(second[8], 1, 'mouse'));
    draw(svg, second, 1, 'mouse');
    expect(onStrokeResult).toHaveBeenCalledTimes(2);
    expect(onStrokeResult).toHaveBeenLastCalledWith(1, true, expect.anything());
  });

  it('drops a stroke whose pointer capture is lost, then carries on', () => {
    const { svg, onStrokeResult, container } = setup();
    const pts = strokePoints(HITO[0]);
    const at = (p: Point) => ({ pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: p.x * SCALE, clientY: p.y * SCALE });
    fireEvent.pointerDown(svg, at(pts[0]));
    fireEvent.pointerMove(svg, at(pts[10]));
    fireEvent.lostPointerCapture(svg, { pointerId: 1 });
    expect(container.querySelector('.wp-live')?.getAttribute('d')).toBe('');
    fireEvent.pointerUp(svg, at(pts[pts.length - 1]));
    expect(onStrokeResult).not.toHaveBeenCalled();
    draw(svg, pts, 2);
    expect(onStrokeResult).toHaveBeenCalledWith(0, true, expect.anything());
  });

  it('ignores a resting palm while a pen is in use, but accepts fingers again afterwards', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100_000);
    const { svg, onStrokeResult } = setup();
    draw(svg, strokePoints(HITO[0]), 1, 'pen');
    draw(svg, strokePoints(HITO[1]), 2, 'touch');
    expect(onStrokeResult).toHaveBeenCalledTimes(1);

    vi.setSystemTime(110_000);
    draw(svg, strokePoints(HITO[1]), 3, 'touch');
    expect(onStrokeResult).toHaveBeenCalledTimes(2);
    expect(onStrokeResult).toHaveBeenLastCalledWith(1, true, expect.anything());
  });

  it('accepts a tapped dot, and ignores a stray tap without counting a mistake', () => {
    const hitsu = STROKE_FIXTURES['必'];
    const { svg, onStrokeResult, container } = setup('memory', hitsu);
    draw(svg, [{ x: 95, y: 15 }]);
    expect(onStrokeResult).not.toHaveBeenCalled();
    expect(container.querySelector('.wp-flash')).toBeNull();

    draw(svg, [samplePath(hitsu[0], 3)[1]]);
    expect(onStrokeResult).toHaveBeenCalledWith(0, true, expect.objectContaining({ ok: true }));
    expect(container.querySelectorAll('.wp-ink path')).toHaveLength(1);
  });

  it('starts a new attempt when the mode changes, so one pad serves trace → guided → memory', () => {
    const onComplete = vi.fn();
    const view = render(<WritingPad strokes={HITO} mode="trace" onComplete={onComplete} />);
    const svg = view.getByRole('img');
    draw(svg, strokePoints(HITO[0]));
    draw(svg, reversed(HITO[1]));
    draw(svg, strokePoints(HITO[1]));
    expect(onComplete).toHaveBeenCalledTimes(1);

    view.rerender(<WritingPad strokes={HITO} mode="guided" onComplete={onComplete} />);
    expect(view.container.querySelectorAll('.wp-ink path')).toHaveLength(0);
    draw(svg, strokePoints(HITO[0]));
    draw(svg, strokePoints(HITO[1]));
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenLastCalledWith(expect.objectContaining({ mistakes: 0, gaveUp: false }));
  });

  it('reports each stroke and the completion exactly once under StrictMode', () => {
    const onStrokeResult = vi.fn();
    const onComplete = vi.fn();
    const view = render(
      <StrictMode>
        <WritingPad strokes={HITO} mode="guided" onStrokeResult={onStrokeResult} onComplete={onComplete} />
      </StrictMode>,
    );
    const svg = view.getByRole('img');
    draw(svg, strokePoints(HITO[0]));
    draw(svg, reversed(HITO[1]));
    draw(svg, strokePoints(HITO[1]));
    expect(onStrokeResult.mock.calls.map(([i, ok]) => [i, ok])).toEqual([[0, true], [1, false], [1, true]]);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({ mistakes: 1, hintsUsed: 0, strokeCount: 2, gaveUp: false, failedStrokes: 1 });
  });

  it('announces a repeated message again', () => {
    const { svg, container } = setup('memory');
    const live = () => container.querySelector('[aria-live] > *');
    draw(svg, reversed(HITO[0]));
    draw(svg, reversed(HITO[0]));
    const before = live();
    draw(svg, reversed(HITO[0]));
    // Same words, but a new node, so screen readers speak it again.
    expect(live()?.textContent).toBe(before?.textContent);
    expect(live()).not.toBe(before);
    expect(live()?.textContent).toMatch(/^Stroke 1: .*Showing stroke 1\.$/);
  });

  it('discards a cancelled stroke', () => {
    const { svg, onStrokeResult } = setup();
    const pts = strokePoints(HITO[0]);
    fireEvent.pointerDown(svg, { pointerId: 1, pointerType: 'touch', clientX: pts[0].x * SCALE, clientY: pts[0].y * SCALE });
    fireEvent.pointerMove(svg, { pointerId: 1, pointerType: 'touch', clientX: pts[10].x * SCALE, clientY: pts[10].y * SCALE });
    fireEvent.pointerCancel(svg, { pointerId: 1, pointerType: 'touch' });
    expect(onStrokeResult).not.toHaveBeenCalled();
  });

  it('shows the faint character only in trace mode, and the start marker except in memory mode', () => {
    const trace = setup('trace');
    expect(trace.container.querySelectorAll('.wp-ghost path')).toHaveLength(2);
    expect(trace.container.querySelector('.wp-start')).not.toBeNull();
    cleanup();

    const guided = setup('guided');
    expect(guided.container.querySelector('.wp-ghost')).toBeNull();
    const dot = guided.container.querySelector('.wp-start');
    expect(Number(dot?.getAttribute('cx'))).toBeCloseTo(54.5, 1);
    expect(Number(dot?.getAttribute('cy'))).toBeCloseTo(20, 1);
    cleanup();

    const memory = setup('memory');
    expect(memory.container.querySelector('.wp-ghost')).toBeNull();
    expect(memory.container.querySelector('.wp-start')).toBeNull();
  });

  it('drives undo, hint, clear and give up through its handle', () => {
    const { ref, svg, onComplete, container } = setup('memory');
    draw(svg, strokePoints(HITO[0]));
    act(() => ref.current!.undo());
    expect(container.querySelectorAll('.wp-ink path')).toHaveLength(0);

    act(() => ref.current!.hint());
    expect(container.querySelector('.wp-hint')?.getAttribute('d')).toBe(HITO[0]);
    expect(svg.getAttribute('aria-label')).toMatch(/stroke 1 hint shown$/);
    act(() => ref.current!.hint()); // same stroke: still one hint

    draw(svg, strokePoints(HITO[0]));
    act(() => ref.current!.clear());
    expect(container.querySelectorAll('.wp-ink path')).toHaveLength(0);

    draw(svg, strokePoints(HITO[0]));
    act(() => ref.current!.giveUp());
    expect(container.querySelectorAll('.wp-reveal')).toHaveLength(1);
    expect(onComplete).toHaveBeenCalledWith({ mistakes: 0, hintsUsed: 1, strokeCount: 2, gaveUp: true, failedStrokes: 1 });

    // After finishing, clear starts a fresh attempt.
    act(() => ref.current!.clear());
    expect(container.querySelector('.wp-reveal')).toBeNull();
    draw(svg, strokePoints(HITO[0]));
    draw(svg, strokePoints(HITO[1]));
    expect(onComplete).toHaveBeenLastCalledWith({ mistakes: 0, hintsUsed: 0, strokeCount: 2, gaveUp: false, failedStrokes: 0 });
  });

  it('starts over when given a different character', () => {
    const ref = createRef<WritingPadHandle>();
    const view = render(<WritingPad ref={ref} strokes={HITO} mode="trace" />);
    draw(view.getByRole('img'), strokePoints(HITO[0]));
    expect(view.container.querySelectorAll('.wp-ink path')).toHaveLength(1);
    view.rerender(<WritingPad ref={ref} strokes={STROKE_FIXTURES['八']} mode="trace" />);
    expect(view.container.querySelectorAll('.wp-ink path')).toHaveLength(0);
  });

  it('writes a whole kanji with finger-like strokes', () => {
    const ki = STROKE_FIXTURES['木'];
    const { svg, onComplete } = setup('guided', ki);
    for (const d of ki) {
      // Coarse, slightly offset input, like a quick finger.
      draw(svg, samplePath(d, 9).map((p) => ({ x: p.x + 2, y: p.y - 1.5 })));
    }
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ mistakes: 0, strokeCount: 4, gaveUp: false }));
  });
});
