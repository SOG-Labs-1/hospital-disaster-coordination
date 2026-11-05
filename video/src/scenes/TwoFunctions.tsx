import type { ReactNode } from 'react';
import { Video } from '@remotion/media';
import { AbsoluteFill, getStaticFiles, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { clamp, ease } from '../common';
import { c, fontFamily, LOGO, logoFont, useTiming } from '../theme';

// 画面の録画（video/public/captures/）があれば使い、なければ画面を模した図で代える
const capture = (name: string) => getStaticFiles().find((f) => f.name === `captures/${name}`);

/** 場面4：病院リンクBCP。災害時の院内調整と、AIと行う、平常時の訓練。 */
export const TwoFunctions = ({ start, heading = '― 2つの機能 ―', liveLabel = '災害運用', trainingLabel = '訓練', note = true }: { start: number; heading?: string; liveLabel?: string; trainingLabel?: string; note?: boolean }) => {
  const { at } = useTiming();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps + start;
  const nameAt = at(5);
  const split = at(6) - 0.35;
  // 名前を大きく出してから、上へ小さく移す
  const up = interpolate(t, [split - 0.3, split + 0.4], [0, 1], { ...clamp, easing: ease });
  const nameIn = interpolate(t, [nameAt - 0.15, nameAt + 0.35], [0, 1], { ...clamp, easing: ease });
  // 録画は別のセッションが作った video/public/captures/（manifest.json に説明あり）
  const live = capture('a-register.webm');
  const training = capture('e-training-radio.webm');

  return (
    <AbsoluteFill style={{ fontFamily }}>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', translate: `0px ${-up * 410}px`, scale: String(1 - up * 0.6) }}>
        <div style={{ opacity: nameIn, fontFamily: logoFont, letterSpacing: interpolate(nameIn, [0, 1], [30, 4]), fontSize: 130, fontWeight: 700, color: c.text, filter: `blur(${(1 - nameIn) * 12}px)` }}>{LOGO.ja}</div>
        <div style={{ opacity: nameIn * (1 - up), marginTop: 10, fontFamily: logoFont, fontWeight: 700, fontSize: 36, color: c.sub, letterSpacing: 3 }}>{LOGO.en}</div>
        <div style={{ opacity: nameIn * (1 - up), marginTop: 18, fontSize: 30, color: c.sub, letterSpacing: 6 }}>院内災害対応の調整ツール</div>
      </AbsoluteFill>

      <AbsoluteFill style={{ flexDirection: 'row', gap: 40, padding: '250px 90px 0px', opacity: up }}>
        <Panel label={liveLabel} sub="災害時の院内調整" from={split} t={t} accent={c.accent}>
          {live ? <Video src={staticFile('captures/a-register.webm')} muted style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'left top' }} /> : <LiveMock t={t - split} />}
        </Panel>
        <Panel label={trainingLabel} sub="AIと行う平常時の訓練" from={split + 0.9} t={t} accent={c.warn} dashed>
          {training ? <Video src={staticFile('captures/e-training-radio.webm')} muted style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'left top' }} /> : <TrainingMock t={t - split - 0.9} />}
        </Panel>
      </AbsoluteFill>

      <AbsoluteFill style={{ top: 186, alignItems: 'center', opacity: interpolate(t, [split + 0.2, split + 0.6], [0, 1], clamp) }}>
        <div style={{ fontSize: 24, color: c.sub, letterSpacing: 10 }}>{heading}</div>
      </AbsoluteFill>
      {note && <AbsoluteFill style={{ top: 812, left: 1030, opacity: interpolate(t, [split + 2.2, split + 2.6], [0, 1], clamp) }}>
        <div style={{ fontSize: 24, color: c.warn, letterSpacing: 2, backgroundColor: 'rgba(7,13,24,0.85)', padding: '6px 14px', border: `2px dashed ${c.warn}`, alignSelf: 'flex-start' }}>※ AIは提案のみ。医療判断はしない</div>
      </AbsoluteFill>}
    </AbsoluteFill>
  );
};

