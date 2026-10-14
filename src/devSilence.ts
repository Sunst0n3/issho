// Development only: keeps test runs silent. Speech and audio playback still run their
// code paths (events fire, promises resolve) but make no sound. Opt back in with
// localStorage 'issho.dev-sound' = '1'. Never imported into production builds.

export function silenceInDev(): void {
  try {
    if (localStorage.getItem('issho.dev-sound') === '1') return;
  } catch {
    // Storage blocked: stay silent.
  }

  if ('speechSynthesis' in window) {
    const synth = window.speechSynthesis;
    synth.cancel();
    synth.speak = (utterance: SpeechSynthesisUtterance) => {
      setTimeout(() => {
        utterance.dispatchEvent(new Event('start'));
        utterance.dispatchEvent(new Event('end'));
      }, 50);
    };
  }

  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    this.muted = true;
    return play.call(this);
  };
}
