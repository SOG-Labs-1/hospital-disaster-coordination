import { Audio } from '@remotion/media';
import { AbsoluteFill, Sequence, staticFile, useVideoConfig } from 'remotion';
import { Background, Hud, SceneFade, Subtitles } from './common';
import { Closing } from './scenes/Closing';
import { Disasters } from './scenes/Disasters';
import { FloorPlan } from './scenes/FloorPlan';
import { Schedule } from './scenes/Schedule';
import { TwoFunctions } from './scenes/TwoFunctions';
import { at, AUDIO_DELAY, fontFamily, TOTAL_SECONDS } from './theme';

// 場面の切れ目は、ナレーションの行の始まりから決める（秒）
const cuts = [0, at(2) - 0.35, at(4) - 0.35, at(5) - 0.35, at(7) - 0.35, TOTAL_SECONDS];
const scenes = [Disasters, FloorPlan, Schedule, TwoFunctions, Closing];

export const Intro = () => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ fontFamily }}>
      <Background />
      {scenes.map((Scene, i) => {
        const from = Math.round(cuts[i]! * fps);
        const durationInFrames = Math.round(cuts[i + 1]! * fps) - from;
        return (
          <Sequence key={i} from={from} durationInFrames={durationInFrames} name={Scene.name}>
            <SceneFade durationInFrames={durationInFrames} fadeIn={i === 0 ? 1 : 10} fadeOut={i === scenes.length - 1 ? 20 : 10}>
              <Scene start={cuts[i]!} />
            </SceneFade>
          </Sequence>
        );
      })}
      <Hud />
      <Subtitles />
      <Sequence from={Math.round(AUDIO_DELAY * fps)} name="ナレーション">
        <Audio src={staticFile('narration.wav')} />
      </Sequence>
    </AbsoluteFill>
  );
};
