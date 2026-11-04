import { loadFont } from '@remotion/google-fonts/BIZUDGothic';
import narration from '../public/narration.json';

// BIZ UDゴシック（SIL OFL）。アプリ本体と同じ書体
export const { fontFamily } = loadFont('normal', { weights: ['400', '700'] });

export const FPS = 30;
/** ナレーションを映像の何秒後から始めるか */
export const AUDIO_DELAY = 0.5;
export const lines = narration.lines;
/** ナレーションの n 行目が始まる時刻（映像の秒） */
export const at = (n: number) => lines[n]!.start + AUDIO_DELAY;
export const endAt = (n: number) => lines[n]!.end + AUDIO_DELAY;
export const TOTAL_SECONDS = Math.ceil(endAt(lines.length - 1) + 2.6);

export const c = {
  bg: '#070d18',
  bg2: '#0d1728',
  grid: 'rgba(120, 170, 255, 0.07)',
  line: 'rgba(150, 190, 255, 0.35)',
  text: '#eef3fb',
  sub: '#9fb0c8',
  accent: '#58c4ff',
  accentSoft: 'rgba(88, 196, 255, 0.18)',
  warn: '#ffb547',
  // トリアージ区分の色（アプリの病院設定の標準の値と同じ）。差し色としてだけ使う
  red: '#e0263f',
  yellow: '#ffd23f',
  green: '#3fa34d',
};
