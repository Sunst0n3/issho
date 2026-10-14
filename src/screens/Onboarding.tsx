import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Switch } from '../components/home/controls.tsx';
import { minutesForPace } from '../components/home/labels.ts';
import { ConnectServerForm } from '../components/together/ConnectServerForm.tsx';
import { Icon, ProgressBar, Screen, type IconName } from '../components/ui.tsx';
import { requestPersistentStorage } from '../lib/backup.ts';
import { getSettings, updateSettings } from '../lib/db.ts';
import { applyKnownKana } from '../srs/course.ts';
import '../components/home/home.css';

type Step = 'welcome' | 'name' | 'kana' | 'pace' | 'connect';
const STEPS: Step[] = ['welcome', 'name', 'kana', 'pace', 'connect'];

const PACES = [
  { value: 3, title: 'Gentle', detail: 'Slow and steady, easy to keep up' },
  { value: 5, title: 'Steady', detail: 'A good balance for most people' },
  { value: 8, title: 'Keen', detail: 'Faster, with more reviews to match' },
];

const METHOD: Array<{ icon: IconName; title: string; text: string }> = [
  { icon: 'eye', title: 'Test yourself', text: 'Every card asks first and shows the answer after. Recalling is what makes it stick.' },
  { icon: 'pen', title: 'Write by hand', text: 'Draw each kana and kanji. Your phone checks every stroke.' },
  { icon: 'people', title: 'Use it together', text: 'Text each other in Japanese, act out role-plays, quiz each other.' },
];

function StepFrame({ hero, title, lead, children, footer }: {
  hero?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Move focus to each new step's heading so screen readers announce it.
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <>
      <div className="onboard-body">
        {hero}
        <h1 ref={heading} tabIndex={-1} className="onboard-title">{title}</h1>
        {lead && <p className="onboard-lead">{lead}</p>}
        {children}
      </div>
      {footer && <div className="onboard-foot">{footer}</div>}
    </>
  );
}

