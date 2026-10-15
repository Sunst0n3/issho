import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { SecureNotice } from '../components/home/SecureNotice.tsx';
import { AboutSection, DataSection } from '../components/home/SettingsData.tsx';
import { HabitsSection } from '../components/home/SettingsHabits.tsx';
import { AppearanceSection, StudySection, YouSection } from '../components/home/SettingsStudy.tsx';
import { TogetherSection } from '../components/home/SettingsTogether.tsx';
import { Screen, TopBar } from '../components/ui.tsx';
import { getSettings } from '../lib/db.ts';
import '../components/home/home.css';
import '../components/home/settings.css';

export default function Settings() {
  const settings = useLiveQuery(() => getSettings(), []);
  const { hash } = useLocation();
  const loaded = settings !== undefined;

  // Today's plan review links to a section (/settings#set-habits): bring it into view once it's there.
  useEffect(() => {
    if (!loaded || !hash) return;
    const target = document.getElementById(hash.slice(1));
    target?.scrollIntoView?.({ block: 'start' });
  }, [loaded, hash]);

  return (
    <Screen label="Settings">
      <TopBar back="/" title="Settings" />
      <SecureNotice />
      {settings ? (
        <>
          <YouSection settings={settings} />
          <StudySection settings={settings} />
          <HabitsSection settings={settings} />
          <TogetherSection settings={settings} />
          <DataSection />
          <AppearanceSection />
          <AboutSection />
        </>
      ) : (
        <div className="hm-skeleton-stack" aria-busy="true" aria-label="Loading settings">
          <div className="hm-skeleton card-sized" />
          <div className="hm-skeleton card-sized" />
        </div>
      )}
    </Screen>
  );
}
