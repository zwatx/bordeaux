import '../styles/tooltips.css';

// One styled tooltip replaces the browser's native title popups everywhere. While the pointer is over an element with a
// title (or data-tip), the title is emptied so the native popup never opens, and put back when the pointer leaves.
// React may change or remove the title meanwhile: an observer follows both, so the tip stays current and a removed
// title is not restored. Keyboard focus shows the same tooltip.
const SHOW_DELAY_MS = 450;
const WARM_MS = 400;
const GAP = 6;
const EDGE = 8;

export function installTooltips(doc = document) {
  const view = doc.defaultView;
  const tip = doc.createElement('div');
  tip.className = 'tip';
  tip.id = 'app-tooltip';
  tip.setAttribute('role', 'tooltip');
  // A manual popover sits in the top layer, above modal dialogs.
  tip.popover = 'manual';
  doc.body.append(tip);
  // lifted: the hovered element and the title it had, or null once its owner removed it.
  let anchor = null, lifted = null, timer = 0, watch = 0, coolUntil = 0;

  const textOf = (el) => (el === lifted?.el ? lifted.title : el.getAttribute('title')) || el.getAttribute('data-tip') || '';
  const find = (target) => {
    for (let el = target instanceof view.Element ? target : null; el && el !== doc.body; el = el.parentElement) {
      if (el === tip) return null;
      if (textOf(el)) return el;
    }
    return null;
  };
  const isOpen = () => tip.matches(':popover-open');
  const place = () => {
    // Measure at the origin, where the tooltip has its full width, then move it beside the anchor.
    tip.style.left = tip.style.top = '0px';
    const r = anchor.getBoundingClientRect(), t = tip.getBoundingClientRect();
    const below = r.bottom + GAP + t.height <= view.innerHeight - EDGE || r.top - GAP - t.height < EDGE;
    tip.style.left = Math.round(Math.max(EDGE, Math.min(r.left + r.width / 2 - t.width / 2, view.innerWidth - t.width - EDGE))) + 'px';
    tip.style.top = Math.round(below ? r.bottom + GAP : r.top - GAP - t.height) + 'px';
    tip.dataset.side = below ? 'below' : 'above';
  };
  // Dismissing closes the tooltip but keeps the title emptied until the pointer leaves, so no native popup follows.
  const dismiss = () => {
    clearTimeout(timer); timer = 0;
    if (isOpen()) { tip.hidePopover(); coolUntil = Date.now() + WARM_MS; }
  };
  const refresh = () => {
    const text = anchor && textOf(anchor);
    if (!text) { dismiss(); return; }
    tip.textContent = text;
    if (isOpen()) place();
  };
  const observer = new view.MutationObserver(() => {
    if (lifted) {
      const title = lifted.el.getAttribute('title');
      if (title === null) lifted.title = null;
      else if (title !== '') { lifted.title = title; lifted.el.setAttribute('title', ''); }
    }
    refresh();
  });
  const hide = () => {
    dismiss();
    clearInterval(watch); watch = 0;
    observer.disconnect();
    if (lifted?.title && lifted.el.getAttribute('title') === '') lifted.el.setAttribute('title', lifted.title);
    lifted = null;
    if (anchor?.getAttribute('aria-describedby') === tip.id) anchor.removeAttribute('aria-describedby');
    anchor = null;
  };
  const show = () => {
    timer = 0;
    if (!anchor?.isConnected || !textOf(anchor)) return;
    tip.textContent = textOf(anchor);
    tip.showPopover();
    place();
  };
  const open = (el, viaPointer) => {
    if (el === anchor) return;
    hide();
    anchor = el;
    if (viaPointer && el.getAttribute('title')) {
      lifted = { el, title: el.getAttribute('title') };
      el.setAttribute('title', '');
    }
    tip.textContent = textOf(el);
    if (!viaPointer && !el.hasAttribute('aria-describedby')) el.setAttribute('aria-describedby', tip.id);
    observer.observe(el, { attributes: true, attributeFilter: ['title', 'data-tip'] });
    // Elements that vanish under a still pointer send no leave event.
    watch = setInterval(() => { if (!anchor?.isConnected) hide(); }, 250);
    if (Date.now() < coolUntil) show();
    else timer = setTimeout(show, SHOW_DELAY_MS);
  };
  // While the pointer holds a title, only leaving it restores the title; other closes just dismiss.
  const close = () => lifted ? dismiss() : hide();

  doc.addEventListener('pointerover', (event) => {
    if (event.pointerType === 'touch') return;
    const el = find(event.target);
    if (el) open(el, true);
    else if (anchor) hide();
  }, true);
  doc.addEventListener('pointerout', (event) => {
    if (anchor && !anchor.contains(event.relatedTarget)) hide();
  }, true);
  doc.addEventListener('focusin', (event) => {
    const el = find(event.target);
    if (el && !lifted && event.target.matches(':focus-visible')) open(el, false);
  });
  doc.addEventListener('focusout', (event) => { if (anchor && !lifted && anchor.contains(event.target)) hide(); });
  // A hovered tooltip closes on a press, Escape, scroll or zoom; a focus tooltip on any key.
  doc.addEventListener('pointerdown', close, true);
  doc.addEventListener('keydown', (event) => { if (!lifted || event.key === 'Escape') close(); }, true);
  doc.addEventListener('scroll', close, true);
  doc.addEventListener('wheel', close, { capture: true, passive: true });
  view.addEventListener('blur', close);
  view.addEventListener('resize', close);
}
