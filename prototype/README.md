# Cymatics

Live sound arranges virtual sand into Chladni figures on a black steel plate.

## Run

No build step. Serve the folder (the microphone needs `localhost` or https):

```bash
python3 -m http.server 5173
```

Then open http://localhost:5173. Opening `index.html` directly works too, without the microphone.

## How sound becomes sand

| Sound | Plate |
| --- | --- |
| Dominant frequency | Selects the main vibration mode `cos(nπx)cos(mπy) ± cos(mπx)cos(nπy)`. Higher pitch gives a higher mode. Near an exact eigenfrequency the figure locks in, and the Tone panel's resonance meter shows how close you are. |
| Low / mid / high band energy | Each band with a distinct peak of its own layers its mode on top: low adds broad cells, high adds fine lattice. |
| RMS loudness | How hard the plate shakes, and so how fast and loosely the sand moves. Silence leaves the sand at rest. |
| Spectral centroid | Ring spacing and squareness of the concentric figure around the drive bolt. |
| Transients (spectral flux) | The sand jumps off the lines, then settles again. |

Each grain is thrown in proportion to the local vibration and drifts toward the nodal lines, where the plate stays still.

## Files

- `js/audio.js`: sources (mic, file, tone) and feature extraction
- `js/plate.js`: modal field and sand simulation (tuning constants in `TUNE`)
- `js/app.js`: render loop, sound-to-plate mapping, interface

Keys: Space play/tone · ←/→ semitone (Shift for octave) · R scatter · S save PNG · F fullscreen · H hide interface.
