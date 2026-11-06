import { loadFont } from '@remotion/google-fonts/BIZUDGothic';
import { createContext, useContext } from 'react';

// BIZ UDゴシック（SIL OFL）。アプリ本体と同じ書体
export const { fontFamily } = loadFont('normal', { weights: ['400', '700'] });

// 製品名（病院リンクBCP）のロゴの書体：BIZ UDPゴシック 太字に固定（利用者が候補10種から選んだ。2026-11-06）
import { loadFont as loadLogoFont } from '@remotion/google-fonts/BIZUDPGothic';
export const { fontFamily: logoFont } = loadLogoFont('normal', { weights: ['700'] });
/** ロゴ：名前と英名。size は名前の文字の大きさ */
export const LOGO = { ja: '病院リンクBCP', en: 'Hospital Link BCP' } as const;

export const FPS = 30;
/** ナレーションを映像の何秒後から始めるか */
export const AUDIO_DELAY = 0.5;

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

/** 場面が使うナレーションの時刻（映像の秒）。3分版が TimingContext で場面ごとに渡す（場面の行番号を3分版の行に読み替える） */
export interface Timing {
  at: (n: number) => number;
  endAt: (n: number) => number;
}
export const TimingContext = createContext<Timing>({ at: () => 0, endAt: () => 0 });
export const useTiming = () => useContext(TimingContext);