export default function Onboarding() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('welcome');
  const [name, setName] = useState('');
  const [knowsHiragana, setKnowsHiragana] = useState(false);
  const [knowsKatakana, setKnowsKatakana] = useState(false);
  const [newPerDay, setNewPerDay] = useState(5);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string>();
  const finished = useRef(false);
  const edited = useRef(false);

  // Coming back to onboarding starts from what's saved, unless they've already started answering.
  useEffect(() => {
    let live = true;
    void getSettings().then((s) => {
      if (!live || edited.current) return;
      setName(s.name);
      setKnowsHiragana(s.knowsHiragana);
      setKnowsKatakana(s.knowsKatakana);
      setNewPerDay(s.newPerDay);
    });
    return () => { live = false; };
  }, []);

  const index = STEPS.indexOf(step);
  const go = (to: Step) => { edited.current = true; setError(undefined); setStep(to); };
  const back = () => go(STEPS[Math.max(0, index - 1)]);

  const choices = () => ({
    name: name.trim(),
    knowsHiragana,
    knowsKatakana,
    newPerDay,
    // Romaji helps while kana are new; someone who reads both scripts can turn it back on.
    romaji: !(knowsHiragana && knowsKatakana),
  });

  // Saved before the connect step so the pairing form can use the name.
  const saveChoices = async (next: Step) => {
    try {
      await updateSettings(choices());
      go(next);
    } catch {
      setError("Couldn't save that on this phone. Try again.");
    }
  };

  const finish = async () => {
    if (finished.current) return;
    finished.current = true;
    setFinishing(true);
    setError(undefined);
    try {
      await updateSettings(choices());
      if (knowsHiragana || knowsKatakana) await applyKnownKana();
      await updateSettings({ onboarded: true });
      void requestPersistentStorage();
      navigate('/', { replace: true });
    } catch {
      finished.current = false;
      setFinishing(false);
      setError("Couldn't finish setting up. Check that the app has finished downloading, then try again.");
    }
  };

  const submitName = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) void saveChoices('kana');
  };

  let body: ReactNode;
  switch (step) {
    case 'welcome':
      body = (
        <StepFrame
          hero={<span className="welcome-seal" lang="ja" aria-hidden="true">一緒</span>}
          title="Japanese, together"
          lead={<>Issho (<span lang="ja">一緒</span>) means “together”. A few minutes a day, side by side. Here's how it works:</>}
          footer={<button type="button" className="btn primary block" onClick={() => go('name')}>Get started</button>}
        >
          <ul className="welcome-method">
            {METHOD.map((m) => (
              <li key={m.title}>
                <span className="welcome-method-icon" aria-hidden="true"><Icon name={m.icon} size={20} /></span>
                <div><strong>{m.title}</strong><p>{m.text}</p></div>
              </li>
            ))}
          </ul>
        </StepFrame>
      );
      break;

    case 'name':
      body = (
        <form className="onboard-form" onSubmit={submitName}>
          <StepFrame
            title="What should we call you?"
            footer={<button type="submit" className="btn primary block" disabled={!name.trim()}>Continue</button>}
          >
            <div className="hm-field">
              <label className="hm-field-label" htmlFor="onboard-name">Your name</label>
              <input id="onboard-name" className="text-input" value={name} maxLength={40} autoComplete="given-name"
                onChange={(e) => setName(e.target.value)} aria-describedby="onboard-name-hint" />
              <span id="onboard-name-hint" className="hm-hint">Your partner sees this when you study together.</span>
            </div>
          </StepFrame>
        </form>
      );
      break;

    case 'kana':
      body = (
        <StepFrame
          title="Already know some kana?"
          lead="Hiragana and katakana are the two Japanese alphabets. Issho starts with them, unless you know them already."
          footer={<button type="button" className="btn primary block" onClick={() => void saveChoices('pace')}>Continue</button>}
        >
          <div className="card onboard-switches">
            <Switch label={<>I know hiragana <span className="hm-kana-sample" lang="ja">あいう</span></>}
              checked={knowsHiragana} onChange={setKnowsHiragana} />
            <Switch label={<>I know katakana <span className="hm-kana-sample" lang="ja">アイウ</span></>}
              checked={knowsKatakana} onChange={setKnowsKatakana} />
          </div>
          <p className="hm-hint">Not sure? Leave them off. Kana go quickly, and you can change this in Settings.</p>
        </StepFrame>
      );
      break;

    case 'pace':
      body = (
        <StepFrame
          title="How much each day?"
          lead="New things to learn each day. Reviews of what you already know come on top."
          footer={<button type="button" className="btn primary block" onClick={() => void saveChoices('connect')}>Continue</button>}
        >
          <fieldset className="hm-options">
            <legend className="visually-hidden">New items each day</legend>
            {PACES.map((p) => (
              <label key={p.value} className={p.value === newPerDay ? 'hm-option selected' : 'hm-option'}>
                <input type="radio" name="pace" value={p.value} checked={p.value === newPerDay}
                  onChange={() => setNewPerDay(p.value)} />
                <span className="hm-option-main">
                  <span className="hm-option-title">{p.value} new a day · {p.title}</span>
                  <span className="hm-option-detail">About {minutesForPace(p.value)} min a day. {p.detail}.</span>
                </span>
                {p.value === 5 && <span className="chip ai">Suggested</span>}
              </label>
            ))}
          </fieldset>
          <p className="hm-hint">You can change this any time in Settings.</p>
        </StepFrame>
      );
      break;

    case 'connect':
      body = (
        <StepFrame
          title="Study together"
          lead="A small server at home lets you two see each other's progress, chat in Japanese and quiz each other. Everything else works without it."
        >
          {finishing
            ? <p className="muted" role="status">Getting things ready…</p>
            : <ConnectServerForm onConnected={() => void finish()} onSkip={() => void finish()} />}
        </StepFrame>
      );
      break;
  }

  return (
    <Screen label="Welcome to Issho">
      <div className="onboard-top">
        {index > 0
          ? <button type="button" className="icon-btn" aria-label="Back" onClick={back} disabled={finishing}><Icon name="back" size={22} /></button>
          : <span className="onboard-spacer" aria-hidden="true" />}
        <ProgressBar value={(index + 1) / STEPS.length} label="Setup progress" />
        <span className="onboard-step">Step {index + 1} of {STEPS.length}</span>
      </div>
      {error && <p className="hm-error" role="alert">{error}</p>}
      <div key={step} className="onboard-step-body">{body}</div>
    </Screen>
  );
}
