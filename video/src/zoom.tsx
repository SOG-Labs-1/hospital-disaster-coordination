// 画面の録画を、押した所に寄せて（拡大して）見せる。押した瞬間は輪で囲む。
// 押した所の位置は、録画と一緒に保存した captures/<名前>.cursor.json（video/capture/record.ts が書く）から読む。
import { useEffect, useState, type CSSProperties } from 'react';
import { Video } from '@remotion/media';
import { AbsoluteFill, cancelRender, continueRender, delayRender, getStaticFiles, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { c, fontFamily } from './theme';

type CursorEvent = { t: number; x: number; y: number; press?: boolean };

const has = (file: string) => getStaticFiles().some((f) => f.name === `captures/${file}`);

/** 録画のマウスの印の位置（なければ空） */
export function useCursor(file: string): CursorEvent[] {
  const json = file.replace(/\.webm$/, '.cursor.json');
  const [events, setEvents] = useState<CursorEvent[]>([]);
  const [handle] = useState(() => (has(json) ? delayRender(`cursor ${json}`) : null));
  useEffect(() => {
    if (handle === null) return;
    fetch(staticFile(`captures/${json}`))
      .then((r) => r.json())
      .then((e: CursorEvent[]) => {
        setEvents(e);
        continueRender(handle);
      })
      .catch((err) => cancelRender(err));
  }, [handle, json]);
  return events;
}

/** 時刻 t（録画の秒）の注目点。次の位置へ 0.5 秒かけてなめらかに移る */
function focusAt(events: CursorEvent[], t: number): { x: number; y: number } {
  if (!events.length) return { x: 960, y: 540 };
  let i = events.findIndex((e) => e.t > t);
  if (i === -1) i = events.length;
  const cur = events[Math.max(0, i - 1)]!;
  const prev = events[Math.max(0, i - 2)] ?? cur;
  const k = Math.min(1, Math.max(0, (t - cur.t) / 0.5));
  const ease = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
  if (i === 0) return { x: cur.x, y: cur.y };
  return { x: prev.x + (cur.x - prev.x) * ease, y: prev.y + (cur.y - prev.y) * ease };
}

/**
 * 録画を枠に入れ、押した所に寄せて見せる。
 * from〜to（録画の秒）を dur 秒で再生（速さは rate。実際の速さ＝1）。zoom は寄せる倍率（1 で寄せない）
 */
export const ZoomClip = ({ file, from, rate = 1, zoom = 1.6, label, style, bare }: { file: string; from: number; rate?: number; zoom?: number; label?: string; style?: CSSProperties; bare?: boolean }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const events = useCursor(file);
  const t = from + (frame / fps) * rate;
  const f = focusAt(events, t);
  // 寄せ始めはゆっくり（最初の 0.6 秒で 1 → zoom）
  const z = interpolate(frame, [0, fps * 0.6], [1, zoom], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  // 押した瞬間の前後 0.6 秒、輪で囲む
  const pressed = events.filter((e) => e.press && Math.abs(e.t - t) < 0.6);
  const ring = pressed.length ? 1 - Math.abs(pressed[0]!.t - t) / 0.6 : 0;
  return (
    <div style={{ position: 'absolute', display: 'flex', flexDirection: 'column', gap: 10, ...style }}>
      {label && <div style={{ fontFamily, fontSize: 28, fontWeight: 700, color: c.text, letterSpacing: 2 }}>{label}</div>}
      <div style={{ position: 'relative', aspectRatio: '16 / 9', border: bare ? 'none' : `2px solid ${c.line}`, backgroundColor: c.bg2, overflow: 'hidden', boxShadow: bare ? 'none' : `0 0 60px ${c.accentSoft}` }}>
        {has(file) ? (
          <AbsoluteFill style={{ transformOrigin: `${(f.x / 1920) * 100}% ${(f.y / 1080) * 100}%`, scale: String(z) }}>
            <Video src={staticFile(`captures/${file}`)} muted trimBefore={Math.round(from * fps)} playbackRate={rate} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
          </AbsoluteFill>
        ) : (
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', color: c.sub, fontFamily, fontSize: 28 }}>録画 {file} がありません</AbsoluteFill>
        )}
        {ring > 0 && (
          <div
            style={{
              position: 'absolute',
              left: `${(f.x / 1920) * 100}%`,
              top: `${(f.y / 1080) * 100}%`,
              width: 150,
              height: 150,
              marginLeft: -75,
              marginTop: -75,
              borderRadius: '50%',
              border: `6px solid ${c.warn}`,
              opacity: ring,
              scale: String(1.3 - ring * 0.3),
              boxShadow: `0 0 24px ${c.warn}`,
            }}
          />
        )}
      </div>
    </div>
  );
};
