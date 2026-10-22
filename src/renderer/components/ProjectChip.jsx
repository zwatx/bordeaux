import * as React from 'react';
import { UI } from './ui';
import { shortcutLabel } from '../lib/shortcuts';
import { changedSourceFact, firstFact, receiptTime, saveFixes, shortFact } from '../lib/projectLifecycle';
import '../styles/project.css';

const h = React.createElement;
const RobotCodeSourcesDialog = React.lazy(() => import("./RobotCodeSourcesDialog"));
const { Icon } = UI;
const { useEffect, useRef, useState } = React;

// The plain-fact helpers live with the lifecycle helpers (no import cycle); existing imports from here keep working.
export { firstFact, shortFact };

/** Folder that holds `folder`, with the home directory abbreviated, so same-named projects stay distinguishable. */
export function parentLocation(folder) {
  const trimmed = (folder || '').replace(/[\\/]+$/, '');
  return homeRelative(trimmed.slice(0, Math.max(trimmed.search(/[\\/][^\\/]*$/), 0)) || trimmed);
}
export const homeRelative = (place) => place.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=$|[\\/])/, '~');

const WORD = { saved: 'Saved', saving: 'Saving', unsaved: 'Not saved', failed: 'Not saved', recovered: 'Recovered' };
// Main's receipt time for a recovery copy, with seconds as departure surfaces show it.
const receiptClock = (iso) => receiptTime(iso, { seconds: true });

// The desktop bridge keeps this explicit action separate from browser permission grants.
async function copyText(text) {
  if (typeof window.bordeauxAPI?.copyProjectDetails === 'function') {
    try { await window.bordeauxAPI.copyProjectDetails(text); return true; } catch { return false; }
  }
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const area = document.createElement('textarea');
  area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
  document.body.appendChild(area); area.select();
  const copied = document.execCommand('copy');
  area.remove();
  return copied;
}

// "Saving" appears only once an actual write has run for 400 ms, so the autosave debounce and quick writes
// keep the quiet unsaved star instead of flashing a progress word.
function useShownStatus(status, writing) {
  const [shown, setShown] = useState(status === 'saving' ? 'saved' : status);
  useEffect(() => {
    if (status !== 'saving') { setShown(status); return undefined; }
    if (!writing) return undefined;
    const timer = setTimeout(() => setShown('saving'), 400);
    return () => clearTimeout(timer);
  }, [status, writing]);
  return shown;
}

