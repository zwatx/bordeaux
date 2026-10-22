import * as React from 'react';
import { firstFact } from '../lib/projectLifecycle';
import '../styles/app-update.css';

const h = React.createElement;
export function releaseNoteBlocks(text = '') {
  const blocks = [];
  let code = null;
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    if (/^```/.test(line)) { if (code) { blocks.push({ kind: 'code', text: code.join('\n') }); code = null; } else code = []; continue; }
    if (code) { code.push(line); continue; }
    if (!line.trim()) continue;
    const clean = line.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
    if (/^#{1,6}\s/.test(clean)) blocks.push({ kind: 'heading', text: clean.replace(/^#+\s*/, '') });
    else if (/^\s*(?:[-*]|\d+\.)\s/.test(clean)) blocks.push({ kind: 'item', text: clean.replace(/^\s*(?:[-*]|\d+\.)\s*/, '') });
    else blocks.push({ kind: 'paragraph', text: clean });
  }
  if (code) blocks.push({ kind: 'code', text: code.join('\n') });
  return blocks;
}
function noteInline(text) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) =>
    /^`[^`]+`$/.test(part) ? h('code', { key: index }, part.slice(1, -1))
      : /^\*\*[^*]+\*\*$/.test(part) ? h('strong', { key: index }, part.slice(2, -2)) : part);
}
function noteContent(blocks) {
  const content = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.kind === 'item') {
      const items = [h('li', { key: index }, noteInline(block.text))];
      while (blocks[index + 1]?.kind === 'item') {
        index += 1;
        items.push(h('li', { key: index }, noteInline(blocks[index].text)));
      }
      content.push(h('ul', { key: index }, items));
    } else content.push(h(block.kind === 'heading' ? 'h4' : block.kind === 'code' ? 'pre' : 'p',
      { key: index }, block.kind === 'code' ? block.text : noteInline(block.text)));
  }
  return content;
}
export const updateBytes = (bytes) => Number.isFinite(bytes) && bytes >= 0 ? `${(bytes / 1048576).toFixed(1)} MB` : '—';

// A Close that main has not answered in this long becomes a refusal with Try again; main acknowledges a retry of the
// same attempt idempotently, so a lost reply costs one more press, never a silent release.
const RESUME_BOUND_MS = 10_000;

