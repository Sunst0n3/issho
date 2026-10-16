import { useLiveQuery } from 'dexie-react-hooks';
import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ErrorInfo,
  type LazyExoticComponent,
  type ReactNode,
} from 'react';
import { Link, matchPath, Navigate, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { Icon, reloadPage, Screen, TabBar } from './components/ui.tsx';
import { getSettings } from './lib/db.ts';

// ---- Lazy screens that can be retried ----
// React.lazy remembers a failed import for good. Each screen here makes a fresh
// lazy component after a failure, so "Try again" in the error screen can ask for
// it again. (A browser also remembers a failed download of the same module, so
// for those "Try again" reloads the page instead: see reloadWhenReachable.)
const failedLoads = new Set<() => void>();

function lazyScreen(load: () => Promise<{ default: ComponentType }>): ComponentType {
  let Lazy: LazyExoticComponent<ComponentType>;
  const make = () => {
    Lazy = lazy(() => load().catch((e: unknown) => {
      failedLoads.add(make);
      throw e;
    }));
  };
  make();
  return function LazyScreen() {
    return <Lazy />;
  };
}

/** Lets screens whose code failed to load try again on their next render. */
function retryFailedScreens() {
  const pending = [...failedLoads];
  failedLoads.clear();
  for (const remake of pending) remake();
}

const Today = lazyScreen(() => import('./screens/Today.tsx'));
const Onboarding = lazyScreen(() => import('./screens/Onboarding.tsx'));
const Settings = lazyScreen(() => import('./screens/Settings.tsx'));
const LearnHub = lazyScreen(() => import('./screens/LearnHub.tsx'));
const Library = lazyScreen(() => import('./screens/Library.tsx'));
const KanjiDetail = lazyScreen(() => import('./screens/KanjiDetail.tsx'));
const KanaChart = lazyScreen(() => import('./screens/KanaChart.tsx'));
const Session = lazyScreen(() => import('./screens/Session.tsx'));
const WritePractice = lazyScreen(() => import('./screens/WritePractice.tsx'));
const GrammarList = lazyScreen(() => import('./screens/GrammarList.tsx'));
const GrammarDetail = lazyScreen(() => import('./screens/GrammarDetail.tsx'));
const Reading = lazyScreen(() => import('./screens/Reading.tsx'));
const CanDoCheck = lazyScreen(() => import('./screens/CanDoCheck.tsx'));
const Together = lazyScreen(() => import('./screens/Together.tsx'));
const TogetherSession = lazyScreen(() => import('./screens/TogetherSession.tsx'));
const Chat = lazyScreen(() => import('./screens/Chat.tsx'));
const RolePlayList = lazyScreen(() => import('./screens/RolePlayList.tsx'));
const RolePlayRun = lazyScreen(() => import('./screens/RolePlayRun.tsx'));
const QuizRun = lazyScreen(() => import('./screens/QuizRun.tsx'));

/** Screens that show the bottom tab bar. Full-screen flows (session, chat, …) hide it. */
const TAB_PATHS = new Set(['/', '/learn', '/library', '/library/kanji', '/library/words', '/library/stories', '/together']);

const APP_NAME = 'Issho';

/** Every route with the name used for the page title and the navigation announcement. */
const ROUTES: Array<{ path: string; title: string; element: ReactNode }> = [
  { path: '/', title: 'Today', element: <Today /> },
  { path: '/welcome', title: 'Welcome', element: <Onboarding /> },
  { path: '/settings', title: 'Settings', element: <Settings /> },
  { path: '/learn', title: 'Learn', element: <LearnHub /> },
  { path: '/library', title: 'Library', element: <Library /> },
  { path: '/library/:tab', title: 'Library', element: <Library /> },
  // The v1 kanji library's address: kept for bookmarks.
  { path: '/kanji', title: 'Library', element: <Navigate to="/library/kanji" replace /> },
  { path: '/kanji/:char', title: 'Kanji', element: <KanjiDetail /> },
  { path: '/kana', title: 'Kana chart', element: <KanaChart /> },
  { path: '/session', title: 'Study session', element: <Session /> },
  { path: '/write/:char', title: 'Write', element: <WritePractice /> },
  { path: '/grammar', title: 'Grammar', element: <GrammarList /> },
  { path: '/grammar/:id', title: 'Grammar point', element: <GrammarDetail /> },
  { path: '/read', title: 'Read', element: <Reading /> },
  { path: '/read/:storyId', title: 'Story', element: <Reading /> },
  { path: '/cando/:id', title: 'Can-do check', element: <CanDoCheck /> },
  { path: '/together', title: 'Together', element: <Together /> },
  { path: '/together/session/:id', title: 'Together session', element: <TogetherSession /> },
  { path: '/chat', title: 'Chat', element: <Chat /> },
  { path: '/roleplay', title: 'Role-plays', element: <RolePlayList /> },
  { path: '/roleplay/:id', title: 'Role-play', element: <RolePlayRun /> },
  { path: '/quiz/:id', title: 'Quiz', element: <QuizRun /> },
];

const NOT_FOUND_TITLE = 'Page not found';

/** A path segment as text: the browser's pathname is percent-encoded ("%E6%B0%B4" for 水). */
function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Routes whose title names the character in the path: "Kanji 水", "Write あ". */
const CHAR_TITLES: Record<string, string> = { '/kanji/:char': 'Kanji', '/write/:char': 'Write' };

/** The screen name for a path: "Kanji 水" for /kanji/水, "Page not found" for unknown paths. */
function routeTitle(pathname: string): string {
  for (const route of ROUTES) {
    const match = matchPath(route.path, pathname);
    if (!match) continue;
    const prefix = CHAR_TITLES[route.path];
    return prefix && match.params.char ? `${prefix} ${decodeSegment(match.params.char)}` : route.title;
  }
  return NOT_FOUND_TITLE;
}

function isKnownPath(pathname: string): boolean {
  return ROUTES.some((route) => matchPath(route.path, pathname));
}

/**
 * Opens each new page at the top instead of where the last one was scrolled to.
 * Back and forward are left to the browser's scroll restoration. Rendered before
 * the routes so a screen's own layout effects (the chat scrolling to its newest
 * message) run after this one.
 */
function ScrollReset({ pathname }: { pathname: string }) {
  const navigationType = useNavigationType();
  useLayoutEffect(() => {
    if (navigationType !== 'POP') document.documentElement.scrollTop = 0;
  }, [pathname, navigationType]);
  return null;
}

/**
 * Names each page in the document title, and tells screen readers about a
 * change of screen (focus stays put, so nothing else would). The first page of
 * a visit is announced by the browser itself.
 */
function RouteAnnouncer({ pathname }: { pathname: string }) {
  const title = routeTitle(pathname);
  const [message, setMessage] = useState('');
  const announced = useRef<string>();

  useEffect(() => {
    document.title = title === 'Today' ? APP_NAME : `${title} · ${APP_NAME}`;
    const first = announced.current === undefined;
    if (announced.current === pathname) return;
    announced.current = pathname;
    if (first) return;
    // Cleared first, so the same title twice in a row is still read out.
    setMessage('');
    const timer = setTimeout(() => setMessage(title), 60);
    return () => clearTimeout(timer);
  }, [pathname, title]);

  return <p className="visually-hidden" role="status" aria-atomic="true">{message}</p>;
}

/**
 * Before onboarding only /welcome opens. Onboarding owns the return home,
 * including visits after setup; keeping one navigation owner avoids competing POP/replace transitions.
 */
function OnboardingGate({ pathname, children }: { pathname: string; children: ReactNode }) {
  const onboarded = useLiveQuery(async () => (await getSettings()).onboarded, []);
  if (onboarded === undefined) return <div className="screen" aria-busy="true" />;
  // Unknown paths show "Page not found" either way.
  if (!isKnownPath(pathname)) return children;
  if (!onboarded && pathname !== '/welcome') return <Navigate to="/welcome" replace />;
  return children;
}

function NotFound() {
  return (
    <Screen tabs label={NOT_FOUND_TITLE}>
      <section className="app-message">
        <p className="app-message-mark" lang="ja" aria-hidden="true">迷</p>
        <h1 className="app-message-title">This page doesn't exist</h1>
        <p className="muted">The link may be old or mistyped. Everything you've learned is still here.</p>
        <Link to="/" replace className="btn primary">
          Go to Today <Icon name="arrow" size={20} />
        </Link>
      </section>
    </Screen>
  );
}

function isChunkLoadError(error: Error): boolean {
  return /dynamically imported module|module script failed|Loading chunk|ChunkLoadError|Failed to fetch/i.test(
    `${error.name} ${error.message}`,
  );
}

/**
 * A browser keeps a failed module download for the life of the page, so a
 * screen whose code failed to load can only load in a fresh page. This reloads
 * only when the app can be reached: otherwise the browser's own "can't be
 * reached" page would replace the friendly one. Resolves false when it can't.
 */
async function reloadWhenReachable(): Promise<boolean> {
  try {
    const response = await fetch(window.location.href, { cache: 'no-store' });
    if (!response.ok) return false;
  } catch {
    return false;
  }
  reloadPage();
  return true;
}

function ScreenError({ error, tabs, stillOffline, onRetry }: {
  error: Error;
  tabs: boolean;
  stillOffline: boolean;
  onRetry: () => void;
}) {
  const offlineLoad = isChunkLoadError(error);
  return (
    <Screen tabs={tabs} label="Something went wrong">
      <section className="app-message" role="alert">
        <h1 className="app-message-title">
          {offlineLoad ? "Couldn't load this screen" : 'Something went wrong on this screen'}
        </h1>
        <p className="muted">
          {offlineLoad
            ? 'Check your connection and try again. Your progress is safe on this phone.'
            : 'Your progress is safe on this phone. Try again, or reload the app if it keeps happening.'}
        </p>
        {stillOffline && <p>Still can't reach the app. Try again once you're back online.</p>}
        <div className="app-message-actions">
          <button type="button" className="btn primary" onClick={onRetry}>Try again</button>
          <button type="button" className="btn secondary" onClick={reloadPage}>Reload the app</button>
          <Link to="/" className="btn secondary">Go to Today</Link>
        </div>
      </section>
    </Screen>
  );
}

interface BoundaryState {
  error: Error | null;
  /** "Try again" found the app still unreachable. */
  stillOffline: boolean;
}

/**
 * Keeps a screen that fails (most often its code chunk failing to download)
 * from blanking the whole app: the error screen offers a retry and a reload,
 * and moving to another page clears it.
 */
class RouteErrorBoundary extends Component<{ pathname: string; children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null, stillOffline: false };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)), stillOffline: false };
  }

  componentDidUpdate(prev: { pathname: string }) {
    if (this.state.error && prev.pathname !== this.props.pathname) this.setState({ error: null, stillOffline: false });
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Screen failed', error, info.componentStack);
  }

  retry = () => {
    const { error } = this.state;
    if (error && isChunkLoadError(error)) {
      // Rendering again would only get the same failed download back.
      const pathname = this.props.pathname;
      void reloadWhenReachable().then((reloading) => {
        if (!reloading && this.props.pathname === pathname) this.setState({ stillOffline: true });
      });
      return;
    }
    retryFailedScreens();
    this.setState({ error: null, stillOffline: false });
  };

  render() {
    const { error, stillOffline } = this.state;
    return error
      ? <ScreenError error={error} tabs={TAB_PATHS.has(this.props.pathname)} stillOffline={stillOffline} onRetry={this.retry} />
      : this.props.children;
  }
}

export default function App() {
  const { pathname } = useLocation();
  const known = isKnownPath(pathname);
  return (
    <>
      <ScrollReset pathname={pathname} />
      <RouteAnnouncer pathname={pathname} />
      <RouteErrorBoundary pathname={pathname}>
        <Suspense fallback={<div className="screen" aria-busy="true" />}>
          <OnboardingGate pathname={pathname}>
            <Routes>
              {ROUTES.map((route) => <Route key={route.path} path={route.path} element={route.element} />)}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </OnboardingGate>
        </Suspense>
      </RouteErrorBoundary>
      {(TAB_PATHS.has(pathname) || !known) && <TabBar />}
    </>
  );
}