// The project is a quiet name and one status word. Its menu holds the save fixes, project commands and
// the linked robot code, which stays a separate thing from the project and from the robot destination.
export function ProjectChip({ name, folderPath, status, writing, saveError, attempt, sourceChange, reloadError, showFailure, reloadKept, notice, recovery, recoveredFrom, bdxPending, bdxError, bdxDetails, robotCode, actions }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState('');
  const [sources, setSources] = useState(null), [showRecentCode, setShowRecentCode] = useState(false);
  const root = useRef(null), trigger = useRef(null), menu = useRef(null);
  const shown = useShownStatus(status, writing);
  const unsaved = status !== 'saved';
  const close = (restoreFocus) => { setOpen(false); if (restoreFocus) trigger.current?.focus(); };
  // A Show file failure that arrived after the menu closed is shown in the next open menu, then retired when it closes.
  const shownFailure = useRef(null);
  useEffect(() => {
    if (open) { if (showFailure) shownFailure.current = showFailure; return; }
    if (shownFailure.current) { const seen = shownFailure.current; shownFailure.current = null; actions.showFailureSeen?.(seen); }
  }, [open, showFailure]);
  useEffect(() => {
    if (!open) return undefined;
    menu.current?.querySelector('button')?.focus();
    const away = (event) => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const item = (label, callback, shortcut, props) => h('button', { type: 'button', role: 'menuitem', tabIndex: -1, ...props, onClick: () => { close(true); callback(); } },
    h('span', null, label), shortcut && h('span', { className: 'project-menu-shortcut', 'aria-hidden': true }, shortcut));
  const linked = robotCode.status === 'ready' || robotCode.status === 'stale';
  // A refresh keeps a linked menu's rows in place (disabled) while its code loads again.
  const codeLoading = robotCode.status === 'loading' || robotCode.operation === 'refresh';
  // Catalog work keeps running after the menu closes; its progress is shown in the menu and announced from the chip.
  const codeWork = codeLoading ? 'Loading…' : robotCode.operation === 'build' ? 'Building command catalog…'
    : robotCode.operation === 'inspect' ? 'Inspecting command inputs…' : '';
  // A replaced catalog retires its Sources dialog. Focus returns to the chip only if it fell to the page with the dialog.
  useEffect(() => {
    if (!sources || sources === robotCode.catalog) return undefined;
    setSources(null);
    if ((!document.activeElement || document.activeElement === document.body) && !document.querySelector('dialog[open]')) trigger.current?.focus();
    return undefined;
  }, [sources, robotCode.catalog]);
  const inspection = robotCode.catalog?.labviewDiscovery?.inspection;
  const codeFact = robotCode.error || robotCode.wrapperError || (inspection?.status === 'stale' || inspection?.status === 'unavailable' ? inspection.reason : '');
  const storageFull = recovery?.status === 'failed' && recovery.code === 'capacity';
  const again = status === 'failed' && attempt > 1;
  // Copy details stays in the menu and confirms in place, so the result is visible and announced.
  const copyDetails = (text) => h('button', { type: 'button', role: 'menuitem', tabIndex: -1, 'data-fix': true, 'data-action': 'copy-details',
    onClick: () => { void copyText([name, folderPath, text].filter(Boolean).join('\n')).then((ok) => setCopied(ok ? 'Copied' : 'Copy failed')); } },
    // The label swap keeps the button's width (the longer label reserves it).
    h('span', { className: 'project-menu-swap', 'data-reserve': 'Copy details' }, copied || 'Copy details'));
  useEffect(() => { if (!copied) return undefined; const timer = setTimeout(() => setCopied(''), 1600); return () => clearTimeout(timer); }, [copied]);
  const bdxCause = bdxDetails?.cause ? (bdxDetails.partial ? 'Some BDX files may be out of date · ' : '') + firstFact(bdxDetails.cause) : '';
  // With the chip as the only save surface, failures are also announced; the menu's alerts exist only while it is open.
  // A repeated failure changes the text (with its try number), so even an instant failed Retry is announced again.
  const cause = changedSourceFact(sourceChange) || shortFact(saveError);
  const announcement = status === 'recovered' ? name + ' is recovered and not in a folder yet' : again ? name + ' still isn’t saved (try ' + attempt + '): ' + cause
    : status === 'failed' ? name + ' isn’t saved: ' + cause : bdxError ? name + ' saved; BDX files failed' + (bdxCause ? ': ' + bdxCause : '') : '';
  const failure = status === 'failed' && saveFixes({ saveError, attempt, sourceChange, reloadError, showFailure: showFailure?.fact, canReload: Boolean(actions.reloadSource), canShow: Boolean(actions.showSource) });
  const FIX = { 'reload-source': () => item('Reload from disk', actions.reloadSource, null, { 'data-fix': true, 'data-action': 'reload-source' }),
    'show-source': () => item('Show file', actions.showSource, null, { 'data-fix': true, 'data-action': 'show-source' }),
    retry: () => item('Retry', actions.retrySave, null, { 'data-fix': true }), 'save-copy': () => item('Save copy…', actions.saveCopy, null, { 'data-fix': true }),
    'copy-details': () => copyDetails(saveError) };
  return h('div', { ref: root, className: 'project-control', onBlur: (event) => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  } },
    h('button', { ref: trigger, type: 'button', className: 'project-chip', 'data-status': shown, 'aria-haspopup': 'menu', 'aria-expanded': open,
      'aria-controls': open ? 'project-menu' : undefined, 'aria-busy': status === 'saving' || (status === 'failed' && writing) || undefined, title: folderPath || name,
      onClick: () => setOpen(!open), onKeyDown: (event) => {
        if ([' ', 'Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) event.stopPropagation();
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
      } },
      // Two lines in a fixed slot: the name, then its status. Status changes never move the toolbar; both lines
      // truncate visually but stay whole in the button's accessible name and in the menu.
      h('span', { className: 'project-chip-name' }, name),
      h('span', { className: 'project-chip-chevron', 'aria-hidden': true }, h(Icon, { name: 'chevron', size: 12 })),
      h('span', { className: 'project-chip-meta' },
        // Keyed by try, action and cause, so every new failure replays its acknowledgment.
        h('span', { key: shown === 'failed' ? (attempt || 1) + ':' + (notice?.key || 0) + ':' + saveError : shown, className: 'project-chip-status' },
          unsaved && h('span', { className: 'project-chip-unsaved', 'aria-hidden': true }, h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }, h('path', { d: 'M5 0v10M.67 2.5l8.66 5M.67 7.5l8.66-5' }))),
          shown === 'saved' && unsaved ? 'Unsaved' : WORD[shown]),
        bdxError && !bdxPending && h('span', { className: 'project-chip-bdx' }, 'BDX failed'),
        // The source is saved; the generated BDX files are still being rewritten (not yet current for Git or Push).
        bdxPending && h('span', { className: 'project-chip-bdx-pending' }, 'Updating BDX'))),
    h('span', { className: 'sr-only', role: 'status' }, announcement),
    // Outcomes of menu actions that finish after the menu closed (Reload, Show file); keyed so a repeat is announced again.
    h('span', { className: 'sr-only', role: 'status' }, notice?.text ? h('span', { key: notice.key }, notice.text) : null),
    h('span', { className: 'sr-only', role: 'status' }, codeWork && codeWork !== 'Loading…' ? 'Robot code: ' + codeWork : ''),
    sources && sources === robotCode.catalog && h(React.Suspense, { fallback: null }, h(RobotCodeSourcesDialog, { catalog: sources, onClose: () => { setSources(null); trigger.current?.focus(); } })),
    open && h('div', { ref: menu, id: 'project-menu', className: 'project-menu', role: 'menu', 'aria-label': 'Project',
      onKeyDown: (event) => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(true); }
        if (event.key === 'Tab') close(true);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const buttons = [...menu.current.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      } },
      h('div', { className: 'project-menu-heading', role: 'presentation' }, h('strong', null, name),
        // The parent location tells same-named projects apart; it truncates from the start, and the marks keep a leading slash in place.
        // The location line is start-truncated with its full path as the title; sentences about state are plain left-to-right text.
        folderPath ? h('span', { className: 'project-menu-location', title: folderPath }, '‎' + parentLocation(folderPath) + '‎')
          : recoveredFrom ? h('span', { className: 'project-menu-receipt' }, 'Recovered from ', h('bdi', null, recoveredFrom.origin?.kind === 'untitled' ? 'Untitled' : parentLocation(recoveredFrom.origin?.folderPath)),
            ' · ', h('time', { dateTime: recoveredFrom.capturedAt }, receiptClock(recoveredFrom.capturedAt)))
          : h('span', null, 'Not in a folder yet'),
        // While the source isn't saved, the last recovery copy main confirmed (or why there is none).
        status !== 'saved' && status !== 'saving' && recovery && h('span', { className: 'project-menu-receipt' }, recovery.status === 'saved'
          ? h(React.Fragment, null, 'Recovery copy · ', h('time', { dateTime: recovery.at }, receiptClock(recovery.at)))
          : recovery.fact ? 'No recovery copy · ' + recovery.fact : 'No recovery copy yet'),
        // After Reload from disk: when the edits it kept were captured; they are in Recovered edits.
        reloadKept && h('span', { className: 'project-menu-receipt' }, 'Edits before reload · ', h('time', { dateTime: reloadKept.at }, receiptClock(reloadKept.at)))),
      reloadKept && actions.recoveredEdits && h('div', { className: 'project-menu-fixes', role: 'presentation' }, item('Recovered edits…', actions.recoveredEdits, null, { 'data-fix': true, 'data-action': 'recovered-edits' })),
      // Full recovery storage is a fact with one fix in every status (a saved project's chip face stays Saved).
      storageFull && (status === 'saved' || status === 'saving') && h('div', { className: 'project-menu-fact project-menu-pending', role: 'status' }, recovery.fact),
      storageFull && actions.manageRecoveries && h('div', { className: 'project-menu-fixes', role: 'presentation' }, item('Manage…', actions.manageRecoveries, null, { 'data-fix': true, 'data-action': 'manage-recoveries' })),
      // The raw detail stays a title on the text, not the alert's accessible name; Copy details reaches it by keyboard.
      failure && h('div', { className: 'project-menu-fact', role: 'alert' }, h('span', { title: saveError }, failure.fact)),
      failure && h('div', { className: 'project-menu-fixes', role: 'presentation' }, ...failure.fixes.map((fix) => h(React.Fragment, { key: fix }, FIX[fix]()))),
      bdxPending && h('div', { className: 'project-menu-fact project-menu-pending', role: 'status' }, 'Project saved · Updating BDX files'),
      bdxError && !bdxPending && h('div', { className: 'project-menu-fact', role: 'alert' }, h('span', { title: bdxError }, 'Project saved · BDX files failed'),
        bdxCause && h('span', { className: 'project-menu-cause' }, bdxCause)),
      bdxError && !bdxPending && h('div', { className: 'project-menu-fixes', role: 'presentation' }, item('Retry BDX', actions.retrySave, null, { 'data-fix': true }), copyDetails(bdxError)),
      status === 'recovered' && h('div', { className: 'project-menu-fixes', role: 'presentation' }, item('Save copy…', actions.saveCopy, null, { 'data-fix': true })),
      item('Projects…', actions.projects, shortcutLabel('O')),
      item('New project…', actions.create, shortcutLabel('N')),
      // A recovered draft's one save action is its fix row's Save copy….
      status !== 'recovered' && h('hr'),
      status !== 'recovered' && item(folderPath ? 'Save' : 'Save…', actions.save, shortcutLabel('S'), { 'data-action': 'save' }),
      status !== 'recovered' && item('Save copy…', actions.saveCopy, shortcutLabel('S', { shift: true })),
      h('hr'),
      // The robot code's state is the Link/Change item's second line, so it reads as status rather than a dimmed row.
      h('button', { type: 'button', role: 'menuitem', tabIndex: -1, className: 'project-menu-code', disabled: codeLoading, onClick: () => { close(true); actions.linkCode(); } },
        h('span', null, linked ? 'Change robot code…' : 'Link robot code…'),
        h('span', { className: 'project-menu-detail', title: robotCode.error || undefined, 'aria-busy': Boolean(codeWork) || undefined,
          'data-problem': (!codeWork && (robotCode.status === 'missing' || robotCode.status === 'error')) || undefined }, codeWork
          || (linked ? [robotCode.name, Number.isFinite(robotCode.commands) && robotCode.commands + ' command' + (robotCode.commands === 1 ? '' : 's')].filter(Boolean).join(' · ') || 'Linked'
          : robotCode.status === 'missing' ? 'Missing' : robotCode.status === 'error' ? 'Couldn’t load' : 'Not linked'))),
      robotCode.suggestion && item('Use ' + robotCode.suggestion.name, actions.useCode, null, { disabled: !!robotCode.operation }),
      linked && item('Refresh commands', actions.refreshCode, null, { disabled: !!robotCode.operation }),
      linked && actions.rescanCode && item('Rescan command inputs', actions.rescanCode, null, { disabled: !!robotCode.operation }),
      linked && robotCode.catalog?.conditions?.length > 0 && !robotCode.catalog.authoritative && item('Build catalog for conditions', actions.buildCode, null, { disabled: !!robotCode.operation }),
      linked && robotCode.catalog?.labviewDiscovery && item('View sources…', () => { if (!document.querySelector('dialog[open]')) setSources(robotCode.catalog); }),
      robotCode.recentProjects?.length > 0 && h('button', { type: 'button', role: 'menuitem', tabIndex: -1, 'aria-expanded': showRecentCode,
        onClick: () => setShowRecentCode(!showRecentCode) }, 'Recent robot code'),
      // Clones share a project name, so each recent shows its file and when it was last linked, visibly and in its name.
      showRecentCode && (robotCode.recentProjects || []).filter(project => project.id !== robotCode.bookmarkId).map(project => {
        const detail = [homeRelative(project.locationHint || project.folderName), project.lastLinkedAt && 'linked ' + receiptTime(project.lastLinkedAt)].filter(Boolean).join(' · ');
        return h(React.Fragment, { key: project.id }, item(project.projectName, () => actions.recentCode(project.id), detail,
          { className: 'project-menu-recent', disabled: !!robotCode.operation, 'aria-label': [project.projectName, detail].filter(Boolean).join(', ') }));
      }),
      codeFact && h('div', { className: 'project-menu-fact', role: robotCode.error ? 'alert' : 'status', title: codeFact }, firstFact(codeFact)),
      robotCode.notice && h('div', { className: 'project-menu-fact', role: 'status' }, robotCode.notice)));

}
