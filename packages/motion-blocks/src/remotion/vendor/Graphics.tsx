import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "./theme";
import type { Graphic } from "./types";
import { SHOTS } from "./shots";
import { ShotDurationContext } from "./Motion";

// Habillages motion design, écrits pour ce moteur. Le langage visuel s'inspire de NullMotion
// (github.com/blixvip/NullMotion), sans en reprendre le code : panneaux de verre
// sombre, texte argenté en dégradé, surtitre mono avec trait ambre, entrées floues à ressort, balayage
// lumineux (sheen) et étincelle. Chaque habillage se dessine dans un repère 1920x1080, centré sur (x, y).
// Les instants internes (`ms`) sont en temps de sortie absolu, résolus par plan.py sur les mots prononcés.

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const FONT = "'Figtree', sans-serif";
const MONO = "'SFMono-Regular', Menlo, Consolas, monospace";

const silverText: React.CSSProperties = {
  background: "linear-gradient(180deg, #FFFFFF 0%, #E4E4E8 46%, #A9AAB2 100%)",
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
  filter: "drop-shadow(0 10px 22px rgba(0,0,0,0.35))",
};

const glass = (radius: number): React.CSSProperties => ({
  background: theme.glass.fill,
  border: theme.glass.border,
  boxShadow: theme.glass.shadow,
  backdropFilter: theme.glass.blur,
  WebkitBackdropFilter: theme.glass.blur,
  borderRadius: radius,
});

// Temps local (ms depuis le début de la vidéo) et ressort démarrant à un instant absolu.
const useClock = (g: Graphic) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nowMs = g.startMs + (frame / fps) * 1000;
  type SpringCfg = { damping: number; stiffness: number; mass: number };
  const springAt = (ms: number, cfg: SpringCfg = theme.spring.smooth, dur = 20) =>
    spring({ frame: frame - Math.round(((ms - g.startMs) / 1000) * fps), fps, config: cfg, durationInFrames: dur });
  return { frame, fps, nowMs, springAt };
};

// Entrée floue (montée + flou → net) pilotée par un ressort 0 → 1.
const blurIn = (e: number, dy = 18, blur = 8): React.CSSProperties => ({
  opacity: Math.min(1, e * 1.4),
  transform: `translateY(${interpolate(e, [0, 1], [dy, 0])}px)`,
  filter: `blur(${interpolate(e, [0, 1], [blur, 0], clamp)}px)`,
});

const Eyebrow: React.FC<{ text: string; e: number }> = ({ text, e }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 12, ...blurIn(e, 10, 4) }}>
    <i style={{ width: 22 * e, height: 1.5, background: theme.colors.amber, boxShadow: "0 0 16px rgba(232,183,104,0.55)" }} />
    <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 560, letterSpacing: "0.19em", color: "rgba(244,244,246,0.62)" }}>
      {text}
    </span>
  </div>
);

// Balayage lumineux qui traverse un bloc (0 → 1).
const Sheen: React.FC<{ t: number }> = ({ t }) => (
  <span
    style={{
      position: "absolute",
      zIndex: 3,
      top: "-20%",
      left: `${interpolate(t, [0, 1], [-40, 120])}%`,
      width: "26%",
      height: "140%",
      opacity: t > 0 && t < 1 ? interpolate(t, [0, 0.15, 0.8, 1], [0, 0.85, 0.85, 0]) : 0,
      background: "linear-gradient(105deg, transparent, rgba(255,255,255,0.7), rgba(232,183,104,0.3), transparent)",
      transform: "skewX(-16deg)",
      pointerEvents: "none",
    }}
  />
);

const Spark: React.FC<{ t: number; from: number; to: number; y?: number }> = ({ t, from, to, y = 0 }) => (
  <span
    style={{
      position: "absolute",
      zIndex: 5,
      left: "50%",
      top: "50%",
      width: 9,
      height: 9,
      margin: -4.5,
      borderRadius: "50%",
      background: "#FFF6DF",
      opacity: t > 0 && t < 1 ? interpolate(t, [0, 0.1, 0.8, 1], [0, 1, 1, 0]) : 0,
      transform: `translate(${interpolate(t, [0, 1], [from, to])}px, ${y}px)`,
      boxShadow: "0 0 12px rgba(255,246,223,0.9), 0 0 34px rgba(232,183,104,0.65), 0 0 80px rgba(232,183,104,0.25)",
    }}
  />
);

