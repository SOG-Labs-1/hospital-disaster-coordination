import { Composition } from 'remotion';
import { Intro } from './Intro';
import { Intro3min, TOTAL3 } from './Intro3min';
import { FPS, TOTAL_SECONDS } from './theme';

export const Root = () => (
  <>
    <Composition id="Intro30" component={Intro} durationInFrames={TOTAL_SECONDS * FPS} fps={FPS} width={1920} height={1080} />
    {/* 3分版（ハッカソンの紹介映像）。長さはナレーションから決まる */}
    <Composition id="Intro3min" component={Intro3min} durationInFrames={Math.round(TOTAL3 * FPS)} fps={FPS} width={1920} height={1080} defaultProps={{ stock: false }} />
    {/* 3分版の実写あり（冒頭だけ Pexels の素材。docs/video/stock-sources.md） */}
    <Composition id="Intro3minStock" component={Intro3min} durationInFrames={Math.round(TOTAL3 * FPS)} fps={FPS} width={1920} height={1080} defaultProps={{ stock: true }} />
  </>
);