export function AppUpdateDialog({ state, ownsDeparture, onClose, onEditingResumed, onCheck, onDownload, onCancel, onInstall, onOpenReleases, onCopyDetails }) {
  const dialog = React.useRef(null), returnFocus = React.useRef(null);
  const [copied, setCopied] = React.useState(false);
  // Closing a stalled install: { attempt, waiting } while main decides, or { attempt, fact } after a refusal.
  const [resuming, setResuming] = React.useState(null);
  const shownAttempt = React.useRef(null);
  // One modal at a time. A panel that becomes visible while another sheet is up (Projects, a departure) waits for it to
  // close and then appears; nothing is hidden or answered on its behalf. A panel already shown is never hidden here:
  // only main's state hides it (for a stalled install, after its accepted return to editing).
  const present = React.useCallback(() => {
    const node = dialog.current;
    if (node.open) return true;
    if ([...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')].some((other) => other !== node)) return false;
    returnFocus.current = document.activeElement; setCopied(false); setResuming(null); node.showModal();
    return true;
  }, []);
  // When App hands this panel an approved install's departure, the pending sheet unmounts in the same commit; open
  // before paint so no frame or queued key reaches the editor between the two modals. Other panels keep the wait below.
  React.useLayoutEffect(() => {
    if (ownsDeparture && state?.visible && dialog.current) present();
  }, [ownsDeparture, state?.visible, present]);
  React.useEffect(() => {
    const node = dialog.current;
    if (!node) return undefined;
    if (!state?.visible) {
      if (node.open) { node.close(); const back = returnFocus.current; (back?.isConnected && back !== document.body ? back : document.querySelector('.project-chip'))?.focus(); }
      return undefined;
    }
    if (present()) return undefined;
    // After the other sheet closes, wait a frame so its own focus return lands first; that element is where this panel returns.
    let frame = 0;
    const observer = new MutationObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { if (present()) observer.disconnect(); }); });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'aria-modal'] });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [state?.visible, present]);
  if (!state) return null;
  const { phase, version, currentVersion, progress, error } = state;
  const stalled = phase === 'installing' && state.installStalled;
  // Any other phase or attempt makes an earlier Close's answer obsolete; it can never hide a newer panel.
  const attempt = stalled ? 'stalled:' + (state.installAttemptId || '') : 'phase:' + phase;
  shownAttempt.current = attempt;
  const resume = resuming?.attempt === attempt ? resuming : null, waiting = Boolean(resume?.waiting);
  const busy = !stalled && ['checking', 'downloading', 'installing'].includes(phase);
  const title = stalled ? 'Restart delayed' : ({ available: 'Update available', downloading: 'Downloading update', downloaded: 'Ready to install', upToDate: 'You’re up to date', error: 'Update interrupted', unsupported: 'Manual update available', installing: 'Restarting Bordeaux', checking: 'Checking for updates' })[phase] || 'Software updates';
  const subtitle = resume?.fact ? 'Couldn’t return to editing · ' + resume.fact : waiting ? 'Returning to editing…'
    : stalled ? 'Keep working, or install manually from All releases.' : phase === 'error' ? firstFact(error) : phase === 'unsupported' ? 'Get the installer from All releases.' : '';
  const notes = releaseNoteBlocks(state.releaseNotes);
  const percent = Number.isFinite(progress?.percent) ? Math.min(100, Math.max(0, progress.percent)) : null;
  // Closing a stalled install hands editing back only once main accepts it for the attempt this panel shows (main
  // revokes that attempt's approval first). Until then the panel stays, busy; a refusal or failure keeps it with Try again.
  const close = () => {
    if (!stalled) { if (phase !== 'installing') onClose?.(); return; }
    if (!onEditingResumed) { onClose?.(); return; }
    if (waiting) return;
    const sent = attempt;
    setResuming({ attempt: sent, waiting: true });
    let settled = false, timer = 0;
    const finish = (result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (shownAttempt.current !== sent) return;
      if (result?.accepted === true) { setResuming(null); onClose?.(); return; }
      setResuming(result?.stale ? null : { attempt: sent, fact: result?.fact || 'Bordeaux didn’t confirm it' });
    };
    timer = setTimeout(() => finish({ accepted: false, fact: 'Bordeaux didn’t answer' }), RESUME_BOUND_MS);
    Promise.resolve().then(() => onEditingResumed(state.installAttemptId))
      .then(finish, (failure) => finish({ accepted: false, fact: firstFact(failure) || 'Bordeaux didn’t confirm it' }));
  };
  const hold = (onClick) => waiting ? undefined : onClick;
  const action = stalled ? { label: resume?.fact ? 'Try again' : 'Close', onClick: close } : phase === 'downloading' ? { label: 'Cancel download', onClick: onCancel }
    : phase === 'downloaded' ? { label: 'Restart and install', onClick: onInstall }
    : phase === 'available' ? { label: 'Download update', onClick: onDownload }
    : phase === 'error' ? {
        label: state.errorStage === 'install' ? 'Retry install' : state.errorStage === 'download' ? 'Retry download' : 'Try again',
        onClick: state.errorStage === 'install' ? onInstall : state.errorStage === 'download' ? onDownload : onCheck,
      }
    : phase === 'upToDate' || phase === 'unsupported' ? { label: 'Done', onClick: close }
    : !busy ? { label: 'Check for updates', onClick: onCheck } : null;
  // Escape is handled before the native close request (whose prevention the browser can ignore). An install panel that
  // closes natively anyway while main still shows it is reopened: only main's answer may hide it.
  return h('dialog', { ref: dialog, className: 'app-update-dialog', 'aria-labelledby': 'app-update-title', 'aria-busy': waiting || undefined,
    onKeyDown: (event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } },
    onCancel: (event) => { event.preventDefault(); close(); },
    onClose: () => { if (state.visible && phase === 'installing' && !dialog.current.open) dialog.current.showModal(); } },
    // The status is the title; the versions and any explanation sit directly beneath it.
    h('header', { className: 'app-update-header' },
      h('h2', { id: 'app-update-title', 'aria-live': phase === 'error' ? undefined : 'polite' }, title),
      h('button', { type: 'button', className: 'app-update-close', 'aria-label': 'Close updates', disabled: phase === 'installing' && !stalled, 'aria-disabled': waiting || undefined, onClick: close }, '×')),
    h('div', { className: 'app-update-summary' },
      h('p', { className: 'app-update-versions' }, `Installed ${currentVersion || '—'}`, version && version !== currentVersion ? ` → ${version}` : ''),
      !busy && subtitle && h('p', { className: 'app-update-description', role: phase === 'error' || resume?.fact ? 'alert' : waiting ? 'status' : undefined }, subtitle),
      busy && h('div', { className: 'app-update-transfer', 'aria-busy': true },
        h('progress', { max: 100, value: phase === 'downloading' && percent != null ? percent : undefined, 'aria-label': phase === 'downloading' ? 'Update download' : phase === 'checking' ? 'Checking for updates' : 'Installing update' }),
        phase === 'downloading' && h('div', { className: 'app-update-transfer-values' }, h('span', null, `${updateBytes(progress?.transferred)} of ${updateBytes(progress?.total)}`), h('span', null, percent == null ? '' : `${Math.round(percent)}%`), h('span', null, progress?.bytesPerSecond > 0 ? `${updateBytes(progress.bytesPerSecond)}/s` : '')))),
    h('section', { className: 'app-update-notes', 'aria-label': 'Release notes', tabIndex: 0 },
      notes.length ? noteContent(notes) : phase !== 'checking' && h('p', { className: 'app-update-empty' }, 'No release notes available.')),
    h('footer', { className: 'app-update-footer' },
      h('div', { className: 'app-update-secondary' }, h('button', { type: 'button', 'aria-disabled': waiting || undefined, onClick: hold(onOpenReleases) }, 'All releases'),
        phase === 'upToDate' && h('button', { type: 'button', onClick: onCheck }, 'Check again'),
        phase === 'error' && h('button', { type: 'button', onClick: async () => { await onCopyDetails?.(); setCopied(true); } }, copied ? 'Copied' : 'Copy details')),
      action && h('button', {
        type: 'button', className: phase === 'downloading' ? undefined : 'app-update-action', onClick: action.onClick, disabled: action.disabled, 'aria-disabled': waiting || undefined,
      }, action.label)));
}
