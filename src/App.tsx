import { useEffect, useRef, useState } from 'react';
import { Experience } from './core/Experience';
import { setParams, toast, ui, useUI } from './core/store';
import { AdjustPanel } from './ui/AdjustPanel';
import { Dock, TopBar } from './ui/Bars';
import { ExperienceContext, toggleFullscreen } from './ui/context';
import { Bolt, Details, DropOverlay, FileInput, Help, Intro, Loader, NoRenderer, Toast, Welcome } from './ui/Overlays';
import { cx } from './ui/primitives';

export default function App() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [exp, setExp] = useState<Experience | null>(null);
  const [dragging, setDragging] = useState(false);
  const renderer = useUI((s) => s.renderer);
  // the bars stay out of the way while the sand spells the title
  const titled = useUI((s) => s.intro === 'forming' || s.intro === 'title');

  // the instrument lives outside React; mount it once, tear it down fully
  useEffect(() => {
    const e = new Experience(stageRef.current!);
    setExp(e);
    if (import.meta.env.DEV) (window as unknown as { cymatics: Experience }).cymatics = e; // console handle for tuning
    return () => {
      e.dispose();
      setExp(null);
    };
  }, []);

  // keyboard
  useEffect(() => {
    if (!exp) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') {
        ui.set({ panelOpen: false, helpOpen: false });
        return;
      }
      if (ui.get().intro !== 'done') return;
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]')) return;
      const onButton = !!el.closest('button, [role="radio"], [role="switch"], [role="tab"]');
      const { tab, params } = ui.get();
      const a = exp.audio;
      if (k === ' ' && !onButton) {
        e.preventDefault();
        if (tab === 'file') void a.toggleFile();
        else if (tab === 'tone') a.toggleTone();
        else if (a.state.mic.status === 'on') a.stopMic();
      } else if ((k === 'arrowleft' || k === 'arrowright') && tab === 'tone' && !onButton) {
        e.preventDefault();
        ui.set({ sweep: false });
        const st = (k === 'arrowright' ? 1 : -1) * (e.shiftKey ? 12 : 1);
        a.setToneFreq(a.state.tone.freq * Math.pow(2, st / 12));
      } else if (k === 'p') setParams({ paused: !params.paused });
      else if (k === 's') void exp.savePNG();
      else if (k === 'f') toggleFullscreen();
      else if (k === 'r') exp.scatter();
      else if (k === 'a') ui.set({ panelOpen: !ui.get().panelOpen, helpOpen: false });
      else if (k === '?') ui.set({ helpOpen: !ui.get().helpOpen, panelOpen: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exp]);

  // drag & drop audio anywhere
  useEffect(() => {
    if (!exp) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const f = e.dataTransfer?.files[0];
      if (!f) return;
      if (f.type && !f.type.startsWith('audio/') && !f.type.startsWith('video/')) {
        toast('That file doesn’t look like audio.');
        return;
      }
      exp.begin();
      exp.audio.loadFile(f);
      ui.set({ tab: 'file', welcome: false });
      toast(`“${f.name}” is ready. Press play.`);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [exp]);

  return (
    <ExperienceContext.Provider value={exp}>
      <main
        ref={stageRef}
        aria-label="Vibrating plate. Touch or drag to stir the sand."
        className="fixed inset-0 touch-none bg-black"
      />
      {renderer !== 'none' && <Bolt />}
      {renderer === 'none' && <NoRenderer />}
      <div inert={titled} className={cx('transition-opacity duration-700', titled ? 'opacity-0' : 'opacity-100')}>
        <TopBar />
        <Details />
        <Dock />
      </div>
      <AdjustPanel />
      <Intro />
      <FileInput />
      <Welcome />
      <Help />
      <DropOverlay active={dragging} />
      <Toast />
      <Loader />
    </ExperienceContext.Provider>
  );
}