// ------------------------------------------------------------------------------------------------
// headline : titre cinétique (22-kinetic-headline). Mot d'appel + mot-clé dans une pilule de verre.
// props : eyebrow, lead, pill, micro
// ------------------------------------------------------------------------------------------------
const Headline: React.FC<{ g: Graphic }> = ({ g }) => {
  const { springAt, nowMs } = useClock(g);
  const s = g.startMs;
  const P = g.props;
  const glow = springAt(s, theme.spring.smooth, 24);
  const lead = springAt(s + 150, theme.spring.snappy, 18);
  const pill = springAt(s + 420, { damping: 12, stiffness: 150, mass: 0.8 }, 22);
  const micro = springAt(s + 800, theme.spring.smooth, 18);
  const sweep = interpolate(nowMs, [s + 1150, s + 1950], [0, 1], clamp);
  const drift = interpolate(nowMs, [s, g.endMs], [0, 1], clamp);
  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 18 }}>
      <div
        style={{
          position: "absolute",
          left: -160,
          top: -120,
          width: 860,
          height: 520,
          opacity: 0.9 * glow,
          background: "radial-gradient(ellipse at 45% 52%, rgba(232,183,104,0.16) 0%, rgba(92,123,128,0.08) 34%, rgba(4,8,10,0) 72%)",
          filter: "blur(12px)",
          transform: `scale(${0.78 + glow * 0.1 + drift * 0.04}) translateX(${drift * 12}px)`,
        }}
      />
      {P.eyebrow ? <Eyebrow text={P.eyebrow} e={springAt(s + 80)} /> : null}
      <div style={{ overflow: "hidden", padding: "6px 2px 10px" }}>
        <span
          style={{
            display: "block",
            fontFamily: FONT,
            fontWeight: 800,
            fontSize: 104,
            lineHeight: 0.9,
            letterSpacing: "-0.045em",
            ...silverText,
            opacity: Math.min(1, lead * 1.3),
            transform: `translateX(${interpolate(lead, [0, 1], [-110, 0])}px) rotate(${interpolate(lead, [0, 1], [-1.2, 0])}deg)`,
            filter: `blur(${interpolate(lead, [0, 1], [8, 0], clamp)}px) drop-shadow(0 10px 22px rgba(0,0,0,0.35))`,
          }}
        >
          {P.lead}
        </span>
      </div>
      <div style={{ position: "relative", padding: "10px 0 26px" }}>
        <div
          style={{
            position: "absolute",
            left: "10%",
            right: "10%",
            bottom: 12,
            height: 26,
            borderRadius: "50%",
            background: "rgba(0,0,0,0.5)",
            filter: "blur(18px)",
            opacity: pill,
          }}
        />
        <div
          style={{
            position: "relative",
            overflow: "hidden",
            padding: "26px 54px 30px",
            ...glass(999),
            opacity: Math.min(1, pill * 1.4),
            transform: `scaleX(${interpolate(pill, [0, 1], [0.93, 1])}) scaleY(${interpolate(pill, [0, 1], [1.06, 1])}) translateY(${interpolate(pill, [0, 1], [14, 0])}px)`,
            filter: `blur(${interpolate(pill, [0, 1], [6, 0], clamp)}px)`,
            boxShadow: `${theme.glass.shadow}, 0 0 48px rgba(232,183,104,${0.12 * pill})`,
          }}
        >
          <span style={{ position: "relative", zIndex: 2, fontFamily: FONT, fontWeight: 800, fontSize: 86, lineHeight: 0.95, letterSpacing: "-0.04em", ...silverText }}>
            {P.pill}
          </span>
          <Sheen t={sweep} />
        </div>
        <Spark t={sweep} from={-230} to={230} y={-4} />
      </div>
      {P.micro ? (
        <div style={{ fontFamily: MONO, fontSize: 14, letterSpacing: "0.2em", color: "rgba(244,244,246,0.5)", ...blurIn(micro, 9, 3) }}>{P.micro}</div>
      ) : null}
    </div>
  );
};