const Panel = ({ label, sub, from, t, accent, dashed, children }: { label: string; sub: string; from: number; t: number; accent: string; dashed?: boolean; children: ReactNode }) => {
  const { at } = useTiming();
  const p = interpolate(t, [from, from + 0.6], [0, 1], { ...clamp, easing: ease });
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, opacity: p, translate: `0px ${(1 - p) * 40}px` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 18 }}>
        <span style={{ fontSize: 40, fontWeight: 700, color: accent, border: `3px ${dashed ? 'dashed' : 'solid'} ${accent}`, padding: '2px 18px' }}>{label}</span>
        <span style={{ fontSize: 30, color: c.text }}>{sub}</span>
      </div>
      <div style={{ aspectRatio: '16 / 9', position: 'relative', border: `2px solid ${c.line}`, backgroundColor: c.bg2, overflow: 'hidden', boxShadow: `0 0 60px ${c.accentSoft}` }}>{children}</div>
    </div>
  );
};

const Row = ({ t, i, children }: { t: number; i: number; children: ReactNode }) => (
  <div style={{ opacity: interpolate(t, [0.3 + i * 0.35, 0.6 + i * 0.35], [0, 1], clamp), translate: `${interpolate(t, [0.3 + i * 0.35, 0.7 + i * 0.35], [-30, 0], { ...clamp, easing: ease })}px 0px`, display: 'flex', alignItems: 'center', gap: 16, padding: '20px 24px', borderBottom: `1px solid ${c.line}`, fontSize: 27, color: c.text }}>
    {children}
  </div>
);

const Chip = ({ color, sym, label, fg = '#fff' }: { color: string; sym: string; label: string; fg?: string }) => (
  <span style={{ backgroundColor: color, color: fg, padding: '2px 12px', fontWeight: 700, fontSize: 22 }}>
    {sym} {label}
  </span>
);

/** 災害運用の画面を模した図（録画ができるまでの代わり。すべて架空） */
const LiveMock = ({ t }: { t: number }) => (
  <div>
    <Row t={t} i={0}>
      <Chip color={c.red} sym="◆" label="赤" /> P-012　タッグ 0042　救急外来
      <span style={{ marginLeft: 'auto', color: c.sub, fontSize: 20 }}>確認 10:42</span>
    </Row>
    <Row t={t} i={1}>
      <Chip color={c.yellow} sym="▲" label="黄" fg="#000" /> P-013　搬送：指示 → 出発 → <b>到着</b>
      <span style={{ marginLeft: 'auto', color: c.sub, fontSize: 20 }}>確認 10:44</span>
    </Row>
    <Row t={t} i={2}>
      講堂の看護師　<b style={{ color: c.warn, border: `2px dashed ${c.warn}`, padding: '0 10px' }}>未確認</b>
      <span style={{ marginLeft: 'auto', color: c.sub, fontSize: 20 }}>― 未記録</span>
    </Row>
    <Row t={t} i={4}>
      <Chip color={c.green} sym="●" label="緑" /> P-015　講堂へ　<b>受け入れ了承</b>
      <span style={{ marginLeft: 'auto', color: c.sub, fontSize: 20 }}>確認 10:46</span>
    </Row>
    <Row t={t} i={3}>
      支援要請　ストレッチャー 2台　<b>手配の指示</b>
      <span style={{ marginLeft: 'auto', color: c.sub, fontSize: 20 }}>確認 10:45</span>
    </Row>
  </div>
);

/** 訓練の画面を模した図（無線の受信箱。すべて架空） */
const TrainingMock = ({ t }: { t: number }) => (
  <div>
    <Row t={t} i={0}>
      ◉ 無線　救急外来より：赤の患者 1名 到着
      <span style={{ marginLeft: 'auto', color: c.sub, fontSize: 20 }}>訓練 10:51</span>
    </Row>
    <Row t={t} i={1}>
      ◉ 無線　外来ホールより：受け入れの空き 3名
      <span style={{ marginLeft: 'auto', color: c.sub, fontSize: 20 }}>訓練 10:52</span>
    </Row>
    <Row t={t} i={2}>
      ◉ 無線　3階東病棟より：受け入れ了承
      <span style={{ marginLeft: 'auto', color: c.sub, fontSize: 20 }}>訓練 10:53</span>
    </Row>
    <Row t={t} i={3}>
      → 本部の記録と照らし合わせて、振り返り
    </Row>
  </div>
);
