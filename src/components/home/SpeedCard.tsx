// Learn: reading speed from timed re-reads of easy stories (characters per minute).
export function SpeedCard({ latest, best }: { latest: number | null; best: number | null }) {
  if (latest === null) return null;
  return (
    <section className="card hm-stat-card" aria-labelledby="speed-title">
      <h2 id="speed-title" className="hm-section-title">Reading speed</h2>
      <p className="hm-stat-big">{latest.toLocaleString()} characters a minute</p>
      <p className="hm-hint">
        On your latest timed re-read{best !== null && best > latest ? `. Your best: ${best.toLocaleString()}.` : '.'}
      </p>
    </section>
  );
}
