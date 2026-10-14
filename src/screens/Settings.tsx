import { useLiveQuery } from 'dexie-react-hooks';
import { SecureNotice } from '../components/home/SecureNotice.tsx';
import { AboutSection, DataSection } from '../components/home/SettingsData.tsx';
import { AppearanceSection, KanaSection, StudySection, YouSection } from '../components/home/SettingsStudy.tsx';
import { TogetherSection } from '../components/home/SettingsTogether.tsx';
import { Screen, TopBar } from '../components/ui.tsx';
import { getSettings } from '../lib/db.ts';
import '../components/home/home.css';
import '../components/home/settings.css';

export default function Settings() {
  const settings = useLiveQuery(() => getSettings(), []);

  return (
    <Screen label="Settings">
      <TopBar back="/" title="Settings" />
      <SecureNotice />
      {settings ? (
        <>
          <YouSection settings={settings} />
          <StudySection settings={settings} />
          <KanaSection settings={settings} />
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
