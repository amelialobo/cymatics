# Cymatics

An interactive cymatics instrument. Live sound arranges about 100k–300k grains of virtual sand into Chladni figures on a vibrating steel plate, in colours that drift as the figures change.

React · TypeScript · Vite · Tailwind CSS · Web Audio API · Three.js (WebGL2 shaders)

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build in dist/
```

The microphone needs a secure page (`localhost` or https). Add `?cpu` to the URL to try the non-WebGL fallback.

## How it works

**Pattern engine** (`src/pattern/modes.ts`). The plate's displacement is a weighted sum of up to 24 standing-wave eigenmodes plus a concentric term around the drive bolt. There are four plate families (the symmetry selector):

| Family | Mode |
| --- | --- |
| Free plate | cos nπx · cos mπy ± cos mπx · cos nπy (four-fold, diagonal symmetry) |
| Mirror | the same with an unequal partner (axis symmetry only) |
| Clamped | sin nπx · sin mπy − sin mπx · sin nπy (the classic Chladni formula) |
| Radial | cos(nπr) · cos(2mθ) on a superellipse radius (rounded-square rings) |

Each mode has an eigenvalue λ ≈ n² + m². Degenerate eigenvalues are nudged apart, as on a real plate. Driving the plate at a frequency excites the modes near it along a resonance curve, so a slow sweep snaps from figure to figure. Mode weights ease toward their targets, so lines dissolve and re-form instead of jumping. A fixed warp and noise field give the plate its small irregularities.

**Sound → plate** (`src/pattern/driver.ts`):

| Sound | Plate |
| --- | --- |
| Dominant frequency | main mode: higher pitch, more intricate figure |
| Low / mid / high band | extra modes layered on top: broad cells, crossings, fine lattice (only when the band has a real peak of its own) |
| RMS loudness | vibration: how hard the sand is thrown. Silence lets it settle; nothing is cleared. |
| Spectral centroid | spacing and squareness of the rings around the bolt |
| Transients (spectral flux) | kicks that scatter sand off the lines |
| Steady pitch | tighter, crisper lines |
| Sound starting after silence | begins from a simple figure; complexity comes in over a few seconds |

**Sand** (`src/render/shaders.ts`, `simFrag`). Grain positions live in a float texture and are simulated on the GPU each frame. Each grain is thrown in proportion to |f|² (how hard the plate moves beneath it) and takes a Newton step toward the nearest nodal line f = 0. Pressing or dragging on the plate disturbs the sand.

**Colour** (`src/pattern/palette.ts`). Eight palettes in hue order (Citrus, Sunset, Flamingo, Magenta, Ultraviolet, Sky, Lagoon, Lime). Each one pairs a glowing centre and deeper edge background with a sand colour chosen to stand out on both. The figure the sand is drawing picks a position along them: simple, low figures are warm and intricate, high ones cool. The colours glide there over a few seconds, blended in OKLab so the fades stay vivid. A "Colour" switch in Adjust returns to white sand on black.

**Rendering** (`src/render/GpuRenderer.ts`). Each frame runs four passes: the field into a half-float texture, the sand simulation, the grains accumulated into a coverage buffer, and a colour pass that paints the gradient background, a faint nodal-intensity layer (so the structure stays legible while sand moves) and the sand on top. Quality adapts by shedding grains, then resolution, when frames run long. Without WebGL2 float targets, `CpuRenderer.ts` runs the same physics on a 2D canvas.

## Layout

```
src/audio/AudioEngine.ts     sources (mic, file, tone) and feature extraction
src/pattern/modes.ts         eigenmodes, symmetry families, CPU field (mirrors the shader)
src/pattern/driver.ts        sound → mode targets, vibration, kicks
src/pattern/palette.ts       colour palettes and the drift that follows the sand
src/render/shaders.ts        GLSL: field, sand simulation, nodal layer, grains
src/render/GpuRenderer.ts    Three.js renderer, adaptive quality, PNG export
src/render/CpuRenderer.ts    fallback renderer
src/export/snapshot.ts       save frame as PNG
src/core/Experience.ts       owns everything; requestAnimationFrame loop, cleanup
src/core/store.ts            UI state (React reads it; the loop reads it without re-rendering)
src/ui/                      React interface
prototype/                   the earlier dependency-free sketch
```

## Interface

A first-visit welcome card offers three ways in: voice, tone or song. The bottom dock holds the source tabs and one main control for the active source. Adjust (the sliders icon, or `A`) holds plain-language settings: detail, style (with live previews), amount of sand, movement, per-source options, and a "Show sound details" switch for the technical readout. The ? icon explains how it works.

Keys: Space play/stop · ←/→ pitch (Shift for an octave) · P freeze · R scatter · S save image · A adjust · F full screen · ? help · Esc close.
