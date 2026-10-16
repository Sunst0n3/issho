import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App.tsx';
import { db, getSettings } from './lib/db.ts';

vi.mock('./screens/Today.tsx', () => ({ default: () => <h1>Ready to study</h1> }));

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  window.history.replaceState(null, '', '/welcome');
});
afterEach(cleanup);

it('finishes the short setup in the real app and browser router, and survives Back and remount', async () => {
  const mount = () => render(<BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><App /></BrowserRouter>);
  const view = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Get started' }));
  fireEvent.change(await screen.findByLabelText('Your name'), { target: { value: 'Audit learner' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('heading', { name: 'How long each day?' });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Start learning' }));
  await screen.findByRole('heading', { name: 'Ready to study' });
  expect((await getSettings()).onboarded).toBe(true);
  expect(window.location.pathname).toBe('/');
  window.history.back();
  await waitFor(() => expect(window.location.pathname).toBe('/'));
  view.unmount();
  window.history.replaceState(null, '', '/welcome');
  mount();
  await screen.findByRole('heading', { name: 'Ready to study' });
  expect(window.location.pathname).toBe('/');
});
