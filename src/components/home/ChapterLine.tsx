// Today's footer line: the current chapter (15 kanji each; chapter 0 is kana), linking to Learn.
import { Link } from 'react-router-dom';
import type { CourseProgressV2 } from '../../srs/course.ts';
import { chapterInfo } from '../../srs/milestones.ts';
import { Icon } from '../ui.tsx';

export function ChapterLine({ progress }: { progress: Pick<CourseProgressV2, 'kanjiIntroduced' | 'kanaIntroduced' | 'kanaTotal'> }) {
  const info = chapterInfo(progress.kanjiIntroduced, progress.kanaIntroduced, progress.kanaTotal);
  const pct = `${Math.round((info.size ? Math.min(1, info.done / info.size) : 0) * 100)}%`;
  return (
    <Link to="/learn" className="today-chapter">
      <span className="today-chapter-text">{info.text}</span>
      <span className="today-chapter-bar" aria-hidden="true"><span style={{ width: pct }} /></span>
      <Icon name="forward" size={16} />
    </Link>
  );
}