// ------------------------------------------------------------------------------------------------
// program : le sommaire (02-three-step + 21-connector-list). Le module en cours s'allume, les
// précédents passent en « fait », des puces apparaissent sous le module actif au fil de la voix.
// props : eyebrow, items: [{ title, ms, chips: [{ label, ms }] }]
// ------------------------------------------------------------------------------------------------
const Program: React.FC<{ g: Graphic }> = ({ g }) => {
  const { springAt, nowMs } = useClock(g);
  const items: { title: string; ms: number; chips?: { label: string; ms: number }[] }[] = g.props.items ?? [];
  const active = items.reduce((a, it, i) => (nowMs >= it.ms ? i : a), -1);
  const panel = springAt(g.startMs, theme.spring.smooth, 22);
  const ROW = 78;
  return (
    <div style={{ width: 560, padding: "30px 34px 30px", ...glass(30), ...blurIn(panel, 26, 10) }}>
      <Eyebrow text={g.props.eyebrow ?? "PROGRAMME"} e={springAt(g.startMs + 120)} />
      <div style={{ position: "relative", marginTop: 22 }}>
        {items.map((it, i) => {
          const appear = springAt(g.startMs + 180 + i * 90, theme.spring.snappy, 16);
          const on = springAt(it.ms, theme.spring.snappy, 14);
          const isActive = i === active;
          const done = i < active;
          const chips = it.chips ?? [];
          const open = isActive ? springAt(it.ms + 120, theme.spring.smooth, 18) : done ? 1 - springAt(items[i + 1]?.ms ?? 1e12, theme.spring.smooth, 14) : 0;
          const chipsH = chips.length ? 54 * Math.ceil(chips.length / 3) * open : 0;   // 3 puces par ligne
          const lit = isActive ? on : 0;
          return (
            <div key={i} style={{ position: "relative", ...blurIn(appear, 14, 6) }}>
              {i < items.length - 1 ? (
                <div style={{ position: "absolute", left: 23, top: 52, width: 2, height: ROW - 52 + 10 + chipsH, background: "rgba(255,255,255,0.1)" }}>
                  <div
                    style={{
                      width: 2,
                      height: `${(done ? 1 : isActive ? interpolate(nowMs, [it.ms, items[i + 1].ms], [0, 1], clamp) : 0) * 100}%`,
                      background: theme.colors.amber,
                      boxShadow: "0 0 10px rgba(232,183,104,0.6)",
                    }}
                  />
                </div>
              ) : null}
              <div style={{ display: "flex", alignItems: "center", gap: 20, height: ROW - 10 }}>
                <div
                  style={{
                    width: 48,
                    height: 48,
                    flex: "0 0 48px",
                    borderRadius: 24,
                    display: "grid",
                    placeItems: "center",
                    fontFamily: MONO,
                    fontSize: 17,
                    fontWeight: 600,
                    color: isActive ? "#1A1206" : done ? theme.colors.amber : "rgba(244,244,246,0.5)",
                    background: isActive ? `rgba(232,183,104,${0.25 + 0.75 * lit})` : "rgba(255,255,255,0.05)",
                    border: `1.5px solid ${isActive || done ? "rgba(232,183,104,0.9)" : "rgba(255,255,255,0.16)"}`,
                    boxShadow: isActive ? `0 0 ${28 * lit}px rgba(232,183,104,0.55)` : "none",
                    transform: `scale(${isActive ? interpolate(lit, [0, 0.6, 1], [1, 1.14, 1]) : 1})`,
                  }}
                >
                  {done ? "✓" : String(i + 1).padStart(2, "0")}
                </div>
                <div
                  style={{
                    fontFamily: FONT,
                    fontWeight: isActive ? 800 : 600,
                    fontSize: isActive ? 36 : 31,
                    letterSpacing: "-0.02em",
                    color: isActive ? theme.colors.silver : done ? "rgba(244,244,246,0.72)" : "rgba(244,244,246,0.42)",
                    transform: `translateX(${isActive ? 6 * lit : 0}px)`,
                    whiteSpace: "nowrap",
                  }}
                >
                  {it.title}
                </div>
              </div>
              <div style={{ height: chipsH + 10, overflow: "hidden", paddingLeft: 68, display: "flex", flexWrap: "wrap", gap: 10, alignContent: "flex-start" }}>
                {chips.map((c, k) => {
                  const pop = springAt(c.ms, theme.spring.bouncy, 14);
                  return (
                    <span
                      key={k}
                      style={{
                        fontFamily: FONT,
                        fontWeight: 600,
                        fontSize: 21,
                        color: theme.colors.silver,
                        padding: "8px 16px",
                        borderRadius: 999,
                        background: "rgba(255,255,255,0.08)",
                        border: "1px solid rgba(255,255,255,0.14)",
                        opacity: Math.min(1, pop * 1.5) * open,
                        transform: `scale(${interpolate(pop, [0, 1], [0.7, 1])})`,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.label}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ------------------------------------------------------------------------------------------------
// prompt : barre de commande qui se tape (08-prompt-bar + 23-prompt-composer), puis lignes de résultat.
// props : eyebrow, text, typeMs, lines: [{ label, ms }]
// ------------------------------------------------------------------------------------------------
const Prompt: React.FC<{ g: Graphic }> = ({ g }) => {
  const { springAt, nowMs, frame } = useClock(g);
  const P = g.props;
  const panel = springAt(g.startMs, theme.spring.smooth, 22);
  const t0 = g.startMs + 350;
  const typed = Math.floor(interpolate(nowMs, [t0, t0 + (P.typeMs ?? 1400)], [0, P.text.length], clamp));
  const doneTyping = typed >= P.text.length;
  const caret = !doneTyping || Math.floor(frame / 15) % 2 === 0;
  const lines: { label: string; ms: number }[] = P.lines ?? [];
  const send = springAt(t0 + (P.typeMs ?? 1400) + 80, theme.spring.bouncy, 12);
  return (
    <div style={{ width: 620, padding: "22px 26px 26px", ...glass(26), ...blurIn(panel, 26, 10) }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18 }}>
        {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
          <i key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c, opacity: 0.85 }} />
        ))}
        <span style={{ marginLeft: 14, fontFamily: MONO, fontSize: 15, letterSpacing: "0.16em", color: "rgba(244,244,246,0.55)" }}>{P.eyebrow}</span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "18px 20px",
          borderRadius: 16,
          background: "rgba(0,0,0,0.35)",
          border: `1px solid rgba(232,183,104,${doneTyping ? 0.5 : 0.22})`,
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 26, color: theme.colors.amber }}>›</span>
        <span style={{ flex: 1, fontFamily: MONO, fontSize: 23, color: theme.colors.silver, lineHeight: 1.35 }}>
          {P.text.slice(0, typed)}
          <span style={{ display: "inline-block", width: 11, height: 26, marginLeft: 2, verticalAlign: "-4px", background: theme.colors.amber, opacity: caret ? 1 : 0 }} />
        </span>
        <span
          style={{
            width: 40,
            height: 40,
            flex: "0 0 40px",
            borderRadius: 20,
            display: "grid",
            placeItems: "center",
            background: `rgba(232,183,104,${0.2 + 0.8 * send})`,
            color: "#1A1206",
            fontSize: 22,
            fontWeight: 800,
            transform: `scale(${interpolate(send, [0, 0.5, 1], [1, 0.86, 1])})`,
          }}
        >
          ↑
        </span>
      </div>
      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        {lines.map((l, i) => {
          const e = springAt(l.ms, theme.spring.snappy, 14);
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: FONT, fontWeight: 600, fontSize: 24, color: theme.colors.silver, ...blurIn(e, 10, 5) }}>
              <span style={{ color: theme.colors.amber, fontWeight: 800 }}>✓</span>
              {l.label}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ------------------------------------------------------------------------------------------------
// growth : courbe qui se trace (16-line-growth), point lumineux en bout, aire en dégradé. Sans chiffre.
// props : eyebrow, label
// ------------------------------------------------------------------------------------------------
const Growth: React.FC<{ g: Graphic }> = ({ g }) => {
  const { springAt, nowMs } = useClock(g);
  const panel = springAt(g.startMs, theme.spring.smooth, 20);
  const draw = interpolate(nowMs, [g.startMs + 200, g.startMs + 1300], [0, 1], { ...clamp, easing: theme.ease.out });
  const W = 520, H = 240;
  const pts = [0, 0.08, 0.06, 0.2, 0.17, 0.34, 0.31, 0.52, 0.5, 0.74, 1].map((v, i, a) => [(i / (a.length - 1)) * W, H - 16 - v * (H - 40)]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const len = 760;
  const idx = draw * (pts.length - 1);
  const i0 = Math.min(pts.length - 2, Math.floor(idx));
  const f = idx - i0;
  const head = [pts[i0][0] + (pts[i0 + 1][0] - pts[i0][0]) * f, pts[i0][1] + (pts[i0 + 1][1] - pts[i0][1]) * f];
  return (
    <div style={{ width: 580, padding: "26px 30px 24px", ...glass(28), ...blurIn(panel, 24, 10) }}>
      <Eyebrow text={g.props.eyebrow ?? "CROISSANCE"} e={springAt(g.startMs + 100)} />
      <svg width={W} height={H} style={{ marginTop: 14, overflow: "visible" }}>
        <defs>
          <linearGradient id="gArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(232,183,104,0.35)" />
            <stop offset="100%" stopColor="rgba(232,183,104,0)" />
          </linearGradient>
          <clipPath id="gClip">
            <rect x={0} y={-20} width={W * draw} height={H + 40} />
          </clipPath>
        </defs>
        {[0.25, 0.5, 0.75].map((y) => (
          <line key={y} x1={0} x2={W} y1={H * y} y2={H * y} stroke="rgba(255,255,255,0.07)" />
        ))}
        <path d={`${d} L${W},${H} L0,${H} Z`} fill="url(#gArea)" clipPath="url(#gClip)" />
        <path d={d} fill="none" stroke={theme.colors.amber} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={len} strokeDashoffset={len * (1 - draw)} style={{ filter: "drop-shadow(0 0 8px rgba(232,183,104,0.6))" }} />
        <circle cx={head[0]} cy={head[1]} r={8} fill="#FFF6DF" opacity={draw > 0.02 ? 1 : 0} style={{ filter: "drop-shadow(0 0 12px rgba(232,183,104,0.9))" }} />
      </svg>
      <div style={{ marginTop: 10, fontFamily: FONT, fontWeight: 800, fontSize: 34, letterSpacing: "-0.02em", ...silverText, ...blurIn(springAt(g.startMs + 900), 10, 5) }}>{g.props.label}</div>
    </div>
  );
};

// ------------------------------------------------------------------------------------------------
// stack : cartes qui s'empilent (06-notification + 17-integrations-grid), icône dessinée ou coche animée.
// props : eyebrow, title, items: [{ icon: "lessons"|"resources"|"community"|"check", label, sub, ms }]
// ------------------------------------------------------------------------------------------------
const Icon: React.FC<{ name: string; t: number }> = ({ name, t }) => {
  const c = theme.colors.amber;
  const common = { width: 30, height: 30, viewBox: "0 0 24 24", fill: "none", stroke: c, strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (name === "lessons")
    return (
      <svg {...common}>
        <rect x="3" y="5" width="18" height="13" rx="2.5" />
        <path d="M10 9.2v5.6l4.6-2.8z" fill={c} stroke="none" />
      </svg>
    );
  if (name === "resources")
    return (
      <svg {...common}>
        <path d="M3 7.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    );
  if (name === "community")
    return (
      <svg {...common}>
        <circle cx="9" cy="9" r="3.2" />
        <circle cx="16.5" cy="10" r="2.5" />
        <path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6M14.5 15.2c2.6-.4 4.8.9 5.5 3.8" />
      </svg>
    );
  return (
    <svg {...common}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
      <path d="M7.8 12.4l3 3 5.6-6.2" strokeDasharray={16} strokeDashoffset={16 * (1 - t)} strokeWidth={2.4} />
    </svg>
  );
};

const Stack: React.FC<{ g: Graphic }> = ({ g }) => {
  const { springAt } = useClock(g);
  const P = g.props;
  const panel = springAt(g.startMs, theme.spring.smooth, 22);
  const items: { icon: string; label: string; sub?: string; ms: number }[] = P.items ?? [];
  return (
    <div style={{ width: 540, padding: "28px 28px 24px", ...glass(30), ...blurIn(panel, 24, 10) }}>
      {P.eyebrow ? <Eyebrow text={P.eyebrow} e={springAt(g.startMs + 100)} /> : null}
      {P.title ? (
        <div style={{ marginTop: 12, marginBottom: 6, fontFamily: FONT, fontWeight: 800, fontSize: 38, letterSpacing: "-0.025em", ...silverText, ...blurIn(springAt(g.startMs + 180), 10, 5) }}>{P.title}</div>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", marginTop: 14 }}>
        {items.map((it, i) => {
          const e = springAt(it.ms, theme.spring.snappy, 16);
          const tick = springAt(it.ms + 180, theme.spring.smooth, 16);
          return (
            <div key={i} style={{ maxHeight: 130 * Math.min(1, e * 1.2), marginBottom: i < items.length - 1 ? 12 * Math.min(1, e) : 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 18,
                padding: "14px 18px",
                borderRadius: 18,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.1)",
                opacity: Math.min(1, e * 1.4),
                transform: `translateX(${interpolate(e, [0, 1], [60, 0])}px) scale(${interpolate(e, [0, 1], [0.96, 1])})`,
                filter: `blur(${interpolate(e, [0, 1], [6, 0], clamp)}px)`,
              }}
            >
              <div style={{ width: 52, height: 52, borderRadius: 14, display: "grid", placeItems: "center", background: "rgba(232,183,104,0.12)", border: "1px solid rgba(232,183,104,0.3)" }}>
                <Icon name={it.icon} t={tick} />
              </div>
              <div>
                <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 28, color: theme.colors.silver, letterSpacing: "-0.01em" }}>{it.label}</div>
                {it.sub ? <div style={{ fontFamily: FONT, fontWeight: 500, fontSize: 19, color: "rgba(244,244,246,0.55)", marginTop: 2 }}>{it.sub}</div> : null}
              </div>
            </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ------------------------------------------------------------------------------------------------
// notify : notifications façon iOS qui glissent et s'empilent (06-notification, 24-showreel-notify).
// props : items: [{ app, title, body, ms }]  (la plus récente en haut)
// ------------------------------------------------------------------------------------------------
const Notify: React.FC<{ g: Graphic }> = ({ g }) => {
  const { springAt } = useClock(g);
  const items: { app: string; title: string; body: string; ms: number }[] = g.props.items ?? [];
  let offset = 0;
  const rendered = items.map((it, i) => {
    const e = springAt(it.ms, { damping: 16, stiffness: 160, mass: 0.7 }, 18);
    const push = items.slice(i + 1).reduce((a, n) => a + springAt(n.ms, theme.spring.smooth, 18) * 128, 0);
    offset = push;
    return (
      <div
        key={i}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 560,
          padding: "18px 22px",
          ...glass(26),
          opacity: Math.min(1, e * 1.5),
          transform: `translateY(${interpolate(e, [0, 1], [-70, 0]) + push}px) scale(${interpolate(e, [0, 1], [0.94, 1]) - (push ? 0.02 : 0)})`,
          filter: `blur(${interpolate(e, [0, 1], [8, 0], clamp)}px)`,
          zIndex: 10 + i,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, background: theme.colors.amber, display: "grid", placeItems: "center", fontFamily: FONT, fontWeight: 900, fontSize: 15, color: "#1A1206" }}>i</div>
          <span style={{ fontFamily: FONT, fontWeight: 600, fontSize: 17, letterSpacing: "0.04em", color: "rgba(244,244,246,0.6)", textTransform: "uppercase" }}>{it.app}</span>
          <span style={{ marginLeft: "auto", fontFamily: FONT, fontSize: 16, color: "rgba(244,244,246,0.4)" }}>maintenant</span>
        </div>
        <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 25, color: theme.colors.silver }}>{it.title}</div>
        <div style={{ fontFamily: FONT, fontWeight: 500, fontSize: 21, color: "rgba(244,244,246,0.72)", marginTop: 3 }}>{it.body}</div>
      </div>
    );
  });
  return <div style={{ position: "relative", width: 560, height: 120 + offset }}>{rendered}</div>;
};

// ------------------------------------------------------------------------------------------------
// cta : pilule d'appel à l'action (01-cta-pill + 18-cta-click), flèche qui avance, balayage lumineux.
// props : eyebrow, label
// ------------------------------------------------------------------------------------------------
const Cta: React.FC<{ g: Graphic }> = ({ g }) => {
  const { springAt, nowMs, fps, frame } = useClock(g);
  const e = springAt(g.startMs, { damping: 12, stiffness: 150, mass: 0.8 }, 22);
  const sweep = interpolate(nowMs, [g.startMs + 700, g.startMs + 1450], [0, 1], clamp);
  const nudge = Math.max(0, Math.sin(((frame / fps) * Math.PI * 2) / 1.2)) * 8;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
      {g.props.eyebrow ? <Eyebrow text={g.props.eyebrow} e={springAt(g.startMs + 150)} /> : null}
      <div
        style={{
          position: "relative",
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          gap: 22,
          padding: "22px 30px 22px 44px",
          ...glass(999),
          boxShadow: `${theme.glass.shadow}, 0 0 60px rgba(232,183,104,${0.18 * e})`,
          opacity: Math.min(1, e * 1.4),
          transform: `scale(${interpolate(e, [0, 1], [0.85, 1])})`,
          filter: `blur(${interpolate(e, [0, 1], [6, 0], clamp)}px)`,
        }}
      >
        <span style={{ fontFamily: FONT, fontWeight: 800, fontSize: 46, letterSpacing: "-0.03em", ...silverText }}>{g.props.label}</span>
        <span
          style={{
            width: 58,
            height: 58,
            borderRadius: 29,
            display: "grid",
            placeItems: "center",
            background: theme.colors.amber,
            color: "#1A1206",
            fontSize: 30,
            fontWeight: 900,
            transform: `translateX(${nudge}px)`,
            boxShadow: "0 0 26px rgba(232,183,104,0.55)",
          }}
        >
          →
        </span>
        <Sheen t={sweep} />
      </div>
    </div>
  );
};

// shot : plan de coupe plein écran (video-shotcraft adapté, src/shots). props : name + props du plan.
// Entrée et sortie en coupe franche adoucie (3 et 4 images), la voix continue dessous.
const Shot: React.FC<{ g: Graphic; durationInFrames: number }> = ({ g, durationInFrames }) => {
  const frame = useCurrentFrame();
  const C = SHOTS[g.props.name];
  if (!C) throw new Error(`plan shotcraft inconnu : ${g.props.name}`);
  const o = interpolate(frame, [0, 3, durationInFrames - 4, durationInFrames], [0, 1, 1, 0], clamp);
  return (
    <AbsoluteFill style={{ opacity: o }}>
      <ShotDurationContext.Provider value={durationInFrames}>
        <C {...g.props} />
      </ShotDurationContext.Provider>
    </AbsoluteFill>
  );
};

const KINDS: Record<Exclude<Graphic["kind"], "shot">, React.FC<{ g: Graphic }>> = {
  headline: Headline,
  program: Program,
  prompt: Prompt,
  growth: Growth,
  stack: Stack,
  notify: Notify,
  cta: Cta,
};

// Cadre commun : placement, échelle, sortie (plus rapide que l'entrée : fondu + flou + léger recul).
const Frame: React.FC<{ g: Graphic; durationInFrames: number }> = ({ g, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const exit = interpolate(frame, [durationInFrames - theme.timing.exitFrames - 2, durationInFrames], [1, 0], { ...clamp, easing: theme.ease.in });
  const K = KINDS[g.kind as Exclude<Graphic["kind"], "shot">];
  const k = (width / 1920) * g.scale;
  const anchorX = g.props.align === "left" ? "0%" : g.props.align === "right" ? "-100%" : "-50%";
  return (
    <div
      style={{
        position: "absolute",
        left: width * g.x,
        top: height * g.y,
        transform: `translate(${anchorX}, -50%) scale(${k * interpolate(exit, [0, 1], [0.97, 1])})`,
        transformOrigin: g.props.align === "left" ? "0% 50%" : g.props.align === "right" ? "100% 50%" : "50% 50%",
        opacity: exit,
        filter: exit < 1 ? `blur(${(1 - exit) * 6}px)` : undefined,
      }}
    >
      <K g={g} />
    </div>
  );
};

export const Graphics: React.FC<{ p: { graphics: Graphic[] } }> = ({ p }) => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {p.graphics.map((g, i) => {
        const from = Math.round((g.startMs / 1000) * fps);
        const dur = Math.max(6, Math.round((g.endMs / 1000) * fps) - from);
        return (
          <Sequence key={i} from={from} durationInFrames={dur} layout="none">
            {g.kind === "shot" ? <Shot g={g} durationInFrames={dur} /> : <Frame g={g} durationInFrames={dur} />}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
