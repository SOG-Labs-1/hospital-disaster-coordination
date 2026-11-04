import { Composition } from 'remotion';
import { Intro } from './Intro';
import { FPS, TOTAL_SECONDS } from './theme';

export const Root = () => (
  <Composition id="Intro30" component={Intro} durationInFrames={TOTAL_SECONDS * FPS} fps={FPS} width={1920} height={1080} />
);
