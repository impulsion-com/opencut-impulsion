# Third-party code and assets in this package

- `src/remotion/vendor/Motion.tsx` comes from video-shotcraft (https://github.com/Vincentwei1021/video-shotcraft,
  Apache-2.0). One change: `useT()` first reads the shot duration from `ShotDurationContext`, because the block
  is placed in a Sequence while `useVideoConfig()` returns the duration of the whole render.
- `src/remotion/vendor/shots.tsx` adapts three video-shotcraft demos (pill-slot-cycle, scramble, blur-slide) to
  text props and to this fork's theme. Apache-2.0.
- `public/fonts/Figtree-*.ttf`: SIL Open Font License 1.1, see `public/fonts/Figtree-OFL.txt`.
- The visual language of `src/remotion/vendor/Graphics.tsx` (dark glass, silver text, amber accent) is inspired
  by NullMotion (https://github.com/blixvip/NullMotion). The code is written for this project and reuses none
  of its files.
