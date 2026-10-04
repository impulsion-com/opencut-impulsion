import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { DesignStage, E, lerp, rand, seg, useT } from "./Motion";
import { theme } from "./theme";

// Plans de coupe plein écran adaptés de video-shotcraft (Apache-2.0, voir shotcraft/NOTICE.md) :
// mêmes courbes et mêmes timings que l'original, textes en props et charte Impulsion (fond sombre,
// Figtree, accent ambre). La durée de chaque plan vient du moteur (ShotDurationContext).

const FONT = "'Figtree', sans-serif";
const BG = "radial-gradient(ellipse at 50% 45%, #1A1712 0%, #0B0B0D 62%, #060607 100%)";

// ------------------------------------------------------------------------------------------------
// pillSlot : d'après typography/pill-slot-cycle/PillSlotCycle.tsx. Phrase fixe + pilule qui tourne
// comme une machine à sous, puis mot final. props : stem, pills: string[], finale, beat (images)
// ------------------------------------------------------------------------------------------------
const Pill: React.FC<{ label: string; style?: React.CSSProperties }> = ({ label, style }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      padding: "16px 44px 20px",
      borderRadius: 999,
      background: "linear-gradient(180deg, rgba(42,42,47,0.98) 0%, rgba(17,17,20,0.99) 60%, rgba(7,7,9,0.99) 100%)",
      border: "1.5px solid rgba(232,183,104,0.55)",
      boxShadow: "inset 0 2px rgba(255,255,255,0.18), 0 0 40px rgba(232,183,104,0.18), 0 18px 40px rgba(0,0,0,0.4)",
      fontFamily: FONT,
      fontWeight: 800,
      fontSize: 92,
      letterSpacing: -2,
      color: theme.colors.amber,
      whiteSpace: "nowrap",
      ...style,
    }}
  >
    {label}
  </div>
);

