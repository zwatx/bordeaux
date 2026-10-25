import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WindowMenu, WindowMenuEntry } from '../../shared/windowChrome';

export function WindowsApplicationMenu({ api, initial, anchor, onClose }: {
  api: NonNullable<Window['bordeauxAPI']>; initial: WindowMenu; anchor: HTMLElement; onClose: (restore?: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<WindowMenuEntry[] | null>(null);
  const [trail, setTrail] = useState<WindowMenuEntry[]>([]);
  const [error, setError] = useState('');
  const current = trail.at(-1)?.children || items || [];
  const load = () => { setError(''); return api.getWindowMenu().then(value => {
    setItems(value); const entry = value.find(item => item.id === 'chrome-' + initial); setTrail(entry ? [entry] : []);
  }).catch(() => setError('Menu unavailable. Try again.')); };
  useEffect(() => { let live = true; api.getWindowMenu().then(value => {
    if (!live) return; setItems(value); const entry = value.find(item => item.id === 'chrome-' + initial); setTrail(entry ? [entry] : []);
  }).catch(() => { if (live) setError('Menu unavailable. Try again.'); }); return () => { live = false; }; }, [api, initial]);
  useLayoutEffect(() => {
    const element = ref.current!;
    element.showPopover();
    const rect = anchor.getBoundingClientRect();
    element.style.top = rect.bottom + 4 + 'px';
    element.style.left = Math.max(8, Math.min(rect.right - element.offsetWidth, window.innerWidth - element.offsetWidth - 8)) + 'px';
    const toggle = (event: Event) => { if ((event as ToggleEvent).newState === 'closed') onClose(false); };
    element.addEventListener('toggle', toggle);
    return () => element.removeEventListener('toggle', toggle);
  }, []);
  useLayoutEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }, [items, trail, error]);
  const activate = (item: WindowMenuEntry) => {
    if (item.children) { setTrail([...trail, item]); return; }
    // Return focus before the command runs, so its own dialog may claim it.
    anchor.focus();
    void api.activateWindowMenu(item.token).then(() => onClose(false)).catch(() => { setError('Menu changed. Open it again.'); });
  };
  return <div ref={ref} {...{ popover: 'auto' }} className="windows-app-menu" role="menu" aria-label={trail.at(-1)?.label || 'Application'}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onClose(true); }
      else if (event.key === 'Tab') onClose(false);
      else if (event.key === 'ArrowLeft' && trail.length) { event.preventDefault(); setTrail(trail.slice(0, -1)); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      } else if (event.key === 'ArrowRight') { const item = current.find(item => item.token === (document.activeElement as HTMLElement)?.dataset.menuToken); if (item?.children) { event.preventDefault(); activate(item); } }
    }}>
    {trail.length > 0 && <button type="button" role="menuitem" className="windows-menu-back" aria-label={'Back to ' + (trail.at(-2)?.label || 'Application')} onClick={() => setTrail(trail.slice(0, -1))}>‹ <span>{trail.at(-1)!.label}</span></button>}
    {error ? <><p role="status">{error}</p><button type="button" role="menuitem" onClick={() => void load()}>Try again</button></> : !items ? <p role="status">Loading menu…</p> : current.map(item => item.separator ? <hr key={item.token} /> :
      <button key={item.token} type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked}
        aria-haspopup={item.children ? 'menu' : undefined} disabled={!item.enabled} data-menu-token={item.token} onClick={() => activate(item)}>
        <span>{item.checked ? '✓ ' : ''}{item.label}</span><span className="windows-menu-meta">{item.children ? '›' : item.accelerator}</span>
      </button>)}
  </div>;
}
