// Icons only the together screens need, drawn like ui.tsx's Icon (24×24 stroke paths).

const PATHS = {
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  pause: 'M9 5v14M15 5v14',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  down: 'M12 5v14M6 13l6 6 6-6',
  eyeOff: 'M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.8 9.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6',
  translate: 'M4 5h8M8 3v2M10.5 5c-.8 3.6-3 6.4-6.5 8M6 9c1 1.8 2.6 3.2 4.6 4M13 21l4-10 4 10M14.5 17.5h5',
  wifi: 'M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 19.5h.01',
} as const;

export type TogetherIconName = keyof typeof PATHS;

export function TIcon({ name, size = 20, strokeWidth = 2 }: { name: TogetherIconName; size?: number; strokeWidth?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}