export const PillSlot: React.FC<{ stem: string; pills: string[]; finale?: string; beat?: number }> = ({ stem, pills, finale, beat = 21 }) => {
  const frame = useCurrentFrame();
  const INTRO = 12, SWAP = 8, CYCLES = pills.length;
  const stemT = interpolate(frame, [0, INTRO], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const cycleEnd = INTRO + CYCLES * beat;
  const rel = frame - INTRO;
  const idx = Math.max(0, Math.min(Math.floor(rel / beat), CYCLES - 1));
  const beatFrame = rel - idx * beat;
  const isFinale = !!finale && frame >= cycleEnd;
  let slot: React.ReactNode = null;
  if (!isFinale && rel >= 0) {
    const inT = interpolate(beatFrame, [0, SWAP], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
    const outT = interpolate(beatFrame, [0, SWAP - 1], [0, 1], { extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) });
    const outgoing = idx > 0 ? pills[idx - 1] : null;
    slot = (
      <div style={{ position: "relative", display: "inline-block" }}>
        <Pill label={pills[idx]} style={{ visibility: "hidden" }} />
        {outgoing && outT < 1 ? (
          <div style={{ position: "absolute", left: 0, top: 0, transform: `translateY(${-130 * outT}px)`, opacity: 1 - outT, filter: `blur(${outT * 10}px)` }}>
            <Pill label={outgoing} />
          </div>
        ) : null}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            transform: `translateY(${interpolate(inT, [0, 1], [120, 0])}px)`,
            opacity: idx === 0 ? inT : Math.min(1, inT * 1.6),
            filter: `blur(${interpolate(inT, [0, 0.7, 1], [14, 4, 0])}px)`,
          }}
        >
          <Pill label={pills[idx]} />
        </div>
      </div>
    );
  } else if (isFinale) {
    const finT = interpolate(frame, [cycleEnd, cycleEnd + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.back(1.4)) });
    const lastOutT = interpolate(frame, [cycleEnd, cycleEnd + 7], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) });
    slot = (
      <div style={{ position: "relative", display: "inline-block" }}>
        <span
          style={{
            fontFamily: FONT,
            fontWeight: 800,
            fontSize: 110,
            letterSpacing: -3,
            color: theme.colors.silver,
            display: "inline-block",
            opacity: finT,
            transform: `translateY(${(1 - finT) * 90}px)`,
            filter: `blur(${(1 - finT) * 8}px)`,
            whiteSpace: "nowrap",
          }}
        >
          {finale}
        </span>
        {lastOutT < 1 ? (
          <div style={{ position: "absolute", left: 0, top: -8, transform: `translateY(${-130 * lastOutT}px)`, opacity: 1 - lastOutT, filter: `blur(${lastOutT * 10}px)` }}>
            <Pill label={pills[CYCLES - 1]} />
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <AbsoluteFill style={{ background: BG }}>
      <div
        style={{
          position: "absolute",
          left: 240,
          top: 540,
          transform: `translateY(calc(-50% + ${(1 - stemT) * 50}px))`,
          display: "flex",
          alignItems: "center",
          gap: 40,
          opacity: stemT,
        }}
      >
        <span style={{ fontFamily: FONT, fontWeight: 800, fontSize: 110, letterSpacing: -3, color: theme.colors.silver, whiteSpace: "nowrap" }}>{stem}</span>
        {slot}
      </div>
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------------------------------------
// scramble : d'après typography/scramble/Scramble.tsx. Chaque caractère saute au hasard puis se
// verrouille de gauche à droite avec un éclat. props : text
// ------------------------------------------------------------------------------------------------
const POOL = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+=<>/\\";

export const Scramble: React.FC<{ text: string }> = ({ text }) => {
  const t = useT();
  const frame = Math.floor(t * 96);
  const chars = [...text];
  return (
    <DesignStage bg="#0B0B0D">
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: BG,
          fontFamily: '"SF Mono",Menlo,monospace',
          fontSize: Math.min(34, 560 / Math.max(10, chars.length)),
          letterSpacing: 2,
        }}
      >
        {chars.map((ch, i) => {
          let content = ch;
          let color = "#3d3a33";
          let textShadow = "none";
          if (ch !== " ") {
            const lockAt = 0.25 + (i / chars.length) * 0.6 + rand(i * 7) * 0.06;
            if (t < 0.06) content = " ";
            else if (t < lockAt) content = POOL[Math.floor(rand(i * 131 + Math.floor(frame / 2)) * POOL.length)];
            else {
              const flash = 1 - seg(t, lockAt, lockAt + 0.1);
              color = flash > 0.4 ? "#FFF6DF" : "#F1ECE2";
              textShadow = `0 0 ${flash * 18}px rgba(232,183,104,${flash})`;
            }
          }
          return (
            <span key={i} style={{ minWidth: "0.62em", textAlign: "center", color, textShadow }}>
              {content === " " ? " " : content}
            </span>
          );
        })}
      </div>
    </DesignStage>
  );
};

// ------------------------------------------------------------------------------------------------
// blurSlide : d'après typography/blur-slide/BlurSlide.tsx. Titre mot à mot (montée + flou + fondu,
// easeOutCubic), sous-titre ensuite. props : title, subtitle
// ------------------------------------------------------------------------------------------------
const Line: React.FC<{ words: string[]; tLine: number; gap: number; dy: number; style: React.CSSProperties }> = ({ words, tLine, gap, dy, style }) => (
  <div style={{ display: "flex", gap: "0.32em", ...style }}>
    {words.map((w, i) => {
      const p = seg(tLine, i * gap, i * gap + 0.32, E.outCubic);
      return (
        <span key={i} style={{ opacity: p, transform: `translateY(${lerp(p, dy, 0)}px)`, filter: `blur(${(1 - p) * 10}px)` }}>
          {w}
        </span>
      );
    })}
  </div>
);

export const BlurSlide: React.FC<{ title: string; subtitle?: string; accent?: string }> = ({ title, subtitle, accent }) => {
  const t = useT();
  const words = title.split(" ");
  return (
    <DesignStage bg="#0B0B0D">
      <div style={{ position: "absolute", inset: 0, background: BG, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
        <Line
          words={words}
          tLine={seg(t, 0.06, 0.62)}
          gap={0.055}
          dy={40}
          style={{ fontWeight: 800, fontSize: 38, lineHeight: 1.15, fontFamily: FONT, color: theme.colors.silver, letterSpacing: "-0.8px" }}
        />
        {subtitle ? (
          <Line
            words={subtitle.split(" ")}
            tLine={seg(t, 0.34, 0.9)}
            gap={0.04}
            dy={26}
            style={{ fontWeight: 500, fontSize: 15, lineHeight: 1.4, fontFamily: FONT, color: accent ?? theme.colors.amber }}
          />
        ) : null}
      </div>
    </DesignStage>
  );
};

export const SHOTS: Record<string, React.FC<any>> = { pillSlot: PillSlot, scramble: Scramble, blurSlide: BlurSlide };
