import { lazy, Suspense } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { TabBar } from './components/ui.tsx';

const Today = lazy(() => import('./screens/Today.tsx'));
const Onboarding = lazy(() => import('./screens/Onboarding.tsx'));
const Settings = lazy(() => import('./screens/Settings.tsx'));
const LearnHub = lazy(() => import('./screens/LearnHub.tsx'));
const Library = lazy(() => import('./screens/Library.tsx'));
const KanjiDetail = lazy(() => import('./screens/KanjiDetail.tsx'));
const KanaChart = lazy(() => import('./screens/KanaChart.tsx'));
const Session = lazy(() => import('./screens/Session.tsx'));
const WritePractice = lazy(() => import('./screens/WritePractice.tsx'));
const GrammarList = lazy(() => import('./screens/GrammarList.tsx'));
const GrammarDetail = lazy(() => import('./screens/GrammarDetail.tsx'));
const Reading = lazy(() => import('./screens/Reading.tsx'));
const Together = lazy(() => import('./screens/Together.tsx'));
const Chat = lazy(() => import('./screens/Chat.tsx'));
const RolePlayList = lazy(() => import('./screens/RolePlayList.tsx'));
const RolePlayRun = lazy(() => import('./screens/RolePlayRun.tsx'));
const QuizRun = lazy(() => import('./screens/QuizRun.tsx'));

/** Screens that show the bottom tab bar. Full-screen flows (session, chat, …) hide it. */
const TAB_PATHS = new Set(['/', '/learn', '/write', '/together']);

export default function App() {
  const { pathname } = useLocation();
  return (
    <>
      <Suspense fallback={<div className="screen" aria-busy="true" />}>
        <Routes>
          <Route path="/" element={<Today />} />
          <Route path="/welcome" element={<Onboarding />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/learn" element={<LearnHub />} />
          <Route path="/kanji" element={<Library />} />
          <Route path="/kanji/:char" element={<KanjiDetail />} />
          <Route path="/kana" element={<KanaChart />} />
          <Route path="/session" element={<Session />} />
          <Route path="/write" element={<WritePractice />} />
          <Route path="/grammar" element={<GrammarList />} />
          <Route path="/grammar/:id" element={<GrammarDetail />} />
          <Route path="/read" element={<Reading />} />
          <Route path="/together" element={<Together />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/roleplay" element={<RolePlayList />} />
          <Route path="/roleplay/:id" element={<RolePlayRun />} />
          <Route path="/quiz/:id" element={<QuizRun />} />
          <Route path="*" element={<Today />} />
        </Routes>
      </Suspense>
      {TAB_PATHS.has(pathname) && <TabBar />}
    </>
  );
}
