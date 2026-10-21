/** Export: save the current frame as a PNG. */
import type { PlateRenderer } from '../render/types';

export async function saveFrame(renderer: PlateRenderer, label: string) {
  const blob = await renderer.exportPNG();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cymatics-${label}-${stamp}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
