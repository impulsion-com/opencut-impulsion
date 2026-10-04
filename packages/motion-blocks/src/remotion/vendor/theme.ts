// Source unique des couleurs, courbes et ressorts (règle : jamais de valeur en dur dans un composant).
import { Easing } from "remotion";

export const theme = {
  colors: {
    white: "#FFFFFF",
    ink: "#0A0A0A",
    accent: "#FFD23F",          // mot-clé (surchargé par style.accent)
    cream: "#F5F2EC",           // palette claire (exemple de charte)
    navy: "#081F29",
    petrol: "#1F4D5C",
    terra: "#A04733",
    shadow: "rgba(0,0,0,0.55)",
    amber: "#E8B768",           // accent motion design (NullMotion), accordé à la lampe du décor
    silver: "#F4F4F6",
  },
  glass: {
    fill: "linear-gradient(180deg, rgba(38,38,43,0.80) 0%, rgba(16,16,19,0.84) 58%, rgba(8,8,10,0.88) 100%)",
    border: "1px solid rgba(255,255,255,0.16)",
    shadow: "inset 0 1.5px rgba(255,255,255,0.18), inset 0 -1px rgba(232,183,104,0.14), 0 24px 60px rgba(0,0,0,0.42)",
    blur: "blur(18px) saturate(1.2)",
  },
  ease: {
    out: Easing.bezier(0.16, 1, 0.3, 1),      // entrées
    inOut: Easing.bezier(0.83, 0, 0.17, 1),   // zooms, déplacements
    in: Easing.bezier(0.7, 0, 0.84, 0),       // sorties
  },
  spring: {
    snappy: { damping: 14, stiffness: 170, mass: 0.6 },   // mots, pastille
    smooth: { damping: 20, stiffness: 90, mass: 1 },      // illustrations
    bouncy: { damping: 11, stiffness: 170, mass: 0.7 },   // mot-clé
  },
  timing: {
    exitFrames: 8,           // sorties plus rapides que les entrées
    captionLeadFrames: 2,    // le texte tombe 2 images avant le mot (déjà appliqué dans le plan)
  },
} as const;
