import { TOOL_SHORTCUTS } from '../components/KeyboardHelp';
import { createLibraryDurations } from "../lib/libraryDurations";
import { DeletionNotice } from "../components/DeletionNotice";
import { FieldStatus } from "../components/FieldStatus";
import * as React from "react";
import { flushSync } from "react-dom";
import { FinalPlanning } from "../assets/final-planning";
import { isPlaybackSpace } from "../lib/shortcuts";
import { PathEdit } from "../assets/path-edit";
import { PathPreview } from "../assets/path-preview";
import { liveEditingPreview } from "../assets/editing-planning";
import { PathOptimization } from "../assets/path-optimization";
import { OptimizationPanel } from "../components/OptimizationPanel";
import { authoredPath, isOptimizationOutdated, optimizationInputKey } from "../../shared/planners/acceptedTrajectoryIdentity";
import { routeInputKey } from "../../shared/planners/routeIdentity";
import { stageAcceptedRouteTrajectory } from "../../shared/planners/acceptedRouteStaging";
import { durationResult } from "../lib/finalPlanningResult";
import { editablePath } from "../lib/editablePath";
import { createAgentSessionSync } from "../lib/agentSessionSync";
import { ContextInspector, commandArguments } from "../components/ContextInspector";
import { FIELD_DIMS, FieldView } from "../components/FieldView";
import { FIELD_IMAGE } from "../../shared/field/imageCalibration";
import { Panels } from "../components/Panels";
import { ProjectChip, firstFact, shortFact } from "../components/ProjectChip";
import { DepartureHint, ProjectDeparture, ProjectPending, ProjectsDialog } from "../components/ProjectsDialog";
import { checkpointMatch, createCheckpointChannel, createPersistenceQueue, departureCopy, lifecycleApi, readOfferedRecoveries, recoveryAfterListing, recoveryOutcome, reloadFromDisk, reloadRecovery,
  rememberOfferedRecoveries, sameContext, sameDocument, showProjectSource, sourceChangeOf, sourceFact, unofferedRecoveries } from "../lib/projectLifecycle";
import { useProjectDeparture } from "../hooks/useProjectDeparture";
import { AppUpdateDialog } from "../components/AppUpdateDialog";
import { useAppUpdates } from "../components/useAppUpdates";
import { RobotPage } from "../components/RobotPage";
import { DiagnosticBundleDialog } from "../components/DiagnosticBundleDialog";
import { LibraryRail, referencingRoutines } from "../components/EditorLibrary";
import { RobotPushDialog, useRobotPushController } from "../components/RobotPushDialog";
import { RoutineTransport, StepInspector } from "../components/RoutineInspector";
import { RoutinePanel } from "../components/RoutinePanel";
import { RoutineWorkspace } from "../components/RoutineWorkspace";
import { UI } from "../components/ui";
import { PM } from "../lib/pathMath";
import { agentProposalMatchesPublishedContext } from "../lib/agentProposalContext";
import { PathLinks } from "../lib/pathLinks";
import {
  PROJECT_SCOPE, ROUTINE_SCOPE, applyProjectEntry, captureProjectChange, createUndoHistory, deleteFolder, linkedPathIds,
  pathScope, undoScopes, withLibraryFields,
} from "../lib/undoHistory";
import { AUTO } from "../lib/routineModel";
import { focusIfAvailable } from "../lib/focusReturn";
import { clearCommandPick, commandPickRequest, retireCommandPick } from "../lib/commandPick";
import { commitFocusedDraft, enqueuePersistenceAfterPreflight, flushFocusedProjectDraft, hasProjectInputDraft, noteProjectDraftInput, projectFolderName, projectPersistenceStayedCurrent } from "../lib/draftPersistence";
import { reconcileSavedRobotLink, withRobotLink } from "../lib/projectRobotLink";
import { UnitPrefs } from "../lib/unitPreferences";
import {
  createMarkerId as markerId,
  createPathId as pathId,
  createPathLinkId as pathLinkId,
  createRoutineId as routineId,
} from "../../shared/project/ids";
import { normalizeProject as normalizeProjectData } from "../../shared/project/normalize";
import { promoteRoutineProjectSchema } from "../../shared/project/routineSchema";
import { robotValueSchemasEqual } from "../../shared/robotValueSchema";
import { blankPath, buildWaypoints as buildWps, clampWorldPoint as clampWorld, clone } from "../../shared/project/defaults";
import { blankProject, blankRoutine, freshProject, routineState, uniqueItemName, withRoutineState } from "../lib/editorProject";
import { alignWaypointHandles, duplicateWaypoint, moveWaypointTo, removeWaypoint, remapWaypointRanges, reorderWaypoint, setWaypointFacing, reversePath as reversePathDraft } from "../lib/pathEditing";
import { createPlaybackStore } from "../lib/playbackStore";
import { createPathHoverStore } from "../lib/pathHoverStore";
import { useRoutinePlanning } from "../hooks/useRoutinePlanning";
import { useEditingPlanning } from "../hooks/useEditingPlanning";
import { useOptimizerComparison } from "../hooks/useOptimizerComparison";
import { usePushSelection } from "../hooks/usePushSelection";
import { PushControl } from "../components/PushControl";
import { PointerDrag } from "../hooks/usePointerDrag";
import { PathPanel } from "../components/PathPanel";
import { PathTimeline, PathHoverReadout } from "../components/PathTimeline";
import { buildTimeline, tAtF } from "../components/pathTimelineModel";

  const { useState, useRef, useEffect, useMemo, useCallback, useSyncExternalStore } = React;
  const h = React.createElement;
  const { FIELD_W, FIELD_H, IMG_W, IMG_H } = FIELD_DIMS;
  const PERSEG = 56;
  function operationErrorMessage(error) {
    const message = error && error.message ? error.message : String(error);
    return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  }
  function normalizeProject(raw) {
    return PathLinks.reconcile(normalizeProjectData(raw));
  }
  function duplicatePathForLibrary(source, name) {
    const duplicate = clone(source);
    duplicate.id = pathId();
    duplicate.name = name;
    duplicate.markers = duplicate.markers.map((marker) => ({ ...marker, id: markerId() }));
    return duplicate;
  }

  function currentPathLength(derivation) {
    const length = derivation?.current ? derivation.value?.sample?.length : null;
    return Number.isFinite(length) ? length : null;
  }

  function selectedAgentProposalPreview(snapshot, candidate, request, plannerId) {
    if (snapshot.status !== 'ready' || !candidate?.path || snapshot.key !== request
      || snapshot.path !== candidate.path || snapshot.value?.planner !== plannerId) return [];
    return [{ id: candidate.id, label: candidate.label, selected: true, valid: candidate.valid !== false, derived: snapshot.value }];
  }

  function agentProposalPreviewResult(snapshot, candidate, request, plannerId) {
    const previews = selectedAgentProposalPreview(snapshot, candidate, request, plannerId);
    const failed = Boolean(snapshot.status === 'error' && candidate?.path
      && snapshot.errorKey === request && snapshot.errorPath === candidate.path);
    return { previews, ready: previews.length === 1, pending: Boolean(candidate?.path) && previews.length === 0 && !failed, error: failed ? snapshot.error : null };
  }

  function canApplyAgentProposalCandidate(proposal, candidate, preview) {
    if (!proposal || proposal.status !== 'ready') return false;
    if (proposal.operation === 'configureRobot') return true;
    return Boolean(candidate?.path && candidate.valid !== false && preview.ready);
  }

  function requestWaypointPreview(previewer, request, robot, plannerId) {
    return previewer.request({ key: request, path: request.doc, robot, plannerId, quality: 'final' });
  }

  function waypointPreviewResult(snapshot, request) {
    if (!request) return null;
    const value = snapshot.status === 'ready' && snapshot.key === request && snapshot.path === request.doc ? snapshot.value : null;
    const failed = snapshot.errorKey === request && snapshot.errorPath === request.doc;
    return { ...request, derived: value || null, error: failed ? snapshot.error : null, pending: !value && !failed };
  }

  // Field selection is near-white: "what you're touching" without competing with alliance colors or the speed ramp.
  const ACCENT = 'oklch(0.95 0.004 106)';

  const PENDING_PATH_PREVIEW = {
    sample: { pts: [], length: 0 },
    prof: { totalTime: 0 },
    metrics: { head: [] },
    anchors: [],
    checks: [],
    wpFrac: [],
    wpIdx: [],
    effRanges: [],
    mode: 'swerve',
    rev: false,
  };

  const FIT = { x: FIELD_IMAGE.left - 90, y: FIELD_IMAGE.top - 90, w: FIELD_IMAGE.right - FIELD_IMAGE.left + 180, h: FIELD_IMAGE.bottom - FIELD_IMAGE.top + 180 };

  const usePlayback = (store) => useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  /**
   * What the editor shows for the active path: a live draft preview while a pointer edit runs, the
   * finished draft until its committed derivation arrives, else the committed derivation. The field
   * and the band share one previewer; only the field requests, so a drag costs one preview job.
   * A draft the worker has solved shows exactly its release value; until then the live draft geometry
   * is timed by the newest solved trace, so the edited point follows the pointer.
   */
  function useEditPreview({ editStore, previewer, doc, derived, derivedPath, robot, field, plannerId, request }) {
    const draft = useSyncExternalStore(editStore.subscribe, editStore.getSnapshot, editStore.getSnapshot);
    const editBase = useRef(null);
    const [preview, setPreview] = useState(() => previewer.getSnapshot());
    useEffect(() => previewer.subscribe(() => setPreview(previewer.getSnapshot())), [previewer]);
    useEffect(() => {
      if (request && draft) previewer.request({ key: draft.id, path: draft, robot, field, plannerId, quality: 'interactive' });
    }, [previewer, request, draft, robot, field, plannerId]);
    if (draft && !editBase.current) editBase.current = doc;
    const finished = !draft && editStore.getLastResolution() === 'finish';
    const bridgeFinishedEdit = finished && editBase.current && (editBase.current === doc || derivedPath !== doc);
    if (!draft && (!finished || (derivedPath === doc && editBase.current !== doc))) editBase.current = null;
    const solved = preview.value?.derived;
    const target = draft || (bridgeFinishedEdit ? doc : null);
    // Before this edit's first solve, the committed release timing seeds the live geometry.
    const source = target && solved?.planner === plannerId && preview.path?.id === target.id ? { path: preview.path, value: solved }
      : draft && derived?.planner === plannerId ? { path: derivedPath || doc, value: derived } : null;
    const sourcePath = source?.path, sourceValue = source?.value;
    const value = useMemo(() => target && sourceValue ? liveEditingPreview(target, robot, sourcePath, sourceValue) : null,
      [target, robot, sourcePath, sourceValue]);
    const displayed = value ? { path: target, value } : { path: derivedPath || doc, value: derived };
    return { draft, displayed, interactionReady: displayed.path === (draft || doc) };
  }
  function EditablePlaybackField({ store, fieldDoc, ...props }) {
    const playback = usePlayback(store);
    return h(FieldView, { ...props, doc: fieldDoc, playTime: playback.time });
  }
  /** One displayed result owns the field, timeline and transient problem selection. */
  function PathWorkspace({ rootRef, children, editStore, previewer, doc, derived, derivedPath, robot, field, plannerId, actions, sel, playbackStore,
    issues = [], timingPending = false, stale = false, flushDraft }) {
    const { draft, displayed, interactionReady } = useEditPreview({ editStore, previewer, doc, derived, derivedPath, robot, field, plannerId, request: true });
    // Authored values follow the live draft; timing follows what the field shows for it.
    const source = draft || doc;
    const value = displayed.value || derived;
    const fresh = useMemo(() => buildTimeline(value), [value]);
    // While a change is re-timed, the last timing and problems for this path stay drawn, dimmed. They are
    // display only: status, durations and push never read them. Another path never inherits them, and a
    // failed timing job shows no timing rather than an older one.
    const held = useRef({ id: null, tl: null, issues: [] });
    if (held.current.id !== doc.id) held.current = { id: doc.id, tl: null, issues: [] };
    if (!fresh.empty) held.current = { ...held.current, id: doc.id, tl: fresh };
    if (!timingPending) held.current = { ...held.current, id: doc.id, issues };
    const keepTiming = fresh.empty && timingPending && held.current.id === doc.id && held.current.tl;
    const tl = keepTiming ? held.current.tl : fresh;
    const hoverStore = useMemo(() => createPathHoverStore(), []);
    const hoverPresses = useRef(new Set());
    const hoverContext = useMemo(() => ({
      eligible: !draft && !timingPending && !stale && !keepTiming && interactionReady
        && displayed.path === doc && displayed.value === derived && tl === fresh && !tl.empty
        && value.sample?.pts?.length > 1 && Number.isFinite(tl.total) && tl.total > 0,
      total: tl.total,
      ready: () => hoverPresses.current.size === 0 && !document.querySelector('dialog:modal, [role="dialog"][aria-modal="true"]'),
    }), [draft, timingPending, stale, keepTiming, interactionReady, displayed.path, displayed.value, doc, derived, tl, fresh, value]);
    React.useLayoutEffect(() => {
      hoverStore.activate(hoverContext);
      return () => hoverStore.deactivate(hoverContext);
    }, [hoverStore, hoverContext]);
    React.useLayoutEffect(() => {
      const release = event => { hoverPresses.current.delete(event.pointerId); };
      const blur = () => { hoverPresses.current.clear(); hoverStore.clear(); };
      const modalSelector = 'dialog:modal, [role="dialog"][aria-modal="true"]';
      const containsModal = node => node.matches?.(modalSelector) || node.querySelector?.(modalSelector);
      const observer = new MutationObserver(records => {
        // Also retire a modal opened and closed in the same task before this observer runs.
        if (document.querySelector(modalSelector)
          || records.some(record => record.attributeName === 'open' && record.oldValue !== null
            || record.attributeName === 'aria-modal' && record.oldValue === 'true'
            || record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(containsModal))) hoverStore.clear();
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['open', 'aria-modal', 'role'] });
      window.addEventListener('pointerup', release, true);
      window.addEventListener('pointercancel', release, true);
      window.addEventListener('lostpointercapture', release, true);
      window.addEventListener('blur', blur);
      return () => {
        observer.disconnect(); blur();
        window.removeEventListener('pointerup', release, true);
        window.removeEventListener('pointercancel', release, true);
        window.removeEventListener('lostpointercapture', release, true);
        window.removeEventListener('blur', blur);
      };
    }, [hoverStore]);
    const shownIssues = timingPending && held.current.id === doc.id ? held.current.issues : issues;
    const issuesStale = timingPending && shownIssues.length > 0;
    const [issueSelection, setIssueSelection] = useState(null);
    // A new result can put another problem at the same index, even with the same code.
    const issueIndex = !sel.kind && issueSelection?.[0] === shownIssues ? issueSelection[1] : null;
    // The workspace remounts for another path/project. Clear replaced lists permanently, including comparisons.
    useEffect(() => {
      setIssueSelection(choice => sel.kind || choice?.[0] !== shownIssues ? null : choice);
    }, [shownIssues, sel.kind, sel.idx]);
    useEffect(() => {
      if (issueIndex == null) return undefined;
      const onKey = (event) => { if (event.key === 'Escape' && !event.defaultPrevented) setIssueSelection(null); };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [issueIndex]);
    const issue = shownIssues[issueIndex] || null;
    const problemContext = useRef(null);
    problemContext.current = { issues: shownIssues, tl, timed: !timingPending && !draft && interactionReady && !stale };
    const inspectIssues = () => flushDraft() && problemContext.current.issues === shownIssues;
    const selectIssue = (index) => {
      if (!shownIssues[index] || !inspectIssues()) return false;
      // A focused draft can commit synchronously; never select or seek a list it just replaced.
      const current = problemContext.current;
      if (current.issues !== shownIssues) return false;
      actions.select(null, -1);
      setIssueSelection([shownIssues, index]);
      if (current.timed && !current.tl.empty) playbackStore.seek(tAtF(current.tl, shownIssues[index].f0));
      return true;
    };
    // "Slow here" adds an ordinary zone the person can edit or undo; nothing is repaired silently.
    const fixIssue = (target) => {
      const pad = target.f1 - target.f0 < 0.04 ? 0.03 : 0;
      const f0 = Math.max(0, target.f0 - pad), f1 = Math.min(1, target.f1 + pad);
      const peak = tl.points.reduce((best, point) => point.f >= f0 && point.f <= f1 ? Math.max(best, point.v) : best, 0) || source.constraints.maxVel;
      setIssueSelection(null);
      actions.addSlowZone(f0, f1, Math.max(0.3, Math.round(peak * 0.7 * 20) / 20));
    };
    const problems = { issues: shownIssues, stale: issuesStale, selected: issueIndex, issue,
      onInspect: () => { if (!inspectIssues()) return false; hoverStore.clear(); return true; },
      onSelect: selectIssue, onClear: () => setIssueSelection(null), onFix: fixIssue, live: Boolean(draft) };
    return h('div', { ref: rootRef, className: 'workcol', onPointerDownCapture: event => {
      hoverPresses.current.add(event.pointerId); hoverStore.clear();
    } }, children({ doc: source, fieldDoc: displayed.path, derived: value, tl, interactionReady, problems,
      hoverStore, hoverContext, timingHeld: Boolean(keepTiming) }));
  }
  /** Under the field: the selection's properties beside the speed, time and command timeline. */
  function PathBand({ doc, derived, tl, problems, robot, actions, edit, timingHeld, ...props }) {
    const c = doc.constraints;
    const limits = h('div', { className: 'pt-limits', key: doc.id },
      h(UI.Num, { label: 'Speed', value: c.maxVel, unit: 'm/s', min: 0.1, max: robot.maxSpeed, onChange: (v) => actions.setConstraint({ maxVel: v }) }),
      h(UI.Num, { label: 'Acceleration', value: c.maxAccel, unit: 'm/s²', min: 0.1, onChange: (v) => actions.setConstraint({ maxAccel: v, maxDecel: v }) }));
    return h('section', { className: 'path-band', 'aria-label': 'Path details' },
      h(PathPanel, { ...props, stale: props.stale || timingHeld, doc, derived, tl, robot, actions, problems, issue: problems.issue, issueStale: problems.stale,
        onFixIssue: problems.onFix, onClearIssue: problems.onClear }),
      h(PathTimeline, { doc, derived, tl, robot, sel: props.sel, select: actions.select, edit, actions, playbackStore: props.playbackStore,
        catalog: props.robotProject?.catalog, metric: props.metric, stale: props.stale || timingHeld, header: limits,
        hoverStore: props.hoverStore, hoverContext: props.hoverContext, issues: problems.issues, issuesStale: problems.stale, selectedIssue: problems.selected }));
  }
  // Fit the path summary, its 32px shared action button, and bottom breathing room.
  const BAND_MIN = 252;
  /** The band height that fits the whole field above it at the current width. */
  function balancedBand(size) {
    if (!size) return 280;
    const field = size.w * (FIT.h / FIT.w) + 12;
    return Math.round(Math.max(BAND_MIN, Math.min(size.h * 0.6, size.h - field)));
  }
  /** Band height: drag, or arrows/Home/End with focus. Enter or double-click returns to the balanced height. */
  function BandDivider({ height, max, onChange }) {
    const pointerDrag = PointerDrag.useController();
    const clampBand = (value) => Math.round(Math.max(BAND_MIN, Math.min(max, value)));
    return h('div', { className: 'band-divider', role: 'separator', tabIndex: 0, 'aria-orientation': 'horizontal', 'aria-label': 'Resize timeline',
      'aria-valuemin': BAND_MIN, 'aria-valuemax': Math.round(max), 'aria-valuenow': Math.round(height), title: 'Drag to resize · double-click to reset',
      onPointerDown: (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const y0 = event.clientY, start = height;
        pointerDrag.start(event, { cursor: 'ns-resize', move: (next) => onChange(clampBand(start - (next.clientY - y0))) });
      },
      onDoubleClick: () => onChange(null),
      onKeyDown: (event) => {
        const step = event.shiftKey ? 64 : 16;
        const next = { ArrowUp: height + step, ArrowDown: height - step, Home: BAND_MIN, End: max }[event.key];
        if (next != null) { event.preventDefault(); event.stopPropagation(); onChange(clampBand(next)); }
        else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); onChange(null); }
      } });
  }
  function RoutinePanelPlayback({ store, ...props }) {
    const playback = usePlayback(store);
    return h(RoutinePanel, { ...props, time: playback.time, running: playback.playing || playback.time > 0.001 });
  }
  /** Keeps the previous overlay while every segment's display state is unchanged. */
  function stableRoutineOverlay(previous, next) {
    const same = previous && previous.length === next.length && next.every((segment, index) => {
      const before = previous[index];
      return before.nodeId === segment.nodeId && before.occurrenceId === segment.occurrenceId && before.pts === segment.pts && before.state === segment.state
        && before.kind === segment.kind && before.label === segment.label && before.idxLabel === segment.idxLabel;
    });
    return same ? previous : next;
  }
  function RoutineFieldPlayback({ store, run, selectedId, robot, ...props }) {
    const playback = usePlayback(store), running = playback.playing || playback.time > 0.001;
    // Playback moves the robot every frame; route layers change only with step state.
    const overlayRef = useRef(null);
    const overlay = overlayRef.current = stableRoutineOverlay(overlayRef.current, AUTO.fieldOverlay(run, { time: playback.time, running, selectedId }));
    const pose = AUTO.poseAt(run, playback.time, robot);
    return h(FieldView, { ...props, robot, playTime: 0, routine: overlay, routinePose: pose });
  }
  function RoutineTransportPlayback({ store, run }) {
    const playback = usePlayback(store), running = playback.playing || playback.time > 0.001;
    return h(RoutineTransport, { run, time: playback.time, playing: playback.playing, controls: store, running });
  }

  function App({ initialProject = null, initialAgentProposal = null } = {}) {
    const [project, setProject] = useState(() => initialProject || freshProject());
    const appUpdates = useAppUpdates();
    const plannerId = 'profiledSpline';
    const [activeIdx, setActiveIdx] = useState(0);
    const [sel, setSel] = useState({ kind: null, idx: -1 });
    const [page, setPage] = useState('plan');
    const [editorPage, setEditorPage] = useState('plan');
    const [projectKey, setProjectKey] = useState(0);
    const [libraryPreferenceKey, setLibraryPreferenceKey] = useState(() => project.name + ':' + project.paths[0].id);
    useEffect(() => { if (page !== 'robot') setEditorPage(page); }, [page]);
    const alliance = 'blue';
    const [showGrid, setShowGrid] = useState(true);
    const deletionAction = useRef(null), deletionSequence = useRef(0);
    const [deletionNotice, setDeletionNotice] = useState(null);
    useEffect(() => () => {
      if (deletionAction.current) deletionAction.current.active = false;
      deletionAction.current = null;
    }, []);
    const retireDeletion = useCallback((beforeHide = false) => {
      if (deletionAction.current) deletionAction.current.active = false;
      deletionAction.current = null;
      if (beforeHide && document.activeElement?.closest('.deletion-notice')
        && !document.querySelector('dialog:modal,[role="dialog"][aria-modal="true"]')) {
        // Places survive workspace replacement and navigation to Settings; the field does not.
        (document.querySelector('.toolbar .place[aria-current="page"]') || document.querySelector('.toolbar .place'))?.focus();
      }
      setDeletionNotice(null);
    }, []);
    const [fieldFocus, setFieldFocus] = useState(() => {
      try { return localStorage.getItem('bordeaux.workspace.focus') === '1'; } catch (_) { return false; }
    });
    const toggleFieldFocus = useCallback(() => {
      if (!fieldFocus) retireDeletion();
      if (!fieldFocus && document.activeElement?.closest('.stage-plan .library-rail')) {
        document.querySelector('.stage-plan .fieldsvg')?.focus();
        if (document.activeElement?.closest('.library-rail')) document.querySelector('.toolbar .place')?.focus();
      }
      setFieldFocus(!fieldFocus);
      try {
        if (fieldFocus) localStorage.removeItem('bordeaux.workspace.focus');
        else localStorage.setItem('bordeaux.workspace.focus', '1');
      } catch (_) { /* Keep the window preference when storage is unavailable. */ }
    }, [fieldFocus, retireDeletion]);
    const [view, setView] = useState(FIT);
    // The full inspector is the "More" drawer; everyday values sit in the band under the field.
    const [inspectorOpen, setInspectorOpen] = useState(false);
    const editPreviewer = useMemo(() => PathPreview.createEditing(), []);
    useEffect(() => editPreviewer.retain(), [editPreviewer]);
    const [workSize, setWorkSize] = useState(null);
    const [bandOverride, setBandOverride] = useState(null);
    const workObserver = useRef(null);
    // The band takes the height the whole-field fit leaves free, so it never costs field scale by default.
    const workColumn = useCallback((element) => {
      workObserver.current?.disconnect();
      workObserver.current = null;
      if (!element) return;
      const stage = element.parentElement, library = element.previousElementSibling;
      // A stable no-drawer, visible-library baseline also avoids a one-frame jump before ResizeObserver.
      // Hidden rails have no layout box; their computed border-box width retains the same CSS source.
      const measure = () => {
        const w = stage.clientWidth - (library.offsetWidth || parseFloat(getComputedStyle(library).width));
        const h = stage.clientHeight;
        setWorkSize((current) => current && current.w === w && current.h === h ? current : { w, h });
      };
      measure();
      workObserver.current = new ResizeObserver(measure);
      workObserver.current.observe(stage);
    }, []);
    const libraryDurations = useMemo(() => createLibraryDurations(FinalPlanning.create()), []);
    const times = useSyncExternalStore(libraryDurations.subscribe, libraryDurations.getSnapshot, libraryDurations.getSnapshot);
    useEffect(() => () => libraryDurations.cancel(), [libraryDurations]);
    const [optimizationOpen, setOptimizationOpen] = useState(false);
    const bandMax = Math.max(BAND_MIN, Math.round((workSize?.h || 600) * 0.6));
    const bandHeight = bandOverride != null ? Math.max(BAND_MIN, Math.min(bandMax, bandOverride))
      : balancedBand(workSize);
    const [comparison, setComparison] = useState(null);
    const restoreInspectorFocus = useRef(false);
    const openInspector = useCallback(() => {
      setComparison(null);
      setOptimizationOpen(false);
      setInspectorOpen(true);
    }, []);
    const closeInspector = useCallback(() => {
      restoreInspectorFocus.current = true;
      setInspectorOpen(false);
    }, []);
    useEffect(() => {
      if (!inspectorOpen && !optimizationOpen && restoreInspectorFocus.current) {
        restoreInspectorFocus.current = false;
        document.querySelector('.pp-more')?.focus();
      }
    }, [inspectorOpen, optimizationOpen]);
    const appliedPreview = useRef(null);
    const [metric, setMetric] = useState('velocity');
    const [tool, setTool] = useState('select');
    const [waypointPreviewRequest, setWaypointPreviewRequest] = useState(null);
    const [headMenu, setHeadMenu] = useState(null);
    const [dirty, setDirty] = useState(false);
    const [agentProposal, setAgentProposal] = useState(initialAgentProposal);
    const [agentCandidateId, setAgentCandidateId] = useState(null);
    const [mcpEnabled, setMcpEnabled] = useState(false);
    const [agentSessionId] = useState(() => 'session_' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)));
    const [agentEditResolutionRevision, setAgentEditResolutionRevision] = useState(0);
    const agentProposalRef = useRef(agentProposal); agentProposalRef.current = agentProposal;
    const agentProposalContext = useRef(null);
    const [robotProjectState, setRobotProjectState] = useState({ status: 'unlinked', operation: null, catalog: null, integration: null, error: '', notice: '', bookmarkId: null, recentProjects: [] });
    const robotCatalogFingerprint = useRef(null);
    if (robotProjectState.catalog && robotProjectState.catalog.semanticFingerprint) robotCatalogFingerprint.current = robotProjectState.catalog.semanticFingerprint;
    else if (!robotProjectState.operation) robotCatalogFingerprint.current = null;
    const [exportError, setExportError] = useState('');
    const [bdxNotice, setBdxNotice] = useState('');
    const [projectLocation, setProjectLocation] = useState(null);
    const [saveState, setSaveStateValue] = useState({ status: 'idle', error: '' });
    // A source failure carries a try number until a save succeeds (a BDX failure means the source saved). Only attempts
    // the person starts (Retry, Save, a switch) count, so background autosaves keep the failure's text and announcement
    // steady while editing continues, and a Retry that fails again at once is still a new, announced state.
    // `saveStateEpoch` lets a cancelled Save restore exactly what it replaced, unless something newer has landed.
    const failedSaves = useRef(0), saveStateRef = useRef(saveState), saveStateEpoch = useRef(0);
    const setSaveState = useCallback((next, { user = false } = {}) => {
      const failure = next.status === 'error' && !next.retryExport, prior = saveStateRef.current;
      if (failure) failedSaves.current = user || !failedSaves.current ? failedSaves.current + 1 : failedSaves.current;
      else if (next.status !== 'saving') failedSaves.current = 0;
      // A write that starts while a source failure stands keeps that failure (its text, fixes and focus) until it
      // succeeds or fails again; `writing` marks it busy. A Reload failure line belongs to that Reload, so it goes.
      const value = failure ? { ...next, attempt: failedSaves.current }
        : next.status === 'saving' && prior.status === 'error' && !prior.retryExport ? { ...prior, reloadError: undefined, writing: true } : next;
      saveStateRef.current = value; saveStateEpoch.current += 1;
      setSaveStateValue(value);
    }, []);
    const restoreSaveState = useCallback((prior, attempts) => {
      failedSaves.current = attempts; saveStateRef.current = prior; saveStateEpoch.current += 1;
      setSaveStateValue(prior);
    }, []);
    // Durability: the last recovery copy main confirmed for this document, and the origin of a restored draft.
    const [recoveryState, setRecoveryState] = useState(null);
    const [recoveredFrom, setRecoveredFrom] = useState(null);
    // Reload from disk's receipt for the document it opened (the copy it kept), a Show file failure kept for the next
    // menu, and outcomes of menu actions announced after the menu has closed.
    const [reloadKept, setReloadKept] = useState(null);
    const [showFailure, setShowFailure] = useState(null);
    const [actionNotice, setActionNotice] = useState(null);
    const announceAction = useCallback((text) => setActionNotice((current) => ({ key: (current?.key || 0) + 1, text })), []);
    // An explicit Save's BDX regeneration after its source is saved: Git-shared Paths/*.bdx are not current until it ends.
    const [bdxPending, setBdxPending] = useState(false);
    // The live document's own recovery record is not a recovery to offer back to it.
    const [sessionRecordId, setSessionRecordId] = useState(null);
    const sessionContext = useRef(null);
    const lifecycle = useMemo(() => lifecycleApi(typeof window === 'undefined' ? null : window.bordeauxAPI), []);
    const checkpointChannel = useMemo(() => lifecycle ? createCheckpointChannel(lifecycle) : null, [lifecycle]);
    useEffect(() => () => checkpointChannel?.dispose(), [checkpointChannel]);
    // Only a load result binds document ownership. Later session reads may refresh that document's target and record.
    const adoptSessionRecord = useCallback((session, epoch) => {
      if (epoch !== documentEpoch.current || !sameDocument(sessionContext.current, session?.context) || session.context.targetGeneration < sessionContext.current.targetGeneration) return false;
      sessionContext.current = session.context; setSessionRecordId(session.recoveryRecordId || null);
      return true;
    }, []);
    const readBoundSession = useCallback(async () => {
      const epoch = documentEpoch.current, session = await lifecycle.getProjectSession();
      if (!adoptSessionRecord(session, epoch)) throw new Error('The project changed');
      return session;
    }, [adoptSessionRecord, lifecycle]);
    const refreshSessionRecord = useCallback(() => {
      if (lifecycle) void readBoundSession().catch(() => undefined);
    }, [lifecycle, readBoundSession]);
    const snapshotRevision = useRef(0), documentEpoch = useRef(0), exportSequence = useRef(0), exportJobs = useRef(new Set()), exportShown = useRef(0);
    // Counts source writes main confirmed (not chip or BDX outcomes), so an older failure never replaces a newer save.
    const sourceSaves = useRef(0);
    const nextSnapshotRevision = useCallback(() => ++snapshotRevision.current, []);
    // Startup holds the skeleton until main's bounded result (and any adoption) settles, so nothing editable flashes first.
    const [startup, setStartup] = useState(() => typeof window !== 'undefined' && typeof window.bordeauxAPI?.getProjectStartup === 'function' ? 'pending' : 'done');
    // Nothing is checkpointed until startup has settled and its accepted document (opened source or blank) is loaded:
    // the editor's initial model is never the user's, and a reload keeps main's previous target until adoption.
    const startupSettled = useRef(startup === 'done'), startupDetachFailed = useRef(false);
    // Detaches main's save target under the original startup context and token (main checks both and that no adoption
    // committed): target null, a fresh document session. The previous source comes back only as metadata. Without the
    // seam, or if main refuses, nothing is checkpointed (the unscoped newProject is deliberately not used here).
    // After a failed startup detach (and only then) a blocked save says how to continue; while startup is still pending
    // its skeleton owns the window and there is nothing to say.
    const showNoSaveTarget = useCallback(() => {
      if (startupDetachFailed.current) setProjectsDialog({ mode: 'list', returnFocus: null, notice: { blocked: 'no-target', message: 'Open or create a project to save' } });
    }, []);
    const detachStartup = useCallback(async (context, transition) => {
      const api = window.bordeauxAPI;
      if (typeof api.detachProjectStartup !== 'function') return { ok: false, fact: 'This version can’t start a new project safely' };
      try {
        const result = await api.detachProjectStartup({ context, transition });
        const location = result?.session?.location;
        return location && !location.folderPath && !location.projectPath && result.session.context.documentSessionId !== context.documentSessionId
          ? { ok: true, session: result.session } : { ok: false, fact: 'The previous project is still the save target' };
      } catch (error) { return { ok: false, fact: firstFact(error) }; }
    }, []);
    const [projectsDialog, setProjectsDialog] = useState(null);
    const [unitSystem, setUnitSystemState] = useState(() => UnitPrefs.current());
    const setUnitSystem = useCallback((next) => {
      const units = UnitPrefs.set(next);
      setUnitSystemState(units);
      setProject((current) => ({ ...current, editor: { ...current.editor, unitSystem: units } }));
    }, []);
    React.useLayoutEffect(() => {
      if (project.editor?.unitSystem) setUnitSystemState(UnitPrefs.set(project.editor.unitSystem));
    }, [project.editor?.unitSystem]);
    const robotRestoreGeneration = useRef(0);
    const skipDirty = useRef(true);
    const keyboardNavigation = useRef(false);
    const editStore = useMemo(() => PathEdit.create(), []);
    const playbackStore = useMemo(() => createPlaybackStore(), []);
    const routinePlaybackStore = useMemo(() => createPlaybackStore(), []);
    const waypointPreviewer = useMemo(() => PathPreview.create(), []);
    const [waypointPreviewSnapshot, setWaypointPreviewSnapshot] = useState(() => waypointPreviewer.getSnapshot());
    const agentPreviewer = useMemo(() => PathPreview.create(), []);
    const [agentPreview, setAgentPreview] = useState(() => agentPreviewer.getSnapshot());
    useEffect(() => () => { playbackStore.destroy(); routinePlaybackStore.destroy(); }, [playbackStore, routinePlaybackStore]);
    useEffect(() => waypointPreviewer.retain(), [waypointPreviewer]);
    useEffect(() => waypointPreviewer.subscribe(() => setWaypointPreviewSnapshot(waypointPreviewer.getSnapshot())), [waypointPreviewer]);
    useEffect(() => agentPreviewer.retain(), [agentPreviewer]);
    useEffect(() => agentPreviewer.subscribe(() => setAgentPreview(agentPreviewer.getSnapshot())), [agentPreviewer]);

    useEffect(() => {
      if (!window.bordeauxAPI || typeof window.bordeauxAPI.listRecentRobotProjects !== 'function') return;
      let active = true;
      window.bordeauxAPI.listRecentRobotProjects().then((recentProjects) => {
        if (active) setRobotProjectState((current) => ({ ...current, recentProjects: Array.isArray(recentProjects) ? recentProjects : [] }));
      }).catch((error) => {
        if (active) setRobotProjectState((current) => ({ ...current, error: error && error.message ? error.message : String(error) }));
      });
      return () => { active = false; };
    }, []);

    // Link adoption shares source-save ordering, so a copy captures the selected code before rebasing it.
    const persistenceQueue = useMemo(() => createPersistenceQueue(), []);
    const applyRobotProjectConnection = useCallback((result) => {
      setExportError('');
      setRobotProjectState({
        status: 'ready',
        operation: null,
        catalog: result.catalog,
        integration: result.integration || null,
        error: '',
        notice: result.warning || '',
        bookmarkId: result.bookmarkId,
        recentProjects: result.recentProjects || [],
      });
      if (result.editorLink) { const linked = withRobotLink(projectRef.current, result.editorLink); projectRef.current = linked; setProject(linked); }
    }, []);

    const linkRobotProject = useCallback(async () => {
      if (!window.bordeauxAPI || typeof window.bordeauxAPI.linkRobotProject !== 'function') {
        setRobotProjectState((current) => ({ ...current, status: 'error', error: 'Robot project linking is available in the Bordeaux desktop app.' }));
        return;
      }
      const generation = ++robotRestoreGeneration.current, prior = robotProjectState;
      setRobotProjectState((current) => ({ ...current, status: 'loading', operation: 'scan', error: '', notice: '' }));
      try {
        await persistenceQueue.enqueue(async () => {
          if (robotRestoreGeneration.current !== generation) return;
          const result = await window.bordeauxAPI.linkRobotProject(sessionContext.current);
          if (robotRestoreGeneration.current !== generation) return;
          if (!result) {
            setRobotProjectState(prior);
            return;
          }
          applyRobotProjectConnection(result);
        });
      } catch (error) {
        if (robotRestoreGeneration.current !== generation) return;
        setRobotProjectState((current) => ({ ...current, status: 'error', operation: null, catalog: null, integration: null, bookmarkId: null, suggestion: null, error: operationErrorMessage(error) }));
      }
    }, [persistenceQueue, applyRobotProjectConnection, robotProjectState]);

    const openRecentRobotProject = useCallback(async (id, expectedGeneration) => {
      if (!window.bordeauxAPI || typeof window.bordeauxAPI.openRecentRobotProject !== 'function') return;
      const generation = expectedGeneration == null ? ++robotRestoreGeneration.current : expectedGeneration;
      setRobotProjectState((current) => ({ ...current, status: 'loading', operation: 'scan', error: '', notice: '' }));
      try {
        await persistenceQueue.enqueue(async () => {
          if (robotRestoreGeneration.current !== generation) return;
          const result = await window.bordeauxAPI.openRecentRobotProject(id, sessionContext.current);
          if (robotRestoreGeneration.current !== generation) return;
          applyRobotProjectConnection(result);
        });
      } catch (error) {
        if (robotRestoreGeneration.current !== generation) return;
        setRobotProjectState((current) => ({ ...current, status: 'error', operation: null, catalog: null, integration: null, bookmarkId: null, suggestion: null, error: operationErrorMessage(error) }));
      }
    }, [persistenceQueue, applyRobotProjectConnection]);

    const restoreRobotCode = useCallback(async (context, generation) => {
      setRobotProjectState((current) => ({ ...current, status: 'loading', operation: 'scan', suggestion: null }));
      try {
        const result = await window.bordeauxAPI.restoreProjectRobotCode(context);
        if (robotRestoreGeneration.current !== generation) return;
        if (result.catalog) applyRobotProjectConnection(result);
        else setRobotProjectState((current) => ({ ...current, ...result, operation: null, catalog: null, integration: null, bookmarkId: null }));
      } catch (error) {
        if (robotRestoreGeneration.current === generation) setRobotProjectState((current) => ({ ...current, status: 'missing', operation: null, catalog: null, error: operationErrorMessage(error) }));
      }
    }, [applyRobotProjectConnection]);
    const useSuggestedRobotCode = useCallback(async () => {
      const suggestion = robotProjectState.suggestion;
      if (!suggestion) return;
      const generation = ++robotRestoreGeneration.current;
      setRobotProjectState((current) => ({ ...current, status: 'loading', operation: 'scan', error: '' }));
      try {
        await persistenceQueue.enqueue(async () => {
          if (robotRestoreGeneration.current !== generation) return;
          const result = await window.bordeauxAPI.useSuggestedRobotCode(sessionContext.current, suggestion.id);
          if (robotRestoreGeneration.current === generation) applyRobotProjectConnection(result);
        });
      } catch (error) {
        if (robotRestoreGeneration.current === generation) setRobotProjectState((current) => ({ ...current, status: 'missing', operation: null, suggestion: null, error: operationErrorMessage(error) }));
      }
    }, [persistenceQueue, applyRobotProjectConnection, robotProjectState.suggestion]);

    const refreshRobotProject = useCallback(async (rescan = false) => {
      if (!window.bordeauxAPI || typeof window.bordeauxAPI.refreshRobotProject !== 'function') return;
      const generation = robotRestoreGeneration.current;
      // Like Build, a refresh keeps the link and its catalog; only the operation marks the pending work.
      setRobotProjectState((current) => ({ ...current, operation: 'refresh', error: '', notice: '' }));
      try {
        const result = await (rescan && window.bordeauxAPI.inspectLabviewCommands
          ? window.bordeauxAPI.inspectLabviewCommands(sessionContext.current) : window.bordeauxAPI.refreshRobotProject(sessionContext.current));
        if (robotRestoreGeneration.current !== generation) return;
        applyRobotProjectConnection(result);
      } catch (error) {
        if (robotRestoreGeneration.current !== generation) return;
        setRobotProjectState((current) => ({ ...current, status: current.catalog ? 'stale' : 'error', operation: null, error: operationErrorMessage(error) }));
      }
    }, [applyRobotProjectConnection]);

    const usedCommandKey = useMemo(() => {
      const ids = new Set();
      for (const path of project.paths) for (const marker of path.markers || []) if (marker.invocation?.commandId) ids.add(marker.invocation.commandId);
      for (const routine of project.routines || []) AUTO.walk(routine.nodes, node => { if (node.invocation?.commandId) ids.add(node.invocation.commandId); });
      return JSON.stringify([...ids].sort());
    }, [project]);
    useEffect(() => {
      const api = window.bordeauxAPI, catalog = robotProjectState.catalog;
      if (!api?.ensureCommandWrappers || !catalog || robotProjectState.status !== 'ready' || robotProjectState.operation) return;
      const ids = JSON.parse(usedCommandKey).filter(id => catalog.commands.some(command => command.id === id && command.labviewConnector));
      if (!ids.length) return;
      let current = true;
      void api.ensureCommandWrappers(sessionContext.current, ids).then(() => {
        if (current) setRobotProjectState(state => state.wrapperError ? { ...state, wrapperError: '' } : state);
      }, error => {
        if (current) setRobotProjectState(state => ({ ...state, wrapperError: 'Couldn’t prepare command wrapper. ' + operationErrorMessage(error) }));
      });
      return () => { current = false; };
    }, [usedCommandKey, projectKey, robotProjectState.catalog, robotProjectState.status, robotProjectState.operation]);

    const buildRobotCatalog = useCallback(async () => {
      if (!window.bordeauxAPI || typeof window.bordeauxAPI.buildRobotCatalog !== 'function') return;
      const generation = robotRestoreGeneration.current;
      setRobotProjectState((current) => ({ ...current, operation: 'build', error: '', notice: '' }));
      try {
        const result = await window.bordeauxAPI.buildRobotCatalog(sessionContext.current);
        if (robotRestoreGeneration.current !== generation) return;
        // A successful build is quiet: the code status row shows the built catalog.
        if (result) applyRobotProjectConnection(result);
        else setRobotProjectState((current) => ({ ...current, operation: null }));
      } catch (error) {
        if (robotRestoreGeneration.current !== generation) return;
        setRobotProjectState((current) => ({ ...current, operation: null, status: current.catalog ? 'stale' : 'error', error: operationErrorMessage(error) }));
      }
    }, [applyRobotProjectConnection]);

    const routineLibrary = routineState(project);
    const routines = routineLibrary.routines;
    const routine = routines.find((candidate) => candidate.id === routineLibrary.activeRoutineId) || routines[0];
    // One chronological journal; each surface undoes only its own scope or project-wide changes.
    const history = useMemo(() => createUndoHistory(), []);
    const recordUndo = useCallback((entry) => {
      history.record(entry);
      const action = deletionAction.current;
      if (action && history.peekUndo(action.scopes) !== action.entry) retireDeletion();
      force((x) => x + 1);
      return entry;
    }, [history, retireDeletion]);
    // Advances only when a command branch's owner is replaced: the active routine changes, a command or output
    // replaces its routes, or routine Undo/Redo restores content. Ordinary field and step edits keep it.
    const branchGeneration = useRef(0);
    const commitRoutineState = useCallback((update) => {
      const current = projectRef.current, before = routineState(current);
      const next = update(clone(before));
      const entry = recordUndo({ scope: ROUTINE_SCOPE, touches: [ROUTINE_SCOPE], kind: 'routines', state: clone(before) });
      if (next.activeRoutineId !== before.activeRoutineId) branchGeneration.current += 1;
      // Compute once outside a replayable updater; Undo never downgrades source 1.1.
      projectRef.current = promoteRoutineProjectSchema(withRoutineState(current, next));
      setProject((value) => promoteRoutineProjectSchema(withRoutineState(value, next)));
      return entry;
    }, [recordUndo]);
    const setRoutine = useCallback((update) => commitRoutineState((state) => {
      const current = state.routines.find((candidate) => candidate.id === state.activeRoutineId) || state.routines[0];
      const value = typeof update === 'function' ? update(current) : update;
      return { ...state, routines: state.routines.map((candidate) => candidate.id === current.id ? value : candidate) };
    }), [commitRoutineState]);
    // Local preview choices: one route per branch and passes per conditional repeat. Never saved.
    const [routineOutcomes, setRoutineOutcomes] = useState({});
    const [routinePasses, setRoutinePasses] = useState({});
    const [routineSel, setRoutineSel] = useState(null);
    const [routineCollapsed, setRoutineCollapsed] = useState({});

    const robot = project.robot;
    const accent = ACCENT;
    useEffect(() => {
      if (waypointPreviewRequest) requestWaypointPreview(waypointPreviewer, waypointPreviewRequest, robot, plannerId);
    }, [waypointPreviewer, waypointPreviewRequest, robot, plannerId]);
    const waypointPreview = waypointPreviewResult(waypointPreviewSnapshot, waypointPreviewRequest);

    const doc = project.paths[activeIdx];
    const docRef = useRef(doc); docRef.current = doc;
    const projectRef = useRef(project); projectRef.current = project;
    const catalogRef = useRef(null); catalogRef.current = robotProjectState.catalog;
    const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
    const autosaveRevision = useRef(0);
    const bdxSaveFailure = useRef(null);
    // A source save's chip: saved, or the last BDX failure still waiting for its retry.
    const savedState = () => bdxSaveFailure.current ? { status: 'error', ...bdxSaveFailure.current, retryExport: true } : { status: 'saved', error: '' };
    const autosaveTimer = useRef(0);
    const draftInputGeneration = useRef(0);
    const [, force] = useState(0);
    const updateDirty = useCallback((next) => {
      dirtyRef.current = next;
      setDirty(next);
      if (window.bordeauxAPI && typeof window.bordeauxAPI.setDirty === 'function') window.bordeauxAPI.setDirty(next);
    }, []);
    const flushProjectDraft = useCallback(() => flushFocusedProjectDraft(document, flushSync), []);
    const markAgentProposalStale = useCallback(() => {
      const current = agentProposalRef.current;
      if (!current || current.status !== 'ready') return;
      const stale = { ...current, status: 'stale' };
      agentProposalRef.current = stale;
      setAgentProposal(stale);
      if (window.bordeauxAPI && typeof window.bordeauxAPI.updateAgentProposalStatus === 'function') {
        window.bordeauxAPI.updateAgentProposalStatus(current.id, 'stale');
      }
    }, []);
    const materializeProject = useCallback(() => {
      const base = projectRef.current;
      const draft = editStore.getSnapshot();
      const materialized = editStore.materialize(base);
      if (!draft || materialized === base) return base;
      const before = base.paths.find((path) => path.id === draft.id);
      return PathLinks.sync(materialized, draft.id, before);
    }, [editStore]);
    const agentSync = useMemo(() => createAgentSessionSync({
      sessionId: agentSessionId,
      send: (snapshot) => window.bordeauxAPI?.publishAgentSession?.(snapshot),
      capture: () => ({ project: projectRef.current, materialized: materializeProject(), activePathId: docRef.current?.id, editRevision: editStore.getRevision() }),
      onPublish: (revision) => { if (agentProposalRef.current?.baseRevision !== revision) markAgentProposalStale(); },
      onAccessChange: (enabled) => { setMcpEnabled(enabled); markAgentProposalStale(); },
      events: typeof window === 'undefined' ? null : window,
    }), [agentSessionId, editStore, markAgentProposalStale, materializeProject]);
    const pushController = useRobotPushController({ getProject: materializeProject, projectKey, catalogKey: robotProjectState.catalog?.catalogHash, bookmarkKey: robotProjectState.bookmarkId });
    // The library edits which paths Push sends and the toolbar sends them, so App holds the one choice.
    const pushSelection = usePushSelection({ preferenceKey: libraryPreferenceKey, paths: project.paths, activePathId: doc.id });
    const enqueuePersistence = useCallback((operation) => persistenceQueue.enqueue(operation), [persistenceQueue]);
    // One background checkpoint: a recovery copy first, then the source when there is a folder. Its own revision and
    // context match the updates (registered before invoking); receipts here are storage facts, never departure permits.
    const checkpointBackground = useCallback(async (project) => {
      const epoch = documentEpoch.current, session = await readBoundSession(), revision = nextSnapshotRevision();
      const noteRecovery = (update) => { const recovery = recoveryOutcome(update); if (recovery && epoch === documentEpoch.current) setRecoveryState(recovery); };
      const update = await new Promise((resolve) => {
        const stop = checkpointChannel.watch(checkpointMatch({ mode: 'background', snapshotRevision: revision, context: session.context }), (next) => {
          noteRecovery(next);
          if (next.source !== 'pending') { stop(); resolve(next); }
        });
        lifecycle.checkpointProject({ context: session.context, snapshotRevision: revision, project }).then((next) => { stop(); resolve(next); },
          (error) => { stop(); resolve({ source: 'failed', sourceFact: operationErrorMessage(error), recovery: 'failed', recoveryFact: 'Recovery copy could not be saved' }); });
      });
      noteRecovery(update);
      if (update.source === 'saved') sourceSaves.current += 1;
      return { saved: update.source === 'saved', location: update.location, canonicalProject: update.canonicalProject,
        ...(update.source === 'failed' || update.source === 'timed-out' ? { error: update.sourceFact || 'Couldn’t write the project', sourceChange: sourceChangeOf(update) } : {}) };
    }, [checkpointChannel, lifecycle, nextSnapshotRevision, readBoundSession]);
    const persistSource = useCallback((project) => lifecycle ? checkpointBackground(project) : window.bordeauxAPI.autosaveProject(project), [checkpointBackground, lifecycle]);
    const invalidateScheduledAutosave = useCallback(() => {
      autosaveRevision.current += 1;
      if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
      autosaveTimer.current = 0;
    }, []);
    const scheduleAutosave = useCallback((immediate, { user = false } = {}) => {
      // While Reload from disk holds the queue nothing new is scheduled; it never restarts saves when it ends.
      if (!window.bordeauxAPI || (!lifecycle && typeof window.bordeauxAPI.autosaveProject !== 'function') || !startupSettled.current || persistenceQueue.held()) return;
      const revision = ++autosaveRevision.current;
      if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
      autosaveTimer.current = 0;
      const persist = () => enqueuePersistence(async () => {
        if (revision !== autosaveRevision.current || !startupSettled.current) return;
        // A checkpoint records unsaved work; a just-loaded or already saved model has none (and an empty first-use
        // document must not become a recovery to offer back).
        if (lifecycle && !user && !dirtyRef.current && !hasProjectInputDraft() && !editStore.getSnapshot()) return;
        const pendingInput = hasProjectInputDraft();
        const draftGeneration = draftInputGeneration.current;
        const sourceProject = projectRef.current;
        const editRevision = editStore.getRevision();
        setSaveState({ status: 'saving', error: '' });
        const result = await persistSource(materializeProject());
        if (revision === autosaveRevision.current) {
          if (result?.location) setProjectLocation(result.location);
          setSaveState(result?.error ? { status: 'error', error: result.error, sourceChange: result.sourceChange } : bdxSaveFailure.current ? { status: 'error', ...bdxSaveFailure.current, retryExport: true } : { status: result?.saved && !pendingInput && !hasProjectInputDraft() ? 'saved' : 'draft', error: '' }, { user });
        }
        if (revision === autosaveRevision.current && sourceProject === projectRef.current
          && editRevision === editStore.getRevision() && draftGeneration === draftInputGeneration.current
          && !pendingInput && !hasProjectInputDraft() && !editStore.getSnapshot() && result && result.saved) updateDirty(false);
      });
      if (immediate === true) {
        void persist().catch((error) => { if (revision === autosaveRevision.current) setSaveState({ status: 'error', error: operationErrorMessage(error) }, { user }); });
        return;
      }
      autosaveTimer.current = window.setTimeout(() => {
        autosaveTimer.current = 0;
        void persist().catch((error) => { if (revision === autosaveRevision.current) setSaveState({ status: 'error', error: operationErrorMessage(error) }); });
      }, 900);
    }, [editStore, enqueuePersistence, lifecycle, materializeProject, persistSource, persistenceQueue, setSaveState, updateDirty]);

    useEffect(() => {
      const onDraftInput = (event) => {
        if (noteProjectDraftInput(event.target, dirtyRef.current, () => updateDirty(true), scheduleAutosave)) {
          draftInputGeneration.current += 1;
        }
      };
      // React must record the draft before dirty-state rendering can restore the
      // controlled input value. Observe after its root input handler has run.
      document.addEventListener('input', onDraftInput);
      return () => document.removeEventListener('input', onDraftInput);
    }, [scheduleAutosave, updateDirty]);

    useEffect(() => {
      const activePathId = project.paths[activeIdx] && project.paths[activeIdx].id;
      if (!activePathId || (project.editor && project.editor.activePathId === activePathId)) return;
      setProject((current) => ({ ...current, editor: { ...(current.editor || {}), activePathId } }));
    }, [activeIdx, project.paths, project.editor && project.editor.activePathId]);

    useEffect(() => {
      if (skipDirty.current) skipDirty.current = false;
      else updateDirty(true);
    }, [project, updateDirty]);
    useEffect(() => scheduleAutosave(), [project, scheduleAutosave]);
    // A selected link belongs to the source project; do not wait for another geometry edit or the debounce.
    const savedLinkKey = JSON.stringify([project.editor?.labviewProjectPath, project.editor?.robotProjectBookmarkId]);
    const previousLinkKey = useRef(savedLinkKey);
    useEffect(() => {
      const changed = previousLinkKey.current !== savedLinkKey;
      previousLinkKey.current = savedLinkKey;
      if (changed && robotProjectState.status === 'ready') scheduleAutosave(true);
    }, [savedLinkKey, robotProjectState.status, scheduleAutosave]);
    useEffect(() => editStore.subscribe(() => {
      const draft = editStore.getSnapshot();
      const canceled = !draft && editStore.getLastResolution() === 'cancel';
      if (!draft && !canceled) return;
      markAgentProposalStale();
      if (canceled) setAgentEditResolutionRevision((revision) => revision + 1);
      if (canceled || !dirtyRef.current) updateDirty(true);
      scheduleAutosave(canceled);
    }), [editStore, markAgentProposalStale, scheduleAutosave, updateDirty]);
    useEffect(() => () => {
      if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
    }, []);
    useEffect(() => markAgentProposalStale(), [project, activeIdx, markAgentProposalStale]);
    useEffect(() => {
      if (robotProjectState.operation) return;
      const current = agentProposalRef.current;
      if (current?.status === 'ready' && current.baseRobotCatalogFingerprint
        && current.baseRobotCatalogFingerprint !== robotCatalogFingerprint.current) markAgentProposalStale();
    }, [robotProjectState.operation, robotProjectState.catalog && robotProjectState.catalog.semanticFingerprint, markAgentProposalStale]);
    useEffect(() => {
      const api = window.bordeauxAPI;
      if (!api || typeof api.getMcpStatus !== 'function') return undefined;
      let active = true;
      const receive = (status) => { if (active) agentSync.setAccess(status); };
      api.getMcpStatus().then(receive).catch(() => undefined);
      const unsubscribe = typeof api.onMcpStatus === 'function' ? api.onMcpStatus(receive) : null;
      return () => { active = false; if (unsubscribe) unsubscribe(); };
    }, [agentSync]);
    useEffect(() => agentSync.schedule(), [project, activeIdx, agentEditResolutionRevision, doc.id, agentSync]);
    useEffect(() => {
      if (!window.bordeauxAPI || typeof window.bordeauxAPI.onAgentProposal !== 'function') return;
      let active = true;
      let receivedLiveProposal = false;
      let lastProposalKey = '';
      const receiveProposal = (proposal) => {
        if (!active || !proposal) return;
        const proposalKey = proposal.id + ':' + proposal.status;
        if (proposalKey === lastProposalKey) return;
        lastProposalKey = proposalKey;
        const publishedContext = agentSync.published();
        const currentActivePathId = docRef.current && docRef.current.id;
        const stale = !agentProposalMatchesPublishedContext(proposal, agentSessionId, publishedContext, {
          project: projectRef.current,
          activePathId: currentActivePathId,
          editRevision: editStore.getRevision(),
          robotCatalogFingerprint: robotCatalogFingerprint.current,
          hasDraft: Boolean(editStore.getSnapshot()),
        });
        const received = stale && proposal.status === 'ready' ? { ...proposal, status: 'stale' } : proposal;
        agentProposalContext.current = {
          id: proposal.id,
          published: publishedContext,
        };
        agentProposalRef.current = received;
        if (stale && proposal.status === 'ready' && window.bordeauxAPI.updateAgentProposalStatus) window.bordeauxAPI.updateAgentProposalStatus(proposal.id, 'stale');
        if (window.bordeauxAPI.acknowledgeAgentProposal) {
          const receiptRevision = publishedContext ? publishedContext.revision : agentSync.revision() >= 0 ? agentSync.revision() : proposal.baseRevision;
          const receiptActivePathId = publishedContext ? publishedContext.activePathId : currentActivePathId || proposal.baseActivePathId;
          window.bordeauxAPI.acknowledgeAgentProposal(proposal.id, agentSessionId, receiptRevision, receiptActivePathId, !stale);
        }
        setAgentProposal(received);
        setAgentCandidateId(proposal.recommendedCandidateId || null);
        retireDeletion(true);
        setPage(proposal.operation === 'configureRobot' ? 'robot' : 'plan');
      };
      const unsubscribe = window.bordeauxAPI.onAgentProposal((proposal) => {
        receivedLiveProposal = true;
        receiveProposal(proposal);
      });
      if (typeof window.bordeauxAPI.getActiveAgentProposal === 'function') {
        Promise.resolve(window.bordeauxAPI.getActiveAgentProposal()).then((proposal) => {
          if (!receivedLiveProposal) receiveProposal(proposal);
        }).catch(() => undefined);
      }
      return () => { active = false; unsubscribe(); };
    }, [agentSessionId, agentSync, editStore]);
    useEffect(() => {
      const onPointerDown = () => { keyboardNavigation.current = false; };
      window.addEventListener('pointerdown', onPointerDown, true);
      return () => window.removeEventListener('pointerdown', onPointerDown, true);
    }, []);
    useEffect(() => {
      const pauseHiddenPlayback = () => {
        if (document.hidden) { playbackStore.pause(); routinePlaybackStore.pause(); }
      };
      document.addEventListener('visibilitychange', pauseHiddenPlayback);
      return () => document.removeEventListener('visibilitychange', pauseHiddenPlayback);
    }, []);

    // A search candidate never owns the selected result. Apply persists that choice.
    const optimizer = useMemo(() => PathOptimization.create({ getProject: () => projectRef.current }), []);
    const optimizationState = useSyncExternalStore(optimizer.subscribe, optimizer.getSnapshot, optimizer.getSnapshot);
    useEffect(() => { optimizer.sync(); }, [optimizer, project]);
    useEffect(() => () => optimizer.cancel(), [optimizer]);
    const optimizationKey = useMemo(() => optimizationInputKey(doc, robot, project.field), [doc, robot, project.field]);
    const searchKey = useMemo(() => routeInputKey(doc, robot, project.field), [doc, robot, project.field]);
    const planningPath = useMemo(() => ({ ...doc }), [projectKey, doc.id, optimizationKey, doc.optimization?.accepted]);
    const normalPath = useMemo(() => authoredPath(doc), [projectKey, doc.id, optimizationKey]);
    const planningRobot = useMemo(() => robot, [projectKey, optimizationKey]);
    const planningField = useMemo(() => project.field, [projectKey, optimizationKey]);
    // Editing owns the selected solve; comparison reuses only its qualified complete projection.
    const editing = useEditingPlanning(planningPath, planningRobot, planningField);
    const { selected, normal, baselineTime } = useOptimizerComparison({ enabled: optimizationOpen, editing,
      context: { documentKey: projectKey, pathId: doc.id, inputKey: optimizationKey, path: planningPath,
        normalPath, robot: planningRobot, field: planningField, plannerId, previewDensity: PERSEG, projectionVersion: 1 } });
    const outdatedOptimization = useMemo(() => isOptimizationOutdated(doc, robot, project.field), [doc, robot, project.field]);
    const selectedSettled = !editing.pending && editing.status !== 'idle';
    const applied = appliedPreview.current;
    const appliedMatches = applied?.documentKey === projectKey && applied.pathId === doc.id && applied.key === optimizationKey
      && applied.plannerId === plannerId && applied.previewDensity === PERSEG && applied.projectionVersion === 1
      && applied.artifact === doc.optimization?.accepted;
    if (applied && (!appliedMatches || selectedSettled)) appliedPreview.current = null;
    const justApplied = appliedMatches && editing.pending ? applied.value : null;
    const acceptedPreview = selected?.accepted ? selected.value : justApplied;
    const accepted = acceptedPreview?.finalTrajectory || null;
    const staleOptimization = Boolean(doc.optimization?.accepted && (outdatedOptimization || (selectedSettled && !selected?.accepted)));
    const optimizationEntry = optimizationState.paths[doc.id];
    const candidate = optimizationEntry?.key === searchKey ? optimizationEntry.value : null;
    const normalReady = normal.status === 'ready';
    const normalError = editing.comparisonError || normal.error;
    const comparisonMode = comparison?.documentKey === projectKey && comparison.id === doc.id && comparison.key === optimizationKey ? comparison.mode : 'selected';
    const comparedPreview = comparisonMode === 'candidate' ? candidate : comparisonMode === 'normal' && normalReady ? normal.value : null;
    const selectedPreview = comparedPreview || acceptedPreview;
    // The optimizer replaces the display only with a chosen comparison or accepted preview; otherwise the
    // editing result stays on screen, so opening or closing it never swaps timing sources.
    const comparing = optimizationOpen && Boolean(selectedPreview);
    const derivation = comparing
      ? { value: selectedPreview, path: doc, current: true, pending: false, error: null, errorKind: null }
      : { value: editing.value, path: doc, current: true, pending: editing.pending, error: null, errorKind: null };
    // Problems never block editing; they are drawn on the path and timeline. A failed timing job keeps
    // the geometry editable and offers another try.
    // A path with fewer than two waypoints is unfinished authoring (a blank first-use path, or one being drawn), not
    // a failure: no problem marks or failure notice, a placement hint instead, and Push stays unavailable.
    const unfinishedPath = (doc.waypoints?.length || 0) < 2;
    const editingFailure = editing.status === 'error' && !unfinishedPath ? editing.error : null;
    const planIssues = comparing || unfinishedPath ? [] : editing.issues;
    const derivedValue = derivation.value || PENDING_PATH_PREVIEW;
    const derived = unfinishedPath && derivedValue.checks?.length ? { ...derivedValue, checks: [] } : derivedValue;
    const derivationCurrent = derivation.current;
    const reverseDistance = currentPathLength(derivation);
    useEffect(() => { if (!derivationCurrent) playbackStore.pause(); }, [derivationCurrent, playbackStore]);

    // The editor keeps provisional previews visible; only a ready, current result is its selected trajectory.
    // The hook builds a new error object each render; only its message identifies the failure.
    const editingErrorMessage = editing.error?.message || null;
    // Library time is the strict trajectory's; display-only best-effort timing never counts.
    const selectedOutcome = useMemo(() => {
      if (editing.pending) return { status: 'pending' };
      if (doc.optimization?.accepted && !outdatedOptimization && !editing.acceptedTrajectory) return { status: 'error', message: 'The saved optimization could not be validated.', unvalidated: true };
      return editing.ready ? { status: 'ready', seconds: editing.trajectory.totalTimeS }
        : { status: 'error', message: editingErrorMessage || 'This path has a problem.' };
    }, [editing.pending, editing.ready, editing.trajectory, editing.acceptedTrajectory, editingErrorMessage, doc, outdatedOptimization]);
    useEffect(() => {
      libraryDurations.update(
        { paths: project.paths, robot, field: project.field, plannerId, currentPath: doc, currentKey: optimizationKey },
        { id: doc.id, ...durationResult(selectedOutcome) },
      );
    }, [libraryDurations, project.paths, robot, project.field, plannerId, doc, optimizationKey, selectedOutcome]);

    const writeDoc = useCallback((nd) => {
      setProject((pr) => replaceEditedPath(pr, nd));
    }, []);
    // Writing a path re-syncs linked positions, so its entry also touches every linked path.
    const beginHistory = useCallback(() => {
      const path = docRef.current;
      recordUndo({ scope: pathScope(path.id), touches: linkedPathIds(projectRef.current, path.id).map(pathScope), kind: 'path', path: editablePath(path) });
    }, [recordUndo]);
    const beginEdit = useCallback(() => {
      if (editStore.getSnapshot()) return;
      editStore.begin(editablePath(docRef.current));
    }, [editStore]);
    const finishEdit = useCallback(() => {
      const draft = editStore.getSnapshot();
      if (draft && JSON.stringify(authoredPath(draft)) === JSON.stringify(authoredPath(docRef.current))) {
        // Cancel unchanged gestures so retained draft previews and history both clear.
        editStore.cancel();
        return;
      }
      const next = editStore.finish();
      if (!next) return;
      beginHistory();
      writeDoc(next);
    }, [beginHistory, editStore, writeDoc]);
    const deletionEpoch = documentEpoch.current;
    const deletionContext = useRef(null);
    deletionContext.current = { page, projectKey };
    const preflightDeletion = useCallback(() => {
      if (deletionEpoch !== documentEpoch.current || projectTransitionRef.current
        || document.querySelector('dialog:modal,[role="dialog"][aria-modal="true"]')) return false;
      if (!flushProjectDraft()) return false;
      flushSync(() => finishEdit());
      return deletionEpoch === documentEpoch.current && !projectTransitionRef.current
        && !document.querySelector('dialog:modal,[role="dialog"][aria-modal="true"]');
    }, [deletionEpoch, flushProjectDraft, finishEdit]);
    const announceDeletion = (entry, message, detail) => {
      if (!entry) return;
      retireDeletion();
      const action = { id: ++deletionSequence.current, entry, scopes: entry.scope === ROUTINE_SCOPE ? [ROUTINE_SCOPE, PROJECT_SCOPE] : [PROJECT_SCOPE],
        epoch: documentEpoch.current, active: true, message, detail };
      deletionAction.current = action; setDeletionNotice(action);
    };
    const undoDeletion = (action) => {
      const eligible = () => action?.active && deletionAction.current === action && action.epoch === documentEpoch.current
        && history.peekUndo(action.scopes) === action.entry;
      if (!eligible() || !preflightDeletion() || !eligible()) return false;
      const applied = history.undo(action.scopes, (entry) => applyUndoEntryRef.current(entry));
      if (applied) { retireDeletion(); force((x) => x + 1); }
      return applied;
    };
    const cancelEdit = useCallback(() => {
      return editStore.cancel();
    }, [editStore]);
    const commit = useCallback((fn) => {
      cancelEdit();
      beginHistory();
      writeDoc(fn(editablePath(docRef.current)));
    }, [beginHistory, cancelEdit, writeDoc]);
    useEffect(() => {
      const draft = editStore.getSnapshot();
      if (draft && doc && draft.id !== doc.id) cancelEdit();
    }, [doc && doc.id, editStore, cancelEdit]);
    const mutate = useCallback((fn) => {
      const draft = editStore.getSnapshot();
      if (!draft) { writeDoc(fn(editablePath(docRef.current))); return; }
      editStore.update(fn(editablePath(draft)));
    }, [editStore, writeDoc]);

    // After a project-wide undo or redo, keep the edited path visible when it still exists.
    const showPathAfterProjectChange = (next, preferredId) => {
      const currentId = docRef.current?.id;
      const id = [preferredId, currentId].find((candidate) => candidate && next.paths.some((path) => path.id === candidate));
      const index = id ? next.paths.findIndex((path) => path.id === id) : Math.max(0, Math.min(activeIdx, next.paths.length - 1));
      setActiveIdx(index); setSel({ kind: null, idx: -1 });
      if (next.paths[index].id !== currentId) playbackStore.reset();
    };
    /** Performs one journal entry and returns the entry that reverses it, or null to keep it. */
    const applyUndoEntry = (entry) => {
      const current = projectRef.current;
      if (entry.kind === 'path') {
        const path = current.paths.find((candidate) => candidate.id === entry.path.id);
        if (!path) return null;
        writeDoc(withLibraryFields(entry.path, path));
        return { ...entry, path: editablePath(path) };
      }
      if (entry.kind === 'routines') {
        // Restored synchronously, as commits are, so a second history step before render inverts this state;
        // the functional update keeps unrelated project changes queued since.
        const inverse = { ...entry, state: clone(routineState(current)) }, restored = clone(entry.state);
        branchGeneration.current += 1;
        projectRef.current = promoteRoutineProjectSchema(withRoutineState(current, restored));
        setProject((value) => promoteRoutineProjectSchema(withRoutineState(value, restored))); setRoutineSel(null);
        return inverse;
      }
      const applied = applyProjectEntry(current, entry, docRef.current?.id ?? null);
      if (!applied) return null;
      const removed = current.paths.filter((path) => !applied.project.paths.some((candidate) => candidate.id === path.id));
      const referenced = removed.find((path) => referencingRoutines(routineState(current).routines, path.id).length);
      if (referenced) {
        alert('“' + referenced.name + '” is used by ' + referencingRoutines(routineState(current).routines, referenced.id).map((item) => item.name).join(', ') + '. Remove those steps before deleting the path.');
        return null;
      }
      setProject(applied.project);
      // Shared-position and folder entries keep the current path; project entries show the path they changed.
      if (entry.kind === 'project') showPathAfterProjectChange(applied.project, entry.change.activePathId);
      return applied.inverse;
    };
    const applyUndoEntryRef = useRef(applyUndoEntry); applyUndoEntryRef.current = applyUndoEntry;
    const scopes = undoScopes(page, doc.id);
    const scopeKey = scopes.join('\n');
    const stepHistory = (direction) => () => {
      if (cancelEdit()) { retireDeletion(); return; }
      if (history[direction](scopeKey.split('\n'), (entry) => applyUndoEntryRef.current(entry))) { retireDeletion(); force((x) => x + 1); }
    };
    const undo = useCallback(stepHistory('undo'), [cancelEdit, history, scopeKey, retireDeletion]);
    const redo = useCallback(stepHistory('redo'), [cancelEdit, history, scopeKey, retireDeletion]);

    const select = useCallback((kind, idx) => {
      commitFocusedDraft();
      setSel(kind ? { kind, idx } : { kind: null, idx: -1 });
    }, []);
    const moveWaypoint = useCallback((i, point) => mutate((path) => moveWaypointTo(path, i, point)), [mutate]);
    const moveHandle = useCallback((i, which, p) => mutate((d) => {
      const w = d.waypoints[i]; const key = which ? 'nextC' : 'prevC'; const other = which ? 'prevC' : 'nextC';
      w[key] = { x: p.x, y: p.y };
      if (!w.stop && i > 0 && i < d.waypoints.length - 1) {
        const ol = Math.hypot(w[other].x - w.x, w[other].y - w.y);
        const ang = Math.atan2(p.y - w.y, p.x - w.x) + Math.PI;
        w[other] = { x: w.x + Math.cos(ang) * ol, y: w.y + Math.sin(ang) * ol };
        w.linked = true; w.corner = false;
      }
      return d;
    }), [mutate]);
    const prepareWaypointInsertion = useCallback((rawPoint, segmentHint, onPath, selectedVisit) => {
      const p = clampWorld(rawPoint);
      const candidate = editablePath(docRef.current);
      const wps = candidate.waypoints, oldCount = wps.length;
      const pts = derived.sample.pts || [];
      const f = selectedVisit && Number.isFinite(selectedVisit.f)
        ? selectedVisit.f
        : (pts.length > 1 ? PM.nearestFraction(p.x, p.y, pts) : 0.5);
      let segment = Number.isInteger(segmentHint) ? segmentHint : (selectedVisit && Number.isInteger(selectedVisit.seg) ? selectedVisit.seg : 0);
      if (!Number.isInteger(segmentHint) && derived.wpFrac && derived.wpFrac.length > 1) {
        for (let i = 0; i < derived.wpFrac.length - 1; i++) {
          if (f >= derived.wpFrac[i] - 1e-6) segment = i;
        }
      }
      segment = Math.max(0, Math.min(oldCount - 2, segment));
      const insertAt = segment + 1;
      const selectedT = selectedVisit && Number.isFinite(selectedVisit.t)
        ? selectedVisit.t
        : (derived.wpFrac && derived.wpFrac.length > segment + 1
          ? (f - derived.wpFrac[segment]) / Math.max(1e-9, derived.wpFrac[segment + 1] - derived.wpFrac[segment])
          : null);
      const nearest = onPath && selectedVisit && selectedVisit.seg === segment && Number.isFinite(selectedVisit.x) && Number.isFinite(selectedVisit.y)
        ? { x: selectedVisit.x, y: selectedVisit.y, t: selectedT, heading: selectedVisit.heading || 0 }
        : (onPath && pts.length > 1 ? PM.nearestPointOnSegment(p, pts, segment) : null);
      const projected = nearest || p;
      const originalType = (wps[segment] && wps[segment].segType) || 'bezier';
      const nw = { x: projected.x, y: projected.y, linked: true, thetaOn: false, theta: 0, stop: false, segType: originalType };
      if (wps[segment] && wps[segment].segmentHeadingMode) nw.segmentHeadingMode = wps[segment].segmentHeadingMode;
      if (wps[segment] && wps[segment].segmentFollowMode) nw.segmentFollowMode = wps[segment].segmentFollowMode;
      if (wps[segment] && wps[segment].segmentLookAt) nw.segmentLookAt = { ...wps[segment].segmentLookAt };
      let previewRequired = false;

      // The original cubic planners can be split exactly with de Casteljau,
      // preserving the authored curve instead of reshaping both neighboring spans.
      if (onPath && originalType === 'bezier' && (plannerId === 'profiledSpline' || plannerId === 'optimizedTrajectory')) {
        const a = wps[segment], b = wps[segment + 1], t = nearest && Number.isFinite(nearest.t) ? Math.max(0.001, Math.min(0.999, nearest.t)) : 0.5;
        if (a && b && a.nextC && b.prevC) {
          const split = PM.splitBezier(a, a.nextC, b.prevC, b, t);
          nw.x = split.point.x; nw.y = split.point.y; nw.prevC = split.left[2]; nw.nextC = split.right[1];
          a.nextC = split.left[1]; b.prevC = split.right[2];
        }
      } else if (onPath && (originalType === 'arc' || originalType === 'clothoid') && nearest) {
        // These segment solvers are endpoint/tangent based. Seed both sides with
        // the measured tangent, then require a preview because adding the joint
        // can make the solver choose a different valid construction.
        const a = wps[segment], b = wps[segment + 1];
        const handle = Math.max(0.15, Math.min(Math.hypot(nw.x - a.x, nw.y - a.y), Math.hypot(b.x - nw.x, b.y - nw.y)) / 3);
        nw.prevC = { x: nw.x - Math.cos(nearest.heading) * handle, y: nw.y - Math.sin(nearest.heading) * handle };
        nw.nextC = { x: nw.x + Math.cos(nearest.heading) * handle, y: nw.y + Math.sin(nearest.heading) * handle };
        previewRequired = true;
      }

      wps.splice(insertAt, 0, nw);
      remapWaypointRanges(candidate, Array.from({ length: oldCount }, (_, index) => index < insertAt ? index : index + 1));
      if (!nw.prevC || !nw.nextC) {
        const hd = PM.autoHandles(wps, insertAt);
        nw.prevC = hd.prevC; nw.nextC = hd.nextC;
      }
      candidate._selAfter = insertAt;
      return { doc: candidate, index: insertAt, previewRequired, segmentType: originalType };
    }, [derived, plannerId]);

    const addWaypoint = useCallback((p, segmentHint, onPath, selectedVisit) => {
      const prepared = prepareWaypointInsertion(p, segmentHint, onPath, selectedVisit);
      if (prepared.previewRequired) {
        const message = 'Splitting this ' + prepared.segmentType + ' may rebuild its geometry. Review the dashed path first.';
        setWaypointPreviewRequest({ ...prepared, plannerId, message });
        return;
      }
      commit(() => prepared.doc);
    }, [commit, plannerId, prepareWaypointInsertion]);
    const appendWaypoint = useCallback((rawPoint) => {
      const point = clampWorld(rawPoint);
      const candidate = editablePath(docRef.current);
      const wps = candidate.waypoints, oldCount = wps.length;
      if (!oldCount) {
        // The first point of an empty (first-use) path: the same waypoint shape a new path starts with.
        wps.push(buildWps([{ x: point.x, y: point.y, theta: 0, segType: 'bezier' }])[0]);
        candidate._selAfter = 0;
        commit(() => candidate);
        return;
      }
      const end = wps[oldCount - 1], before = wps[oldCount - 2] || end;
      const dx = point.x - end.x, dy = point.y - end.y, distance = Math.hypot(dx, dy);
      if (distance < 0.05) return;

      const ux = dx / distance, uy = dy / distance;
      const incomingX = end.prevC ? end.x - end.prevC.x : end.x - before.x;
      const incomingY = end.prevC ? end.y - end.prevC.y : end.y - before.y;
      const incomingLength = Math.hypot(incomingX, incomingY);
      const tx = !end.stop && incomingLength > 1e-6 ? incomingX / incomingLength : ux;
      const ty = !end.stop && incomingLength > 1e-6 ? incomingY / incomingLength : uy;
      const handle = Math.max(0.15, distance / 3);
      const segmentType = end.segType || before.segType || 'bezier';
      const endpointJiggle = end.jiggle ? { ...end.jiggle } : null;
      delete end.jiggle;
      end.segType = segmentType;
      if (before.segmentHeadingMode) end.segmentHeadingMode = before.segmentHeadingMode;
      else delete end.segmentHeadingMode;
      if (before.segmentFollowMode) end.segmentFollowMode = before.segmentFollowMode;
      else delete end.segmentFollowMode;
      if (before.segmentLookAt) end.segmentLookAt = { ...before.segmentLookAt };
      else delete end.segmentLookAt;
      end.nextC = { x: end.x + tx * handle, y: end.y + ty * handle };
      if (!end.stop) { end.linked = true; end.corner = false; }

      const next = {
        x: point.x, y: point.y,
        prevC: { x: point.x - ux * handle, y: point.y - uy * handle },
        nextC: { x: point.x + ux * handle, y: point.y + uy * handle },
        linked: true, thetaOn: true, theta: end.theta || 0, stop: false,
      };
      if (endpointJiggle) next.jiggle = endpointJiggle;
      wps.push(next);
      remapWaypointRanges(candidate, Array.from({ length: oldCount }, (_, index) => index));
      candidate._selAfter = oldCount;

      if (segmentType === 'clothoid') {
        const message = 'This join may rebuild the previous turn. Review the dashed path.';
        setWaypointPreviewRequest({ doc: candidate, index: oldCount, plannerId, message, actionLabel: 'Place endpoint' });
        return;
      }
      commit(() => candidate);
    }, [commit, plannerId]);
    const setJiggle = useCallback((options) => {
      if (!options) {
        commit((d) => { delete d.waypoints[d.waypoints.length - 1].jiggle; return d; });
        return true;
      }
      const config = {
        distanceM: Math.max(0.03, Math.min(1.5, Number(options.distanceM))),
        strokes: Math.max(2, Math.min(12, Math.round(Number(options.strokes)))),
        startDeg: Number(options.startDeg),
        stepDeg: Number(options.stepDeg),
        strokeTimeS: Math.max(0.08, Math.min(5, Number(options.strokeTimeS))),
      };
      if (!Object.values(config).every(Number.isFinite)) return false;
      const anchor = docRef.current.waypoints[docRef.current.waypoints.length - 1];
      const lastIndex = Math.max(0, (derived.wpIdx && derived.wpIdx[docRef.current.waypoints.length - 1]) || 0);
      const baseRad = anchor.turnInPlace
        ? anchor.turnInPlace.headingDeg * Math.PI / 180
        : derived.metrics && derived.metrics.head ? derived.metrics.head[lastIndex] : (anchor.theta || 0) * Math.PI / 180;
      const physicalBaseRad = baseRad + (derived.rev ? Math.PI : 0);
      if (!PM.jigglePositions(anchor, physicalBaseRad, config, { w: FIELD_W, h: FIELD_H })) return false;
      commit((d) => {
        d.waypoints[d.waypoints.length - 1].jiggle = config;
        d.goalVel = 0;
        return d;
      });
      return true;
    }, [commit, derived]);
    const applyWaypointPreview = useCallback(() => {
      if (!waypointPreview?.derived) return;
      commit(() => waypointPreview.doc);
      setWaypointPreviewRequest(null);
    }, [commit, waypointPreview]);
    useEffect(() => { setWaypointPreviewRequest(null); }, [doc, robot, plannerId]);
    useEffect(() => { if (doc._selAfter != null) { select('wp', doc._selAfter); mutate((d) => { delete d._selAfter; return d; }); } }, [doc._selAfter]);

    const setWp = useCallback((i, patch) => {
      if (!docRef.current.waypoints[i]) return;
      return commit((d) => {
        const w = d.waypoints[i];
        if (patch.x != null || patch.y != null) {
          const next = clampWorld({ x: patch.x != null ? patch.x : w.x, y: patch.y != null ? patch.y : w.y });
          moveWaypointTo(d, i, next);
          patch = { ...patch, x: next.x, y: next.y };
        }
        Object.assign(w, patch);
        if (patch.theta != null && i === 0) setWaypointFacing(d, i, patch.theta);
        return d;
      });
    }, [commit]);
    const setWaypointPositionLink = (index, target) => {
      const before = materializeProject();
      finishEdit();
      let next = target
        ? PathLinks.linkPosition(before, doc.id, index, target.pathId, target.index, pathLinkId())
        : PathLinks.unlinkPosition(before, doc.id, index);
      // An unnamed new group gets one name in the same change, so both points show it and one Undo removes it.
      if (target && next !== before) next = PathLinks.nameNewSharedPoint(next, doc.id, index);
      return commitWaypointProject(before, next) ? 'applied' : 'unchanged';
    };
    // Shared-position edits belong to the active path; deletions, library links, and applied
    // proposals are project-wide. Both restore only what they changed.
    const commitProjectChange = (before, next, scope = PROJECT_SCOPE) => {
      if (next === before) return;
      const entry = recordUndo({ scope, kind: scope === PROJECT_SCOPE ? 'project' : 'waypoints', ...captureProjectChange(before, next, docRef.current?.id ?? null) });
      projectRef.current = next; setProject(next);
      return entry;
    };
    const commitWaypointProject = (before, next) => commitProjectChange(before, next, pathScope(docRef.current.id));
    const flipPlanning = useMemo(() => FinalPlanning.create(), []);
    const flipPaths = async () => {
      if (!preflightDeletion()) return;
      const before = projectRef.current;
      const result = await flipPlanning.request({ mode: 'flip', project: before }, {
        deadline: 'hard', failureNote: 'The paths were not changed.',
      }).promise;
      // A delayed worker response cannot overwrite intervening edits or a new project.
      if (projectRef.current !== before) return;
      if (result.status !== 'success') { alert(result.error?.message || result.fallbackReason); return; }
      if (!preflightDeletion() || projectRef.current !== before) return;
      commitProjectChange(before, result.value);
      playbackStore.reset(); routinePlaybackStore.reset();
      setComparison(null);
    };
    const toggleTheta = useCallback((i, on) => commit((d) => { d.waypoints[i].thetaOn = on; return d; }), [commit]);
    const setHandleLen = useCallback((i, key, len) => commit((d) => { const w = d.waypoints[i]; const a = Math.atan2(w[key].y - w.y, w[key].x - w.x); w[key] = { x: w.x + Math.cos(a) * len, y: w.y + Math.sin(a) * len }; return d; }), [commit]);
    // Resolve the owning draft before field, timeline or inspector deletion. Invalid drafts
    // retain their owner; a valid draft renders before the deletion reads the path.
    const deleteFeature = useCallback((remove) => {
      if (!preflightDeletion()) return false;
      commit(remove); select(null, -1);
      return true;
    }, [preflightDeletion, commit, select]);
    const delWp = useCallback((i) => deleteFeature((d) => removeWaypoint(d, i)), [deleteFeature]);

    const enableTargetsAtFraction = (d, f) => {
      if (d.waypoints.length < 2) return;
      const fractions = derived.wpFrac || PM.waypointFracs(d, derived.sample);
      let segment = 0;
      for (let i = 0; i < d.waypoints.length - 1; i++) {
        if (f >= (fractions[i] || 0) - 1e-6) segment = i;
      }
      segment = Math.max(0, Math.min(d.waypoints.length - 2, segment));
      d.waypoints[segment].segmentHeadingMode = 'targets';
    };
    const addTargetAt = useCallback((p, visitFraction) => commit((d) => {
      const pts = derived.sample.pts;
      const f = Number.isFinite(visitFraction) ? visitFraction : (pts.length > 1 ? PM.nearestFraction(p.x, p.y, pts) : 0.5);
      const deg = pts.length > 1 ? PM.pointAtFraction(f, pts).heading * 180 / Math.PI : 0;
      d.targets.push({ f, deg });
      enableTargetsAtFraction(d, f);
      d._selT = d.targets.length - 1;
      return d;
    }), [commit, derived]);
    // A placed command opens its search once (transient; neither document nor history). The id is made once, outside the commit.
    const [commandPick, setCommandPick] = useState(null);
    const commandPickSeq = useRef(0);
    const addMarkerAt = useCallback((p, visitFraction) => {
      const id = markerId();
      commit((d) => { const f = Number.isFinite(visitFraction) ? visitFraction : (derived.sample.pts.length > 1 ? PM.nearestFraction(p.x, p.y, derived.sample.pts) : 0.5); d.markers.push({ id, f, name: 'event' + (d.markers.length + 1), cmd: 'none', group: 'sequential' }); d._selM = d.markers.length - 1; return d; });
      setCommandPick(commandPickRequest(++commandPickSeq.current, { catalog: robotProjectState.catalog, status: robotProjectState.status, documentKey: projectKey, pathId: doc.id, markerId: id }));
    }, [commit, derived, robotProjectState.catalog, robotProjectState.status, projectKey, doc.id]);
    useEffect(() => { if (doc._selT != null) { select('rt', doc._selT); mutate((d) => { delete d._selT; return d; }); } }, [doc._selT]);
    useEffect(() => { if (doc._selM != null) { select('em', doc._selM); mutate((d) => { delete d._selM; return d; }); } }, [doc._selM]);
    // After the selection effect above: the chooser reads the request at mount in the render that selects its marker.
    useEffect(() => {
      if (retireCommandPick(commandPick, { projectKey, docId: doc.id, markers: doc.markers, sel, selPending: doc._selM != null })) setCommandPick(clearCommandPick(commandPick.token));
    }, [commandPick, sel, doc.id, doc.markers, doc._selM, projectKey]);

    const moveTargetTo = useCallback((i, p, visitFraction) => mutate((d) => { const t = d.targets[i]; if (!t) return d; const f = Number.isFinite(visitFraction) ? visitFraction : PM.nearestFraction(p.x, p.y, derived.sample.pts); t.f = f; if (t.anchor === 'dist') t.d = +(f * (derived.sample.length || 0)).toFixed(3); return d; }), [mutate, derived]);
    const rotateTargetTo = useCallback((i, p, snap) => mutate((d) => {
      const target = d.targets[i]; if (!target) return d;
      const f = PM.featureFraction(target, derived.sample);
      const center = PM.pointAtFraction(f, derived.sample.pts);
      let deg = Math.atan2(p.y - center.y, p.x - center.x) * 180 / Math.PI;
      if (snap) deg = Math.round(deg / 15) * 15;
      target.deg = Math.round(deg * 10) / 10;
      return d;
    }), [mutate, derived]);
    const moveMarkerTo = useCallback((i, p, visitFraction) => mutate((d) => { const m = d.markers[i]; if (!m) return d; const f = Number.isFinite(visitFraction) ? visitFraction : PM.nearestFraction(p.x, p.y, derived.sample.pts); m.f = f; if (m.anchor === 'dist') m.d = +(f * (derived.sample.length || 0)).toFixed(3); return d; }), [mutate, derived]);
    const setFeature = (items, i, patch) => { const item = items[i]; if (!item) return; if (patch.anchor) { const f = PM.featureFraction(item, derived.sample); item.f = f; if (patch.anchor === 'dist') item.d = f * (derived.sample.length || 0); else delete item.d; } Object.assign(item, patch); };
    const setTarget = useCallback((i, patch) => commit((d) => { setFeature(d.targets, i, patch); return d; }), [commit, derived]);
    const delTarget = useCallback((i) => deleteFeature((d) => { d.targets.splice(i, 1); return d; }), [deleteFeature]);
    const setMarker = useCallback((i, patch) => commit((d) => { setFeature(d.markers, i, patch); return d; }), [commit, derived]);
    const delMarker = useCallback((i) => deleteFeature((d) => { d.markers.splice(i, 1); return d; }), [deleteFeature]);

    const addRange = useCallback((f0, f1) => commit((d) => {
      if (!d.ranges) d.ranges = [];
      const a = Math.max(0, Math.min(f0, f1)), b = Math.min(1, Math.max(f0, f1));
      d.ranges.push({ f0: a, f1: b, anchor: 'param' });
      d._selR = d.ranges.length - 1; return d;
    }), [commit]);
    const setRange = useCallback((i, patch) => commit((d) => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete d.ranges[i][key];
        else d.ranges[i][key] = value;
      }
      return d;
    }), [commit]);
    const localRangeEndpoint = (fraction, fractions) => {
      const f = Math.max(0, Math.min(1, fraction));
      let segment = Math.max(0, fractions.length - 2);
      for (let i = 0; i < fractions.length - 1; i++) {
        if (f <= fractions[i + 1] + 1e-9) { segment = i; break; }
      }
      const lo = fractions[segment] || 0, hi = fractions[segment + 1] != null ? fractions[segment + 1] : lo;
      return { waypoint: segment, local: hi > lo ? Math.max(0, Math.min(1, (f - lo) / (hi - lo))) : 0 };
    };
    const setRangeAnchor = useCallback((i, anchor) => commit((d) => {
      const range = d.ranges[i]; if (!range) return d;
      const effective = (derived.effRanges && derived.effRanges[i]) || range;
      const f0 = effective.f0 || 0, f1 = effective.f1 || 0;
      range.f0 = f0; range.f1 = f1; range.anchor = anchor;
      if (anchor === 'dist') {
        const length = derived.sample.length || 0;
        range.d0 = f0 * length; range.d1 = f1 * length;
        delete range.w0; delete range.w1; delete range.t0; delete range.t1;
      } else if (anchor === 'wp') {
        const fractions = PM.waypointFracs(d, derived.sample);
        const start = localRangeEndpoint(f0, fractions), end = localRangeEndpoint(f1, fractions);
        range.w0 = start.waypoint; range.t0 = start.local; range.w1 = end.waypoint; range.t1 = end.local;
        delete range.d0; delete range.d1;
      } else {
        delete range.d0; delete range.d1; delete range.w0; delete range.w1; delete range.t0; delete range.t1;
      }
      return d;
    }), [commit, derived]);
    const delRange = useCallback((i) => deleteFeature((d) => { d.ranges.splice(i, 1); return d; }), [deleteFeature]);
    // Moves one zone end in its own anchor: distance, waypoint-local, or path fraction.
    const placeRangeEnd = (d, i, which, f) => {
      const rg = d.ranges[i]; if (!rg) return d;
      const key = which ? 'f1' : 'f0'; const cf = Math.max(0, Math.min(1, f));
      const len = derived.sample.length || 1;
      if (rg.anchor === 'dist') { rg[which ? 'd1' : 'd0'] = +(cf * len).toFixed(2); }
      else if (rg.anchor === 'wp') {
        const wf = PM.waypointFracs(d, derived.sample);
        const local = localRangeEndpoint(cf, wf);
        rg[which ? 'w1' : 'w0'] = local.waypoint; rg[which ? 't1' : 't0'] = local.local;
      }
      else { rg[key] = cf; }
      return d;
    };
    const moveRangeHandle = useCallback((i, which, f) => mutate((d) => placeRangeEnd(d, i, which, f)), [mutate, derived]);
    const setRangeEnd = useCallback((i, which, f) => {
      const source = docRef.current;
      if (!source.ranges[i]) return;
      const next = placeRangeEnd(editablePath(source), i, which, f);
      // Compare the authored endpoint after anchor conversion and rounding.
      if (JSON.stringify(next.ranges[i]) === JSON.stringify(source.ranges[i])) return;
      commit(() => next);
    }, [commit, derived]);
    const addRangeAt = useCallback((f) => addRange(Math.max(0, f - 0.08), Math.min(1, f + 0.08)), [addRange]);
    const addSlowZone = useCallback((f0, f1, maxVel) => commit((d) => {
      if (!d.ranges) d.ranges = [];
      d.ranges.push({ f0, f1, anchor: 'param', maxVel, name: 'Slow' });
      d._selR = d.ranges.length - 1; return d;
    }), [commit]);
    useEffect(() => { if (doc._selR != null) { select('cr', doc._selR); mutate((d) => { delete d._selR; return d; }); } }, [doc._selR]);

    const setConstraint = useCallback((patch) => commit((d) => { Object.assign(d.constraints, patch); return d; }), [commit]);
    const setDoc = useCallback((patch) => commit((d) => Object.assign(d, patch)), [commit]);
    const setRobot = useCallback((patch) => {
      setProject((pr) => ({ ...pr, robot: { ...pr.robot, ...patch } }));
    }, []);

    const addTargetMid = useCallback(() => commit((d) => {
      const pts = derived.sample.pts;
      const deg = pts.length > 1 ? PM.pointAtFraction(0.5, pts).heading * 180 / Math.PI : 0;
      d.targets.push({ f: 0.5, deg });
      enableTargetsAtFraction(d, 0.5);
      d._selT = d.targets.length - 1;
      return d;
    }), [commit, derived]);
    const addMarkerMid = useCallback(() => commit((d) => { d.markers.push({ id: markerId(), f: 0.5, name: 'event' + (d.markers.length + 1), cmd: 'none', group: 'sequential' }); d._selM = d.markers.length - 1; return d; }), [commit]);
    const addRangeMid = useCallback(() => addRange(0.35, 0.6), [addRange]);

    const setSegMeta = useCallback((i, patch) => commit((d) => { Object.assign(d.waypoints[i], patch); return d; }), [commit]);
    const setSegmentHeadingMode = useCallback((i, mode) => commit((d) => {
      const w = d.waypoints[i], next = d.waypoints[i + 1];
      if (mode === 'inherit') delete w.segmentHeadingMode;
      else w.segmentHeadingMode = mode;
      if (mode === 'lookAt' && !w.segmentLookAt && next) {
        const dx = next.x - w.x, dy = next.y - w.y, length = Math.hypot(dx, dy) || 1;
        w.segmentLookAt = clampWorld({ x: (w.x + next.x) / 2 - dy / length * 1.25, y: (w.y + next.y) / 2 + dx / length * 1.25 });
      }
      return d;
    }), [commit]);
    const setSegmentLookAt = useCallback((i, patch) => commit((d) => {
      const w = d.waypoints[i]; if (!w) return d;
      w.segmentLookAt = clampWorld({ x: patch.x != null ? patch.x : w.segmentLookAt.x, y: patch.y != null ? patch.y : w.segmentLookAt.y });
      return d;
    }), [commit]);
    const moveSegmentLookAt = useCallback((i, point) => mutate((d) => {
      const w = d.waypoints[i]; if (w) w.segmentLookAt = clampWorld(point); return d;
    }), [mutate]);
    const setStop = useCallback((i, on) => commit((d) => { const w = d.waypoints[i]; w.stop = on; if (on) { w.linked = false; } else { alignWaypointHandles(w); delete w.wait; delete w.turnInPlace; } return d; }), [commit]);
    const setWait = useCallback((i, sec) => commit((d) => { d.waypoints[i].wait = Math.max(0, sec); return d; }), [commit]);
    const setTurnInPlace = useCallback((i, on) => commit((d) => {
      const w = d.waypoints[i]; if (!w) return d;
      if (!on) delete w.turnInPlace;
      else {
        const sampleIndex = Math.max(0, ((derived.wpIdx && derived.wpIdx[i]) || 0) - (i > 0 ? 1 : 0));
        const arrival = derived.metrics && derived.metrics.head ? derived.metrics.head[sampleIndex] * 180 / Math.PI : (w.theta || 0);
        const headingDeg = Math.round(arrival + 90);
        w.turnInPlace = { headingDeg, direction: 'shortest' };
        w.stop = true; w.linked = false;
        if (i < d.waypoints.length - 1) { w.theta = headingDeg; w.thetaOn = true; w.segmentHeadingMode = 'manual'; }
      }
      return d;
    }), [commit, derived]);
    const setTurnInPlaceMeta = useCallback((i, patch) => commit((d) => {
      const w = d.waypoints[i]; if (!w || !w.turnInPlace) return d;
      Object.assign(w.turnInPlace, patch);
      if (patch.headingDeg != null && i < d.waypoints.length - 1) { w.theta = patch.headingDeg; w.thetaOn = true; w.segmentHeadingMode = 'manual'; }
      return d;
    }), [commit]);
    const setHeadingMode = useCallback((m) => commit((d) => { d.headingMode = m; return d; }), [commit]);
    const toggleDriveBackward = useCallback(() => commit((d) => { d.driveBackward = !d.driveBackward; return d; }), [commit]);
    // Reordering lives with the full inspector now that the plan page has no outline list.
    const moveWpOrder = useCallback((i, direction) => {
      const target = i + direction;
      if (target < 0 || target >= docRef.current.waypoints.length) return;
      commit((d) => reorderWaypoint(d, i, target));
      select('wp', target);
    }, [commit, select]);
    const nudgeWp = useCallback((i, dx, dy) => commit((path) => {
      const waypoint = path.waypoints[i];
      return waypoint ? moveWaypointTo(path, i, { x: waypoint.x + dx, y: waypoint.y + dy }) : path;
    }), [commit]);
    const nudgeFrac = useCallback((kind, i, df) => commit((d) => {
      const arr = kind === 'rt' ? d.targets : d.markers; const item = arr[i]; if (!item) return d;
      const f = Math.max(0, Math.min(1, PM.featureFraction(item, derived.sample) + df));
      item.f = f; if (item.anchor === 'dist') item.d = +(f * (derived.sample.length || 0)).toFixed(3);
      return d;
    }), [commit, derived]);
    const setWaypointHeading = useCallback((i, deg) => mutate((d) => setWaypointFacing(d, i, deg)), [mutate]);
    const faceWaypoint = useCallback((i, mode) => {
      if (!docRef.current.waypoints[i]) return;
      return commit((d) => {
        const w = d.waypoints[i]; let deg = w.theta || 0;
        if (mode === 'next' && d.waypoints[i + 1]) { const t = d.waypoints[i + 1]; deg = Math.atan2(t.y - w.y, t.x - w.x) * 180 / Math.PI; }
        else if (mode === 'prev' && d.waypoints[i - 1]) { const t = d.waypoints[i - 1]; deg = Math.atan2(t.y - w.y, t.x - w.x) * 180 / Math.PI; }
        else if (mode === 'tangent') { const idx = (derived.wpIdx && derived.wpIdx[i]) || 0; const p = derived.sample.pts[idx]; if (p) deg = (p.heading || 0) * 180 / Math.PI; }
        return setWaypointFacing(d, i, deg - (i === 0 && d.driveBackward ? 180 : 0));
      });
    }, [commit, derived]);
    const headingMenu = useCallback((i, x, y, returnFocus) => {
      setHeadMenu({ x, y, returnFocus, items: [
        { label: 'Face next waypoint', icon: 'compass', onClick: () => faceWaypoint(i, 'next') },
        { label: 'Face previous waypoint', icon: 'compass', onClick: () => faceWaypoint(i, 'prev') },
        { label: 'Align to path tangent', icon: 'route', onClick: () => faceWaypoint(i, 'tangent') },
        { sep: true },
        { label: 'Type exact angle\u2026', icon: 'compass', onClick: () => { setOptimizationOpen(false); setComparison(null); setInspectorOpen(true); select('wp', i); } },
      ] });
    }, [faceWaypoint, select]);
    const duplicateWp = useCallback((i) => commit((d) => duplicateWaypoint(d, i)), [commit]);
    const reversePath = useCallback(() => reverseDistance == null || docRef.current.waypoints.length < 2 ? undefined : commit((path) => { reversePathDraft(path); return PM.reversePathAnchors(path, reverseDistance); }), [commit, reverseDistance]);
    const reorderWp = useCallback((from, to) => commit((d) => reorderWaypoint(d, from, to)), [commit]);
    const insertWp = useCallback((i) => {
      const pts = derived.sample.pts;
      if (!pts || pts.length < 2) return;
      const lo = derived.wpFrac && Number.isFinite(derived.wpFrac[i]) ? derived.wpFrac[i] : i / Math.max(1, doc.waypoints.length - 1);
      const hi = derived.wpFrac && Number.isFinite(derived.wpFrac[i + 1]) ? derived.wpFrac[i + 1] : (i + 1) / Math.max(1, doc.waypoints.length - 1);
      addWaypoint(PM.pointAtFraction((lo + hi) / 2, pts), i, true);
    }, [addWaypoint, derived, doc.waypoints.length]);
    const inspActions = { setWp, toggleTheta, setHandleLen, delWp, setTarget, delTarget, setMarker, delMarker, setRange, setRangeAnchor, delRange, setConstraint, setDoc, select, setTool,
      addTargetMid, addMarkerMid, addRangeMid,
      setSegMeta, setSegmentHeadingMode, setSegmentLookAt, setJiggle, faceWaypoint, duplicateWp, reversePath, canReversePath: reverseDistance != null && doc.waypoints.length >= 2, reorderWp, insertWp,
      setStop, setWait, setTurnInPlace, setTurnInPlaceMeta, setHeadingMode, toggleDriveBackward, moveWpOrder,
      openInspector };
    const fieldActions = { addWaypoint, appendWaypoint, moveWaypoint, moveHandle, addTargetAt, addMarkerAt, moveTargetTo, rotateTargetTo, moveMarkerTo, addRange, moveRangeHandle, beginEdit, finishEdit, cancelEdit,
      setWaypointHeading, moveSegmentLookAt, headingMenu, faceWaypoint, delWp, delTarget, delMarker, delRange,
      openInspector,
      select };

    const uniquePathName = (base) => uniqueItemName(project.paths, base);
    // Path history stays with its path; switching only changes which scope Undo applies to.
    const resetForPath = (i) => {
      if (page !== 'plan') retireDeletion(true);
      commitFocusedDraft();
      finishEdit();
      routinePlaybackStore.reset();
      setActiveIdx(i); setSel({ kind: null, idx: -1 }); playbackStore.reset();
      setPage('plan');
    };
    const updatePathLibrary = (update) => {
      finishEdit();
      setProject(update);
    };
    const addPath = (folderId) => {
      finishEdit();
      const name = uniquePathName('New path'), index = project.paths.length;
      const path = blankPath(name, robot); if (folderId) path.folderId = folderId;
      setProject((pr) => ({ ...pr, paths: [...pr.paths, path] })); resetForPath(index);
      return { index, name, id: path.id, folderId: path.folderId };
    };
    const appendPath = (sourceId) => {
      const paths = materializeProject().paths;
      const source = sourceId ? paths.find((path) => path.id === sourceId) : paths[activeIdx]; if (!source?.waypoints.length) return null;
      finishEdit();
      const name = uniquePathName('New path'), index = project.paths.length, path = blankPath(name, robot);
      const start = source.waypoints[source.waypoints.length - 1], angle = (start.theta || 0) * Math.PI / 180;
      let end = clampWorld({ x: start.x + Math.cos(angle) * 2.8, y: start.y + Math.sin(angle) * 2.8 });
      if (Math.hypot(end.x - start.x, end.y - start.y) < 0.75) {
        const towardCenter = Math.atan2(FIELD_H / 2 - start.y, FIELD_W / 2 - start.x);
        end = clampWorld({ x: start.x + Math.cos(towardCenter) * 2.8, y: start.y + Math.sin(towardCenter) * 2.8 });
      }
      path.waypoints = buildWps([{ x: start.x, y: start.y, theta: start.theta || 0 }, { x: end.x, y: end.y, theta: start.theta || 0 }]);
      if (source.folderId) path.folderId = source.folderId;
      const link = { id: pathLinkId(), fromPathId: source.id, toPathId: path.id };
      setProject((pr) => ({ ...pr, paths: [...pr.paths, path], pathLinks: [...(pr.pathLinks || []).filter((item) => item.fromPathId !== source.id), link] }));
      resetForPath(index); return { index, name, id: path.id, folderId: path.folderId };
    };
    const setPathLink = (fromPathId, toPathId) => {
      const pr = materializeProject(); finishEdit();
      let pathLinks = (pr.pathLinks || []).filter((link) => link.fromPathId !== fromPathId);
      // Library links can join paths other than the active one, so they are project-wide history.
      if (!toPathId || fromPathId === toPathId) {
        if (pathLinks.length !== (pr.pathLinks || []).length) commitProjectChange(pr, { ...pr, pathLinks });
        return;
      }
      pathLinks = pathLinks.filter((link) => link.toPathId !== toPathId);
      const paths = pr.paths.slice(), source = paths.find((path) => path.id === fromPathId), targetIndex = paths.findIndex((path) => path.id === toPathId);
      if (!source || targetIndex < 0) return;
      const target = editablePath(paths[targetIndex]), end = source.waypoints[source.waypoints.length - 1];
      if (!end || !target.waypoints[0]) return;
      target.waypoints[0] = PathLinks.copyPose(target.waypoints[0], end); paths[targetIndex] = target;
      const next = { ...pr, paths, pathLinks: [...pathLinks, { id: pathLinkId(), fromPathId, toPathId }] };
      commitProjectChange(pr, PathLinks.sync(next, target.id, pr.paths[targetIndex]));
    };
    const dupPath = (i) => {
      const source = materializeProject().paths[i]; if (!source) return null;
      finishEdit();
      const name = uniquePathName(source.name + ' copy'), index = i + 1;
      const cp = duplicatePathForLibrary(source, name);
      setProject((pr) => { const paths = pr.paths.slice(); paths.splice(index, 0, cp); return { ...pr, paths }; });
      resetForPath(index); return { index, name, id: cp.id, folderId: cp.folderId };
    };
    const delPath = (id) => {
      if (!preflightDeletion()) return false;
      const before = projectRef.current, i = before.paths.findIndex((path) => path.id === id);
      if (i < 0) return false;
      const target = before.paths[i];
      const references = referencingRoutines(routineState(before).routines, target.id);
      if (references.length) { alert('“' + target.name + '” is used by ' + references.map((candidate) => candidate.name).join(', ') + '. Remove those steps before deleting the path.'); return false; }
      const pathLinks = (before.pathLinks || []).filter((link) => link.fromPathId !== target.id && link.toPathId !== target.id);
      const paths = before.paths.filter((_, k) => k !== i);
      if (!paths.length) paths.push({ ...blankPath('New path'), waypoints: [] });
      const entry = commitProjectChange(before, { ...before, paths, pathLinks: pathLinks.length === (before.pathLinks || []).length ? before.pathLinks : pathLinks });
      setActiveIdx((a) => Math.max(0, a > i ? a - 1 : a === i ? Math.min(a, before.paths.length - 2) : a));
      setSel({ kind: null, idx: -1 }); playbackStore.reset();
      announceDeletion(entry, 'Path deleted', 'Deleted path “' + target.name + '”.');
      return true;
    };
    const renamePath = (i, name) => { const clean = (name || '').trim(); if (!clean) return false; updatePathLibrary((pr) => { const paths = pr.paths.slice(); paths[i] = { ...paths[i], name: clean }; return { ...pr, paths }; }); return true; };
    const addPathFolder = () => {
      const folders = project.pathFolders || [], name = uniqueItemName(folders, 'New folder');
      const folder = { id: 'folder_' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)), name };
      setProject((pr) => ({ ...pr, pathFolders: [...(pr.pathFolders || []), folder] }));
      return folder;
    };
    const renamePathFolder = (id, name) => {
      const clean = (name || '').trim(); if (!clean) return false;
      setProject((pr) => ({ ...pr, pathFolders: (pr.pathFolders || []).map((folder) => folder.id === id ? { ...folder, name: clean } : folder) })); return true;
    };
    const deletePathFolder = (id) => {
      if (!preflightDeletion()) return false;
      const deleted = deleteFolder(projectRef.current, id);
      if (!deleted) return false;
      const entry = recordUndo({ scope: PROJECT_SCOPE, touches: [], kind: 'folder', restore: deleted.change });
      projectRef.current = deleted.project; setProject(deleted.project);
      announceDeletion(entry, 'Folder deleted · Paths kept', 'Deleted folder “' + deleted.change.folder.name + '”. Its ' + deleted.change.memberIds.length + ' paths stay in the library.');
      return true;
    };
    const movePathToFolder = (i, folderId) => updatePathLibrary((pr) => ({ ...pr, paths: pr.paths.map((path, index) => {
      if (index !== i) return path; const next = { ...path }; if (folderId) next.folderId = folderId; else delete next.folderId; return next;
    }) }));
    const setActive = (i) => { if (i === activeIdx && page === 'plan') return; setComparison(null); resetForPath(i); };
    const resetForRoutine = () => {
      setRoutineSel(null); routinePlaybackStore.reset(); setRoutineOutcomes({}); setRoutinePasses({});
    };
    const uniqueRoutineName = (base) => uniqueItemName(routines, base);
    const setActiveRoutine = (id) => {
      if (page !== 'auto') retireDeletion(true);
      if (id === routine.id && page === 'auto') return;
      commitFocusedDraft(); finishEdit(); playbackStore.reset();
      if (!routines.some((candidate) => candidate.id === id)) return;
      if (id !== routine.id) branchGeneration.current += 1;
      setProject((current) => withRoutineState(current, { ...routineState(current), activeRoutineId: id }));
      resetForRoutine(); setPage('auto');
    };
    const addRoutine = () => {
      if (page !== 'auto') retireDeletion(true);
      finishEdit(); playbackStore.reset();
      const created = blankRoutine(uniqueRoutineName('New routine'));
      commitRoutineState((state) => ({ routines: [...state.routines, created], activeRoutineId: created.id }));
      resetForRoutine(); setPage('auto'); return created;
    };
    const duplicateRoutine = (id) => {
      const source = routines.find((candidate) => candidate.id === id); if (!source) return null;
      const created = { ...clone(source), id: routineId(), name: uniqueRoutineName(source.name + ' copy') };
      commitRoutineState((state) => { const index = state.routines.findIndex((candidate) => candidate.id === id); const next = state.routines.slice(); next.splice(index + 1, 0, created); return { routines: next, activeRoutineId: created.id }; });
      resetForRoutine(); return created;
    };
    const deleteRoutine = (id) => {
      if (!preflightDeletion()) return false;
      const live = routineState(projectRef.current), target = live.routines.find((candidate) => candidate.id === id);
      if (!target) return false;
      const entry = commitRoutineState((state) => { const index = state.routines.findIndex((candidate) => candidate.id === id); const next = state.routines.filter((candidate) => candidate.id !== id); if (!next.length) next.push(blankRoutine()); const activeRoutineId = state.activeRoutineId === id ? next[Math.min(index, next.length - 1)].id : state.activeRoutineId; return { routines: next, activeRoutineId }; });
      resetForRoutine();
      announceDeletion(entry, 'Routine deleted', 'Deleted routine “' + target.name + '”.');
      return true;
    };
    const renameRoutine = (id, name) => {
      const clean = (name || '').trim(); if (!clean) return false;
      // An unchanged name is not an edit; recording it would leave an empty Undo step.
      if (routineState(projectRef.current).routines.find((candidate) => candidate.id === id)?.name === clean) return true;
      commitRoutineState((state) => ({ ...state, routines: state.routines.map((candidate) => candidate.id === id ? { ...candidate, name: clean } : candidate) })); return true;
    };
    const agentCandidates = agentProposal && Array.isArray(agentProposal.candidates) ? agentProposal.candidates : [];
    const agentCandidate = agentCandidates.find((candidate) => candidate.id === agentCandidateId) || agentCandidates[0] || null;
    const agentPreviewRequest = useMemo(() => agentCandidate?.path ? { candidate: agentCandidate, robot, plannerId } : null, [agentCandidate, robot, plannerId]);
    useEffect(() => {
      if (agentProposal?.status === 'ready' && agentPreviewRequest) {
        agentPreviewer.request({ key: agentPreviewRequest, path: agentPreviewRequest.candidate.path, robot, plannerId, quality: 'final' });
      }
    }, [agentPreviewer, agentProposal, agentPreviewRequest, robot, plannerId]);
    const agentProposalPreview = agentProposalPreviewResult(agentPreview, agentCandidate, agentPreviewRequest, plannerId);
    const agentProposalCanApplyCandidate = canApplyAgentProposalCandidate(agentProposal, agentCandidate, agentProposalPreview);
    const rejectAgentProposal = useCallback(() => {
      if (!agentProposal) return;
      if (window.bordeauxAPI && window.bordeauxAPI.updateAgentProposalStatus) window.bordeauxAPI.updateAgentProposalStatus(agentProposal.id, 'rejected');
      const rejected = { ...agentProposal, status: 'rejected' };
      agentProposalRef.current = rejected;
      setAgentProposal(rejected);
    }, [agentProposal]);
    const applyAgentProposal = useCallback(() => {
      const proposalContext = agentProposalContext.current;
      const publishedContext = agentSync.published();
      const currentActivePathId = docRef.current && docRef.current.id;
      const contextMatches = agentProposalMatchesPublishedContext(agentProposal, agentSessionId, publishedContext, {
        project: projectRef.current,
        activePathId: currentActivePathId,
        editRevision: editStore.getRevision(),
        robotCatalogFingerprint: robotCatalogFingerprint.current,
        hasDraft: Boolean(editStore.getSnapshot()),
      });
      if (!agentProposal || agentProposal.status !== 'ready' || !contextMatches
        || !proposalContext || proposalContext.published !== publishedContext || proposalContext.id !== agentProposal.id
        || robotProjectState.operation || !agentProposalCanApplyCandidate
        || (agentProposal.blockingIssues && agentProposal.blockingIssues.length)) return;
      let nextIndex = activeIdx;
      let nextProject;
      if (agentProposal.operation === 'configureRobot') {
        if (!agentProposal.planning) return;
        nextProject = { ...project, robot: { ...project.robot, planning: clone(agentProposal.planning) } };
      } else if (!agentCandidate || agentCandidate.valid === false || !agentCandidate.path) return;
      else if (agentProposal.operation === 'replace') {
        nextIndex = project.paths.findIndex((path) => path.id === agentProposal.targetPathId);
        if (nextIndex < 0) return;
        const replacement = clone(agentCandidate.path); replacement.id = project.paths[nextIndex].id;
        const paths = project.paths.slice(), beforePath = paths[nextIndex]; paths[nextIndex] = replacement;
        nextProject = PathLinks.sync({ ...project, paths }, replacement.id, beforePath);
      } else {
        nextIndex = project.paths.length;
        nextProject = { ...project, paths: [...project.paths, clone(agentCandidate.path)] };
      }
      commitProjectChange(project, nextProject);
      if (agentProposal.operation !== 'configureRobot') resetForPath(nextIndex);
      updateDirty(true);
      const appliedRevision = agentSync.revision() + 1;
      if (window.bordeauxAPI && window.bordeauxAPI.updateAgentProposalStatus) window.bordeauxAPI.updateAgentProposalStatus(agentProposal.id, 'applied', appliedRevision);
      const applied = { ...agentProposal, status: 'applied', appliedRevision };
      agentProposalRef.current = applied;
      setAgentProposal(applied);
    }, [agentProposal, agentCandidate, agentProposalCanApplyCandidate, project, activeIdx, agentSessionId, agentSync, editStore, robotProjectState.operation, updateDirty]);

    const total = derived.prof.totalTime || 0;
    useEffect(() => playbackStore.setTotal(total), [playbackStore, total]);

    const routinePlans = useRoutinePlanning(page === 'auto', routine, project.paths, robot, project.field, plannerId);
    const lastRun = useRef({ steps: [], total: 0 });
    const run = useMemo(() => {
      if (page !== 'auto') return lastRun.current;
      const nextRun = AUTO.buildRun(routine, project.paths, robot, routineOutcomes, plannerId, robotProjectState.catalog, routinePlans, { repeatPasses: routinePasses });
      lastRun.current = nextRun;
      return nextRun;
    }, [page, routine, project.paths, robot, routineOutcomes, routinePasses, plannerId, robotProjectState.catalog, routinePlans]);
    // A changed trace (source, plans or local choices) stops playback so the robot never shows stale geometry.
    useEffect(() => { routinePlaybackStore.reset(); routinePlaybackStore.setTotal(run.total); }, [routinePlaybackStore, run]);
    // Choices belong to one routine in one project.
    useEffect(() => { setRoutineOutcomes({}); setRoutinePasses({}); }, [projectKey, routine.id]);
    const routineIssues = useMemo(() => (page === 'auto' ? AUTO.analyze(routine, project.paths, robotProjectState.catalog) : []), [page, routine, project.paths, robotProjectState.catalog]);
    useEffect(() => { if (page !== 'plan') playbackStore.pause(); if (page !== 'auto') routinePlaybackStore.pause(); }, [page, playbackStore, routinePlaybackStore]);

    const stepCount = (count, noun = 'step') => count + ' ' + noun + (count === 1 ? '' : 's');
    /** Footer copy for a replacing branch intent that removed steps: the event, then what it removed. Names stay in the detail. */
    const branchNotice = (intent, branch, outputs, commands, removed) => {
      const steps = stepCount(removed), branchSteps = stepCount(removed, 'branch step');
      const outputLabel = (name) => outputs.find((output) => output.name === name)?.label || name;
      if (intent.kind === 'command') {
        const next = commands.find((command) => command.id === intent.commandId);
        return ['Command changed · ' + steps, (next ? 'Changed command to “' + next.label + '”.' : 'Cleared the command.') + ' Removed ' + branchSteps + '.'];
      }
      if (intent.kind === 'removeRoute') {
        const index = branch.routes.findIndex((route) => route.id === intent.routeId);
        return ['Route removed · ' + steps, 'Removed route ' + (index + 1) + ' (' + AUTO.routeSummary(branch.routes[index]) + ') and ' + steps + '.'];
      }
      if (intent.kind === 'rebuild') return ['Routes rebuilt · ' + steps, 'Rebuilt routes for “' + outputLabel(branch.output) + '”. Removed ' + branchSteps + '.'];
      return intent.output
        ? ['Output changed · ' + steps, 'Branching on “' + outputLabel(intent.output) + '”. Removed ' + steps + ' from the previous routes.']
        : ['Branches removed · ' + steps, 'Removed the output branches and ' + steps + '.'];
    };
    /**
     * Command branch edits name stable IDs and merge into the live routine; no captured branch or route steps are written.
     * Every intent is fenced to the owner it rendered for. Replacing intents also preflight like deletion, once, and may
     * announce; field intents never flush, because a draft commit during that preflight arrives as one of them.
     * `keep` is a chooser's same-value choice: checked like any intent, it never preflights or records history.
     * Applied and unchanged results carry `current()`, true while the result still owns the routine, for deferred focus.
     */
    const branchIntent = (owner) => (nodeId, intent) => {
      const refused = { status: 'refused', removed: 0 };
      const live = () => { const state = routineState(projectRef.current); return state.routines.find((item) => item.id === state.activeRoutineId) || state.routines[0]; };
      const owns = () => {
        const after = live(), epoch = documentEpoch.current, generation = branchGeneration.current;
        return () => epoch === documentEpoch.current && generation === branchGeneration.current && live() === after
          && deletionContext.current.page === 'auto' && !projectTransitionRef.current;
      };
      const fenced = () => owner.epoch === documentEpoch.current && owner.generation === branchGeneration.current
        && owner.catalog === catalogRef.current && live().id === owner.routine.id;
      const replacing = ['command', 'output', 'rebuild', 'removeRoute'].includes(intent.kind);
      if (!fenced() || (replacing && (live() !== owner.routine || !preflightDeletion() || !fenced()))) return refused;
      const was = AUTO.locate(owner.routine, nodeId)?.node, at = AUTO.locate(live(), nodeId), node = at?.node;
      if (!was || !node || at.readOnly || node.type !== 'function' || node.cat !== 'command') return refused;
      // The control rendered for this command, output and value type; a later replacement is not its owner.
      const commandId = node.invocation?.commandId || '', branch = node.outputBranch, saved = was.outputBranch;
      if (commandId !== (was.invocation?.commandId || '') || branch?.output !== saved?.output
        || (branch?.schema !== saved?.schema && !robotValueSchemasEqual(branch?.schema, saved?.schema))) return refused;
      if (intent.kind === 'keep') return { status: 'unchanged', removed: 0, current: owns() };
      const commands = owner.catalog?.commands || [], outputs = AUTO.branchOutputs(commands.find((command) => command.id === commandId));
      let result, patch;
      if (intent.kind === 'command') {
        if (intent.commandId === commandId) return { status: 'unchanged', removed: 0, current: owns() };
        const next = intent.commandId ? commands.find((command) => command.id === intent.commandId) : null;
        if (intent.commandId && !next) return refused;
        result = { status: 'applied', removed: AUTO.routeSteps(branch?.routes || []) };
        patch = { title: next ? next.label : 'Robot command', invocation: next ? { commandId: next.id, arguments: commandArguments(next) } : null, outputBranch: undefined };
      } else {
        result = AUTO.branchEdit(branch, outputs, intent);
        patch = { outputBranch: result.branch && clone(result.branch) };
      }
      if (result.status !== 'applied') return result.status === 'unchanged' ? { status: 'unchanged', removed: 0, current: owns() } : refused;
      if (replacing && intent.kind !== 'removeRoute') branchGeneration.current += 1;
      const entry = setRoutine((routine) => AUTO.update(routine, nodeId, patch));
      if (replacing && result.removed > 0) announceDeletion(entry, ...branchNotice(intent, branch, outputs, commands, result.removed));
      return { status: 'applied', removed: result.removed, current: owns() };
    };
    const acq = useMemo(() => ({
      outcomes: routineOutcomes,
      passes: routinePasses,
      // Generated-fallback descendants are read-only: no edit reaches them from any surface.
      set: (id, patch) => { if (!AUTO.locate(routine, id)?.readOnly) setRoutine((r) => AUTO.update(r, id, patch)); },
      branch: branchIntent({ routine, catalog: robotProjectState.catalog, epoch: deletionEpoch, generation: branchGeneration.current }),
      // Structural edits go through the model's checked operations; a rejected or no-op edit records no Undo entry.
      edit: (operation) => {
        const liveRoutine = () => { const live = routineState(projectRef.current); return live.routines.find((candidate) => candidate.id === live.activeRoutineId) || live.routines[0]; };
        // 1. A gesture computed from an older routine (Undo, source or routine change mid-gesture) must not roll back newer source.
        if (liveRoutine() !== routine) return { changed: false, routine, reason: 'The routine changed. Try again.' };
        // 2. A focused draft lands first, as its own Undo entry. An invalid draft keeps focus and blocks the gesture.
        if (!flushProjectDraft()) return { changed: false, routine, reason: 'Fix the highlighted value first.' };
        // 3. The typed operation is checked again against the live routine, which now includes the draft.
        const current = liveRoutine();
        const result = AUTO.editRoutine(current, operation);
        if (!result.changed) return result;
        setRoutine(() => result.routine);
        if (result.focusId) setRoutineSel(result.focusId);
        return result;
      },
      preflight: preflightDeletion,
      del: (id) => {
        const currentRoutine = () => { const state = routineState(projectRef.current); return state.routines.find((item) => item.id === state.activeRoutineId) || state.routines[0]; };
        if (currentRoutine() !== routine || !preflightDeletion()) return false;
        const current = currentRoutine();
        if (current.id !== routine.id) return false;
        const at = AUTO.locate(current, id);
        if (!at || at.readOnly) return false;
        const label = AUTO.nodeTitle(at.node, projectRef.current.paths, robotProjectState.catalog);
        const nested = AUTO.childLists(at.node).reduce((count, list) => count + AUTO.branchCount(list.nodes), 0);
        const next = at.siblings[at.index + 1] || at.siblings[at.index - 1], listKey = JSON.stringify(at.listRef);
        const entry = setRoutine((r) => AUTO.remove(r, id)); setRoutineSel(null);
        announceDeletion(entry, 'Step deleted' + (nested ? ' · ' + nested + ' nested steps' : ''), 'Deleted “' + label + '”' + (nested ? ' and ' + nested + ' nested steps' : '') + '.');
        const epoch = documentEpoch.current, after = currentRoutine(), focusOwner = document.activeElement;
        requestAnimationFrame(() => {
          if (epoch !== documentEpoch.current || deletionContext.current.page !== 'auto' || currentRoutine() !== after
            || (document.activeElement !== focusOwner && document.activeElement !== document.body)
            || projectTransitionRef.current || document.querySelector('dialog:modal,[aria-modal="true"]')) return;
          const step = [...document.querySelectorAll('.rt-step')].find((element) => element.dataset.id === next?.id);
          const add = [...document.querySelectorAll('.rt-panel .rt-addwrap')].find((element) => element.dataset.list === listKey)?.querySelector('.rt-add');
          (step?.querySelector('.rt-step-body') || add || document.querySelector('.rt-panel .rt-empty-add'))?.focus();
        });
        return true;
      },
      select: (id) => {
        const selectedStep = document.querySelector('.rt-step.sel .rt-step-body');
        commitFocusedDraft(); setRoutineSel(id);
        if (id == null) requestAnimationFrame(() => { if (selectedStep?.isConnected) selectedStep.focus(); });
      },
      setOutcome: (id, br) => setRoutineOutcomes((o) => ({ ...o, [id]: br })),
      setPasses: (id, passes) => setRoutinePasses((current) => ({ ...current, [id]: passes })),
      openInEditor: (id) => { const idx = project.paths.findIndex((path) => path.id === id); if (idx >= 0) { setActive(idx); setPage('plan'); } },
    }), [routineOutcomes, routinePasses, routine, project.paths, robotProjectState.catalog, preflightDeletion, deletionEpoch, branchGeneration.current]);
    const selectRoutineStep = useCallback((id) => { commitFocusedDraft(); setRoutineSel(id); }, []);
    const autoFieldActions = useMemo(() => ({ selectNode: (id) => { commitFocusedDraft(); setRoutineSel((s) => s === id ? null : id); }, deleteNode: acq.del, select: () => selectRoutineStep(null) }), [selectRoutineStep, acq]);

    const onFit = useCallback(() => setView(FIT), []);
    const zoomBy = useCallback((factor) => setView((v) => {
      const cx = v.x + v.w / 2, cy = v.y + v.h / 2;
      const nw = Math.max(IMG_W * 0.12, Math.min(IMG_W * 1.6, v.w * factor));
      const nh = v.h * nw / v.w;
      return { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
    }), []);
    const zoomPct = Math.round(FIT.w / view.w * 100);
    const compareTrajectory = (mode) => {
      if (mode === 'normal' && !normalReady) return;
      playbackStore.reset();
      setComparison({ documentKey: projectKey, id: doc.id, key: optimizationKey, mode });
    };
    const closeOptimization = () => {
      compareTrajectory('selected');
      setOptimizationOpen(false);
      setInspectorOpen(false);
      document.querySelector('.optimizer-toggle')?.focus();
    };
    const toggleOptimization = () => {
      if (optimizationOpen) {
        closeOptimization();
        return;
      }
      setInspectorOpen(false);
      setOptimizationOpen(true);
    };
    const startOptimization = (deadline) => {
      setComparison(null);
      void optimizer.start(doc.id, deadline);
    };
    const applyOptimization = () => {
      if (!candidate?.finalTrajectory || editStore.getSnapshot()) return;
      const current = projectRef.current;
      const currentPath = current.paths.find((path) => path.id === doc.id);
      if (!currentPath || routeInputKey(currentPath, current.robot, current.field) !== searchKey) return;
      try {
        // Search publishes independently qualified output. Keep numerical validation
        // in workers; selected planning and export revalidate this exact artifact.
        const nextPath = stageAcceptedRouteTrajectory(currentPath, current.robot, candidate.finalTrajectory, current.field, PERSEG);
        const result = nextPath.optimization.accepted;
        appliedPreview.current = { artifact: result, documentKey: projectKey, pathId: doc.id, key: optimizationKey,
          plannerId, previewDensity: PERSEG, projectionVersion: 1, value: candidate };
        beginHistory();
        playbackStore.reset();
        setComparison(null);
        writeDoc(nextPath);
      } catch (error) { setExportError(error.message || 'The candidate could not be applied.'); }
    };
    const useNormalTrajectory = () => {
      beginHistory();
      playbackStore.reset();
      setComparison(null);
      const { accepted: _accepted, ...retained } = doc.optimization || {};
      writeDoc({ ...doc, optimization: Object.keys(retained).length ? retained : undefined });
    };

    // ---- desktop project workflow ----
    // A restored recovery loads detached: no target, dirty, with its origin kept only as display metadata.
    const loadProject = useCallback((incoming, location, { recoveredFrom: origin = null, session } = {}) => {
      bdxSaveFailure.current = null;
      retireDeletion(true);
      documentEpoch.current += 1;
      exportJobs.current.clear(); exportShown.current = 0;
      sessionContext.current = session?.context || null;
      setSessionRecordId(session?.recoveryRecordId || null);
      refreshSessionRecord();
      setBdxPending(false);
      setRecoveryState(null);
      setRecoveredFrom(origin);
      setReloadKept(null); setShowFailure(null); setActionNotice(null);
      invalidateScheduledAutosave();
      cancelEdit();
      optimizer.reset();
      setComparison(null);
      const name = projectFolderName(location);
      const next = normalizeProject(name ? { ...incoming, name } : incoming);
      setProjectKey((key) => key + 1);
      setLibraryPreferenceKey(next.name + ':' + next.paths[0].id);
      const robotGeneration = ++robotRestoreGeneration.current;
      const requestedPathId = next.editor && next.editor.activePathId;
      const requestedPathIndex = requestedPathId ? next.paths.findIndex((path) => path.id === requestedPathId) : -1;
      skipDirty.current = true;
      projectRef.current = next;
      setProject(next);
      setActiveIdx(requestedPathIndex >= 0 ? requestedPathIndex : 0); setSel({ kind: null, idx: -1 }); setRoutineSel(null);
      playbackStore.reset();
      routinePlaybackStore.reset();
      setExportError('');
      setBdxNotice('');
      history.clear();
      updateDirty(Boolean(origin));
      setRobotProjectState((current) => ({ ...current, status: 'unlinked', operation: null, catalog: null, integration: null, bookmarkId: null, suggestion: null, error: '', notice: '' }));
      if (window.bordeauxAPI?.restoreProjectRobotCode && session?.context) void restoreRobotCode(session.context, robotGeneration);
      else if (next.editor && next.editor.robotProjectBookmarkId) void openRecentRobotProject(next.editor.robotProjectBookmarkId, robotGeneration);
    }, [cancelEdit, history, invalidateScheduledAutosave, openRecentRobotProject, restoreRobotCode, playbackStore, refreshSessionRecord, routinePlaybackStore, updateDirty]);
    // Older desktop builds and browser fixtures without the startup API keep the previous restore race handling.
    useEffect(() => {
      let active = true;
      if (!window.bordeauxAPI || typeof window.bordeauxAPI.getProjectStartup === 'function' || typeof window.bordeauxAPI.restoreLastProject !== 'function') return undefined;
      const sourceProject = projectRef.current;
      const editRevision = editStore.getRevision();
      void enqueuePersistence(() => window.bordeauxAPI.restoreLastProject()).then(async (result) => {
        if (!active || !result) return;
        if (sourceProject !== projectRef.current || editRevision !== editStore.getRevision() || dirtyRef.current) {
          invalidateScheduledAutosave();
          await window.bordeauxAPI.newProject();
          updateDirty(true);
          return;
        }
        if (result.location) setProjectLocation(result.location);
        loadProject(result.project, result.location, { session: result.session });
      }).catch((error) => console.warn('Could not restore the last project:', error));
      return () => { active = false; };
    }, [editStore, enqueuePersistence, invalidateScheduledAutosave, loadProject, updateDirty]);
    const prepareProjectReplacement = useCallback(() => {
      invalidateScheduledAutosave();
      cancelEdit();
    }, [cancelEdit, invalidateScheduledAutosave]);
    const projectLocationRef = useRef(projectLocation); projectLocationRef.current = projectLocation;
    // Every open, create and switch runs here, one at a time. The focused draft commits and a live gesture finishes
    // first; from then until the target is loaded or the attempt ends, the transition owns the window: the Projects
    // sheet (or the pending sheet for native-menu switches) stays modal and cannot be dismissed, because the backend
    // activation cannot be cancelled. A second request is refused, not queued. In one persistence-queue step, pending
    // work is saved (again, if anything changed while saving) before the target opens, so nothing can land between
    // them. A failed save blocks the switch and keeps editing; an unsaved Untitled project needs Save or an explicit
    // "Don't save". `before` runs such a fix inside the same ownership. The old project stays if opening fails.
    const projectTransitionRef = useRef(null);
    const [projectTransition, setProjectTransition] = useState(null);
    const departureRef = useRef(null);
    // The one owner of the window for a switch, restore, create or departure. Main issues the transition id (when it
    // supports it), so a departure that arrives meanwhile can name it and resume once main has been told it ended.
    const takeTransition = useCallback((owner, { label = '' } = {}) => {
      const api = window.bordeauxAPI;
      const transition = { owner, label, phase: owner === 'departure' ? 'saving' : 'opening', localId: 'transition-' + Math.random().toString(36).slice(2) };
      transition.token = null;
      transition.ready = typeof api?.beginProjectTransition === 'function'
        ? Promise.resolve(api.getProjectSession()).then((session) => api.beginProjectTransition(session.context))
          .then((token) => { transition.token = token || null; return token?.id || null; }, () => null)
        : Promise.resolve(null);
      projectTransitionRef.current = transition;
      flushSync(() => setProjectTransition(transition));
      return transition;
    }, []);
    const releaseTransition = useCallback((transition) => {
      if (projectTransitionRef.current !== transition) return;
      projectTransitionRef.current = null;
      setProjectTransition(null);
      void transition.ready.then(async (id) => {
        if (transition.token) await Promise.resolve(window.bordeauxAPI?.endProjectTransition?.(transition.token)).catch(() => undefined);
        departureRef.current?.transitionEnded(transition, id);
      });
    }, []);
    const switchProject = useCallback((open, { discard = false, owner = 'menu', before } = {}) => {
      if (!window.bordeauxAPI) return Promise.resolve({ canceled: true });
      if (projectTransitionRef.current) return Promise.resolve({ busy: true });
      if (!flushProjectDraft()) return Promise.resolve({ blocked: 'invalid' });
      const hadGesture = Boolean(editStore.getSnapshot());
      flushSync(() => finishEdit());
      const transition = takeTransition(owner);
      const phase = (next) => { if (projectTransitionRef.current === transition) setProjectTransition({ ...transition, phase: next }); };
      const run = async () => {
        // A fix inside this switch (Save copy) saves first, and may stop it: nothing opens after a stop result.
        if (before) phase('saving');
        await transition.ready;
        const stop = before && await before(transition);
        if (stop) return stop;
        return enqueuePersistence(async () => {
          const folder = projectLocationRef.current?.folderPath;
          for (let round = 0, changed = hadGesture; ; round += 1) {
            if (!changed && !dirtyRef.current && !hasProjectInputDraft() && !editStore.getSnapshot()) break;
            if (!folder) { if (discard) break; return { blocked: 'untitled', subject: projectRef.current.name }; }
            if (round === 3) {
              setSaveState({ status: 'error', error: 'The project kept changing while saving.' });
              return { blocked: 'failed', subject: projectFolderName(projectLocationRef.current) || projectRef.current.name, message: 'The project kept changing while saving' };
            }
            phase('saving');
            invalidateScheduledAutosave();
            const source = { project: projectRef.current, editRevision: editStore.getRevision(), draftGeneration: draftInputGeneration.current };
            setSaveState({ status: 'saving', error: '' });
            let saved;
            try { saved = await persistSource(materializeProject()); }
            catch (error) { saved = { error: operationErrorMessage(error) }; }
            if (!saved?.saved) {
              const error = saved?.error || 'The project folder is unavailable.';
              setSaveState({ status: 'error', error, sourceChange: saved?.sourceChange }, { user: true });
              return { blocked: 'failed', subject: projectFolderName(projectLocationRef.current) || projectRef.current.name, message: firstFact(error), detail: error,
                sourceChange: saved?.sourceChange };
            }
            setSaveState(savedState());
            changed = !projectPersistenceStayedCurrent(source, { project: projectRef.current, editRevision: editStore.getRevision(), draftGeneration: draftInputGeneration.current });
            if (!changed) { updateDirty(false); break; }
          }
          phase('opening');
          const result = await open();
          if (!result) return { canceled: true };
          prepareProjectReplacement();
          projectLocationRef.current = result.location || null;
          setProjectLocation(result.location || null);
          setSaveState({ status: result.location?.projectPath ? 'saved' : 'draft', error: '' });
          loadProject(result.project, result.location, { recoveredFrom: result.recoveredFrom || null, session: result.session });
          // An opened document is main's target, so checkpoints may run (also after a failed startup detach).
          startupSettled.current = true; startupDetachFailed.current = false;
          return { opened: true };
        });
      };
      return run().finally(() => releaseTransition(transition));
    }, [editStore, enqueuePersistence, finishEdit, flushProjectDraft, invalidateScheduledAutosave, loadProject, materializeProject, persistSource, prepareProjectReplacement, releaseTransition, setSaveState, takeTransition, updateDirty]);
    // Reload from disk, a changed workspace's fix: main keeps these exact edits as a recovery copy, then opens the project
    // as it is on disk. Nothing is written to the source. It uses the switch's owner (transition, queue, load reset), but
    // it never saves first. Unless main reloaded, this document stays, still unsaved, with its fixes.
    const reloadSource = useCallback(() => {
      const api = window.bordeauxAPI;
      if (!lifecycle || typeof api?.reloadProjectSource !== 'function') return Promise.resolve({ canceled: true });
      return reloadFromDisk({
        busy: () => Boolean(projectTransitionRef.current),
        prepare: () => { if (!flushProjectDraft()) return false; flushSync(() => finishEdit()); return true; },
        queue: persistenceQueue, invalidateAutosave: invalidateScheduledAutosave, epoch: () => documentEpoch.current, context: () => sessionContext.current,
        begin: () => takeTransition('menu', { label: 'Reloading…' }), end: releaseTransition,
        api, materialize: materializeProject, nextRevision: nextSnapshotRevision,
        apply: (result, epoch0) => {
          if (epoch0 !== documentEpoch.current) return { reloadFailed: 'stale' };
          if (result?.status === 'reloaded' && result.opened?.project) {
            const { opened, session, kept } = result;
            prepareProjectReplacement();
            projectLocationRef.current = opened.location || null;
            setProjectLocation(opened.location || null);
            setSaveState({ status: 'saved', error: '' });
            loadProject(opened.project, opened.location, { session });
            if (kept?.capturedAt) setReloadKept({ at: kept.capturedAt, recordId: kept.storedSnapshot?.recordId || null });
            announceAction((projectFolderName(opened.location) || opened.project.name) + ' reloaded · earlier edits are in Recovered edits');
            startupSettled.current = true; startupDetachFailed.current = false;
            return { opened: true, kept };
          }
          // Main committed, then another project won: nothing loads, the old editor isn't told it was kept, and main's
          // newer session (its record) is never ascribed to it.
          if (result?.status === 'superseded' || result?.status === 'reloaded') {
            setSaveState({ status: 'error', error: result.fact || 'Couldn’t reload the project' });
            return { reloadFailed: 'superseded' };
          }
          const fact = result?.fact || 'Couldn’t reload the project', recovery = reloadRecovery(result);
          if (recovery) setRecoveryState(recovery);
          // A kept copy can move this session to a reused record; adopt it only for that same context.
          if (result?.kept) adoptSessionRecord(result.session, epoch0);
          const current = saveStateRef.current;
          if (current.status === 'error' && !current.retryExport) setSaveState({ ...current, writing: false, reloadError: fact });
          announceAction('Couldn’t reload · ' + fact);
          return { reloadFailed: result?.code || 'rejected' };
        },
      });
    }, [adoptSessionRecord, announceAction, finishEdit, flushProjectDraft, invalidateScheduledAutosave, lifecycle, loadProject, materializeProject, nextSnapshotRevision, persistenceQueue,
      prepareProjectReplacement, releaseTransition, setSaveState, takeTransition]);
    // Show file for a changed document: the menu has closed, so a failure is announced and kept for the next menu.
    // A late answer for a replaced document, another file or an older press shows nothing.
    const showSequence = useRef(0);
    const showSourceFile = useCallback(async () => {
      const api = window.bordeauxAPI, file = saveStateRef.current.sourceChange?.file;
      if (!lifecycle || typeof api?.revealProjectSource !== 'function' || !file) return;
      const epoch = documentEpoch.current, sequence = ++showSequence.current, generation = saveStateEpoch.current;
      const current = () => sequence === showSequence.current && epoch === documentEpoch.current && generation === saveStateEpoch.current;
      setShowFailure(null);
      let result;
      try { result = await showProjectSource(api, file, sessionContext.current, current); }
      catch (error) { result = { revealed: false, fact: firstFact(error) }; }
      if (result?.revealed || !current()) return;
      const fact = result?.fact || 'Couldn’t show file';
      setShowFailure({ epoch, generation, fact });
      announceAction('Couldn’t show ' + file + ' · ' + fact);
    }, [announceAction, lifecycle]);
    const presentProjects = useCallback((mode, notice, focusRecordId) => {
      if (projectTransitionRef.current) return;
      if (!notice && !flushProjectDraft()) return;
      flushSync(() => finishEdit());
      setProjectsDialog((current) => ({ mode, notice, ...(focusRecordId ? { focusRecordId } : {}), returnFocus: current?.returnFocus || document.activeElement }));
    }, [finishEdit, flushProjectDraft]);
    // One sheet at a time, in this direction too: a Projects or New request (native menu, a blocked switch's notice) that
    // arrives while another sheet is presented (the update panel) waits for it, then presents through the usual checks.
    // The latest request wins, a notice is kept, and a request from a replaced document is dropped. An open Projects sheet
    // still switches between Projects and New in place.
    // Another sheet is presented (or the update panel is due): the one-sheet rule's single test.
    const otherSheetUp = () => appUpdateStateRef.current?.visible && appUpdateStateRef.current.phase === 'installing' || document.querySelector('dialog:modal, [role="dialog"][aria-modal="true"]');
    const showProjects = useCallback((mode, notice, focusRecordId) => {
      if (projectTransitionRef.current) return;
      // Every new request consumes the one held before it, whether it waits or presents now, so an older held request can
      // never replace it later. A held notice from this document travels with the newest request; an older document's never.
      const epoch = documentEpoch.current, held = menuSheet.current;
      menuSheet.current = null;
      notice = notice || (held?.epoch === epoch ? held.notice : undefined);
      if (!projectsDialogRef.current && otherSheetUp()) {
        menuSheet.current = { mode, notice, focusRecordId, epoch };
        setStartupSheetQueued((count) => count + 1);
        return;
      }
      presentProjects(mode, notice, focusRecordId);
    }, [presentProjects]);
    // Manage… from the chip or a departure: the copies on their own, and Back returns to what opened them. Never over
    // another sheet or dialog (a departure that began meanwhile keeps the window).
    const manageRecoveries = useCallback(() => {
      if (projectTransitionRef.current || document.querySelector('dialog:modal') || !flushProjectDraft()) return;
      flushSync(() => finishEdit());
      setProjectsDialog((current) => current || { mode: 'recoveries', returnFocus: document.activeElement });
    }, [finishEdit, flushProjectDraft]);
    // A listing with room again retires a full-storage fact; the copy that failed is still reported as missing.
    const noteRecoveryCapacity = useCallback((capacity) => setRecoveryState((recovery) => recoveryAfterListing(recovery, capacity)), []);
    // Native menu opens report a blocked switch or failure in the Projects sheet, where its fix lives.
    const switchFromMenu = useCallback((open) => {
      const run = (options) => switchProject(open, options);
      return run().then((result) => { if (result?.blocked) showProjects('list', { ...result, run }); },
        (error) => showProjects('list', { blocked: 'error', message: firstFact(error), run }));
    }, [showProjects, switchProject]);
    // `skip` (first-use) leaves the blank Untitled ready to draw; `restored` announces the new state from the chip.
    const closeProjects = useCallback((reason) => {
      if (projectTransitionRef.current) return;
      const target = reason === 'restored' ? null : projectsDialog?.returnFocus;
      const epoch = documentEpoch.current;
      // Remove the modal before restoring focus: a RAF can run before an async React update commits.
      flushSync(() => setProjectsDialog(null));
      const afterClose = document.activeElement;
      if (reason === 'skip') setTool('waypoint');
      requestAnimationFrame(() => {
        if (epoch !== documentEpoch.current || projectTransitionRef.current || document.querySelector('dialog:modal, [role="dialog"][aria-modal="true"]')) return;
        if (document.activeElement !== afterClose && document.activeElement && document.activeElement !== document.body) return;
        if (reason === 'skip' && focusIfAvailable(document.querySelector('.fieldsvg'))) return;
        if (target !== document.body && !target?.closest('dialog') && focusIfAvailable(target)) return;
        focusIfAvailable(document.querySelector('.project-chip'));
      });
    }, [projectsDialog]);
    // Applies a source save's canonical location and folder name; dirty clears only for the exact saved model.
    const applySavedSource = useCallback((location, source, canonical) => {
      sourceSaves.current += 1;
      const stayedCurrent = projectPersistenceStayedCurrent(source, { project: projectRef.current, editRevision: editStore.getRevision(), draftGeneration: draftInputGeneration.current });
      const reconciled = reconcileSavedRobotLink(projectRef.current, source.project, canonical);
      if (reconciled !== projectRef.current) {
        if (stayedCurrent) skipDirty.current = true;
        projectRef.current = reconciled; setProject(reconciled);
        if (stayedCurrent) source.project = reconciled;
        if (reconciled.editor?.labviewProjectPath === null) setRobotProjectState((current) => ({ ...current, status: 'missing', catalog: null, integration: null, bookmarkId: null }));
      }
      if (location) {
        projectLocationRef.current = location;
        setProjectLocation(location);
        if (location.folderPath) setRecoveredFrom(null);
        const name = projectFolderName(location);
        if (name && projectRef.current.name !== name) {
          if (stayedCurrent) skipDirty.current = true;
          const renamed = { ...projectRef.current, name };
          projectRef.current = renamed;
          setProject(renamed);
          // The renamed model is the saved one; later comparisons use it.
          if (stayedCurrent) source.project = renamed;
        }
      }
      if (stayedCurrent) updateDirty(false);
      return stayedCurrent;
    }, [editStore, updateDirty]);
    // Explicit Save regenerates Paths/*.bdx after its source phase. Each Save whose source committed becomes an export
    // candidate; "Updating BDX" stays while any candidate is unresolved. A source receipt is not proof that a newer
    // export ran: a candidate refused after its source saved (e.g. an earlier export still holds the folder) reports
    // BDX not updated. An outcome is shown unless a newer candidate's outcome is already shown, and only for the same
    // document; a cancelled picker or a failure before source never becomes a candidate.
    const attachExport = useCallback((saving) => {
      const sequence = ++exportSequence.current, epoch = documentEpoch.current;
      exportJobs.current.add(sequence);
      setBdxPending(true);
      const decide = (failure) => {
        exportJobs.current.delete(sequence);
        if (epoch !== documentEpoch.current) return;
        setBdxPending(exportJobs.current.size > 0);
        if (sequence < exportShown.current) return;
        exportShown.current = sequence;
        bdxSaveFailure.current = failure;
        const current = saveStateRef.current;
        if (current.status === 'saved' || current.status === 'draft' || (current.status === 'error' && current.retryExport)) {
          setSaveState(failure ? { status: 'error', ...failure, retryExport: true } : { status: 'saved', error: '' });
        }
      };
      void Promise.resolve(saving).then((result) => decide(result?.exportError ? { error: result.exportError, exportDetails: result.exportDetails || null } : null),
        (error) => { const cause = operationErrorMessage(error); decide({ error: 'Project saved; BDX files were not updated. ' + cause, exportDetails: { cause, partial: false } }); });
    }, [setSaveState]);
    // Every explicit save (⌘S, native menu, chip, Retry, the Save copy picker fallback) stops here until startup has settled
    // with this window's own target; after a failed detach main may still hold the previous project's folder.
    const saveProject = useCallback((saveAs) => {
      if (!window.bordeauxAPI) return;
      if (!startupSettled.current) { showNoSaveTarget(); return; }
      return enqueuePersistenceAfterPreflight(enqueuePersistence, flushProjectDraft, async () => {
        if (!startupSettled.current) { showNoSaveTarget(); return; }
        const api = window.bordeauxAPI;
        const source = { project: projectRef.current, editRevision: editStore.getRevision(), draftGeneration: draftInputGeneration.current };
        // A cancelled picker puts back exactly what this Save replaced, including a failure, its fixes and its try.
        const prior = saveStateRef.current, priorAttempts = failedSaves.current;
        setSaveState({ status: 'saving', error: '' });
        const savingEpoch = saveStateEpoch.current;
        const cancelled = () => { if (saveStateEpoch.current === savingEpoch) restoreSaveState(prior, priorAttempts); };
        const failed = (error, sourceChange) => {
          // A queued autosave must not hide the explicit save failure or its retry action.
          invalidateScheduledAutosave();
          setSaveState({ status: 'error', error, sourceChange, retrySave: true, retrySaveAs: saveAs === true }, { user: true });
        };
        const savedSource = (location, canonical) => {
          applySavedSource(location, source, canonical);
          setSaveState(savedState(), { user: true });
        };
        try {
          if (lifecycle && typeof api.saveProjectWithCheckpoint === 'function') {
            // The queue slot is released on this Save's exact source-phase update; BDX then finishes on its own.
            const session = await readBoundSession(), revision = nextSnapshotRevision();
            let saving;
            const outcome = await new Promise((resolve) => {
              const stop = checkpointChannel.watch(checkpointMatch({ mode: 'background', snapshotRevision: revision, context: session.context }), (update) => {
                const recovery = recoveryOutcome(update); if (recovery) setRecoveryState(recovery);
                if (update.source !== 'pending') { stop(); resolve({ update }); }
              });
              saving = api.saveProjectWithCheckpoint({ context: session.context, snapshotRevision: revision, project: materializeProject(), saveAs: saveAs === true });
              saving.then((result) => { stop(); resolve({ result }); }, (error) => { stop(); resolve({ error }); });
            });
            if (outcome.update?.source === 'saved' || outcome.result?.saved) { savedSource((outcome.update || outcome.result).location, (outcome.update || outcome.result).canonicalProject); attachExport(saving); }
            else if (outcome.update) failed(outcome.update.sourceFact || 'Couldn’t write the project', sourceChangeOf(outcome.update));
            else if (outcome.result?.canceled) cancelled();
            else failed(operationErrorMessage(outcome.error || 'Couldn’t write the project'));
            return;
          }
          const result = await api.saveProject(materializeProject(), saveAs === true);
          if (result && result.canceled) { cancelled(); return; }
          if (result?.saved) {
            bdxSaveFailure.current = result.exportError ? { error: result.exportError, exportDetails: result.exportDetails || null } : null;
            savedSource(result.location, result.canonicalProject);
          }
        } catch (error) {
          failed(operationErrorMessage(error));
        }
      });
    }, [readBoundSession, applySavedSource, attachExport, checkpointChannel, editStore, enqueuePersistence, flushProjectDraft, invalidateScheduledAutosave, lifecycle, materializeProject, nextSnapshotRevision, restoreSaveState, setSaveState, showNoSaveTarget]);
    // Save copy… opens New's form for a copy; ⌘S does too when there is no folder to save into. The native picker stays
    // only for a bridge without the form's defaults (older fixtures, the browser).
    const requestSaveCopy = useCallback((saveAs = true) => {
      if (typeof lifecycle?.getProjectCopyDefaults !== 'function' || (!saveAs && projectLocationRef.current?.folderPath)) return saveProject(saveAs);
      if (!startupSettled.current) return showNoSaveTarget();
      showProjects('copy');
    }, [lifecycle, saveProject, showNoSaveTarget, showProjects]);
    // A copy is submitted only for this exact document, epoch and generation. Each of its effects then also needs its own
    // form submission (`current`), transition and epoch, at the entry generation or the one its own commit acknowledged
    // (exactly entry + 1). Whatever fails either check leaves App unchanged.
    const ownsCopy = useCallback((owner) => Boolean(owner) && owner.epoch === documentEpoch.current && sameContext(owner.context, sessionContext.current), []);
    const copyLive = useCallback((a) => a.current() && projectTransitionRef.current === a.transition && a.owner.epoch === documentEpoch.current
      && sameDocument(a.owner.context, sessionContext.current) && [a.owner.context.targetGeneration, a.accepted].includes(sessionContext.current.targetGeneration), []);
    // One copy inside a transition (its own, or a blocked switch's before it opens): the exact current model goes into a
    // new folder through the explicit Save pipeline, and this document's target becomes the copy. Nothing is loaded.
    const copyBody = useCallback(async (copyTo, owner, transition, current, direct) => {
      const a = { owner, transition, current }, ack = { ...owner.context, targetGeneration: owner.context.targetGeneration + 1 }, changed = { copyFailed: 'The project changed' };
      const note = (update) => { const recovery = recoveryOutcome(update); if (recovery) setRecoveryState(recovery); };
      await transition.ready;
      if (!transition.token) return { copyFailed: 'The project is busy · Try again' };
      return !copyLive(a) ? changed : enqueuePersistence(async () => {
        if (!copyLive(a)) return changed;
        const source = { project: projectRef.current, editRevision: editStore.getRevision(), draftGeneration: draftInputGeneration.current }, revision = nextSnapshotRevision();
        let saving;
        const outcome = await new Promise((resolve) => {
          const stop = checkpointChannel.watch(checkpointMatch({ mode: 'background', snapshotRevision: revision, context: owner.context }), (update) => {
            // A receipt before the commit counts only at the entry generation; the terminal's is taken below.
            if (update.source !== 'pending') { stop(); resolve({ update }); } else if (sameContext(update.context, owner.context) && copyLive(a)) note(update);
          });
          saving = lifecycle.saveProjectWithCheckpoint({ context: owner.context, snapshotRevision: revision, project: materializeProject(), copyTo, transition: transition.token });
          saving.then((result) => { stop(); resolve({ result }); }, (error) => { stop(); resolve({ error }); });
        });
        const { update } = outcome;
        let acknowledged = update?.source === 'saved' && sameContext(update.context, ack) && update;
        if (update && !acknowledged) {
          // Failed or timed out at the entry generation: main's fact and its confirmed receipt (the record may remap).
          if (update.source === 'saved' || !sameContext(update.context, owner.context) || !copyLive(a)) return changed;
          note(update); refreshSessionRecord();
          return { copyFailed: update.sourceFact || 'Couldn’t write the project' };
        }
        if (!update) {
          // Without an update only main's session decides: this revision committed at exactly entry + 1 is the copy, the
          // entry generation with main's error is that error, and anything else claims nothing.
          const session = await lifecycle.getProjectSession().catch(() => null);
          if (sameContext(session?.context, ack) && session.latestSource?.snapshotRevision === revision && sameContext(session.latestSource.context, ack)) acknowledged = session;
          else return sameContext(session?.context, owner.context) && outcome.error && copyLive(a) ? { copyFailed: outcome.error } : changed;
        }
        a.accepted = ack.targetGeneration;
        if (!copyLive(a)) return changed;
        // Sticky from here: a later export result never rolls any of this back.
        sessionContext.current = acknowledged.context;
        note(update);
        applySavedSource(acknowledged.location, source, acknowledged.canonicalProject || outcome.result?.canonicalProject);
        setSaveState(savedState(), { user: true });
        attachExport(saving);
        refreshSessionRecord();
        if (direct) announceAction('Saved copy · editing “' + projectFolderName(acknowledged.location) + '”');
        return { copied: true };
      });
    }, [announceAction, applySavedSource, attachExport, checkpointChannel, copyLive, editStore, enqueuePersistence, lifecycle, materializeProject, nextSnapshotRevision, refreshSessionRecord, setSaveState]);
    // The form's own Save copy: refused before any transition or IPC unless its submission and owner are still current.
    const submitCopy = useCallback((copyTo, owner, current) => {
      if (projectTransitionRef.current) return Promise.resolve({ busy: true });
      if (!current() || !ownsCopy(owner)) return Promise.resolve({ copyFailed: 'The project changed' });
      if (!flushProjectDraft()) return Promise.resolve({ blocked: 'invalid' });
      flushSync(() => finishEdit());
      const transition = takeTransition('copy', { label: 'Saving…' });
      return copyBody(copyTo, owner, transition, current, true).finally(() => releaseTransition(transition));
    }, [copyBody, finishEdit, flushProjectDraft, ownsCopy, releaseTransition, takeTransition]);

    // ---- departure (close, quit, reload, install) and startup ----
    const recoveredFromRef = useRef(recoveredFrom); recoveredFromRef.current = recoveredFrom;
    const departureDeps = useRef(null);
    departureDeps.current = {
      api: lifecycle, channel: checkpointChannel, transitionRef: projectTransitionRef, takeTransition, releaseTransition,
      enqueue: enqueuePersistence, invalidateScheduledAutosave, scheduleAutosave, finishEdit, flushProjectDraft, nextRevision: nextSnapshotRevision,
      capture: () => ({ project: projectRef.current, editRevision: editStore.getRevision(), draftGeneration: draftInputGeneration.current, materialized: materializeProject(),
        epoch: documentEpoch.current, sourceSaves: sourceSaves.current }),
      // The document now loaded, without materializing it (Manage… after a departure opens only for the same one).
      documentEpoch: () => documentEpoch.current,
      stayedCurrent: (source) => projectPersistenceStayedCurrent(source, { project: projectRef.current, editRevision: editStore.getRevision(), draftGeneration: draftInputGeneration.current }),
      applySavedSource: (update, source) => {
        applySavedSource(update.location, source, update.canonicalProject);
        setSaveState(savedState());
      },
      // A departure whose own source write failed leaves this document unsaved, so the chip says so with the sheet's
      // fact and the usual Retry; its recovery copy is a separate fact. Nothing applies to a document loaded since the
      // drain froze the model, and the failure never replaces a source save confirmed after that.
      sourceFailed: (terminal, source) => {
        if (source?.epoch !== documentEpoch.current) return;
        const recovery = recoveryOutcome(terminal);
        if (recovery) setRecoveryState(recovery);
        // Untitled and recovered drafts already read Not saved / Recovered.
        if (source.sourceSaves !== sourceSaves.current || (terminal.source === 'unavailable' && !projectLocationRef.current?.folderPath)) return;
        setSaveState({ status: 'error', error: terminal.source === 'failed' && terminal.sourceFact ? terminal.sourceFact : sourceFact(terminal, Boolean(recoveredFromRef.current)),
          sourceChange: sourceChangeOf(terminal) });
      },
      // After a failed startup detach this window holds no save target of its own: a departure declines (nothing is
      // written into the previous source) and Projects says how to continue, Open or New, which take a target.
      checkpointTargetReady: (context) => {
        if (startupSettled.current) return sameDocument(sessionContext.current, context);
        if (startupDetachFailed.current) setProjectsDialog({ mode: 'list', returnFocus: null, notice: { blocked: 'no-target', message: 'Open or create a project before leaving' } });
        return false;
      },
      attachExport, restored: () => Boolean(recoveredFromRef.current), isUntitled: () => !projectLocationRef.current?.folderPath && !recoveredFromRef.current,
    };
    const departure = useProjectDeparture(departureDeps);
    // Closing a stalled install hands editing back for the exact main-authored attempt the panel showed and this
    // document's context; main revokes that attempt's approval before it answers accepted. The answer is returned, so
    // the panel stays until then. A build without the durability bridge keeps its old close; this one never skips it.
    const appUpdateStateRef = useRef(appUpdates.state); appUpdateStateRef.current = appUpdates.state;
    const appUpdatesKnownRef = useRef(appUpdates.known); appUpdatesKnownRef.current = appUpdates.known;
    const resumeEditingAfterInstall = useCallback(async (attemptId) => {
      const api = window.bordeauxAPI;
      if (!lifecycle) return { accepted: true };
      if (typeof api.noteProjectEditingResumed !== 'function' || !attemptId) return { accepted: false, fact: 'This version can’t return to editing safely' };
      const epoch = documentEpoch.current, session = await lifecycle.getProjectSession();
      const shown = appUpdateStateRef.current;
      // A newer attempt, phase or document makes this Close obsolete; it never answers for whatever appeared meanwhile.
      if (epoch !== documentEpoch.current || shown?.phase !== 'installing' || !shown.installStalled || shown.installAttemptId !== attemptId) return { stale: true };
      const result = await api.noteProjectEditingResumed(session.context, attemptId);
      return result?.accepted === true ? { accepted: true } : { accepted: false, fact: 'Bordeaux is still installing this update' };
    }, [lifecycle]);
    departureRef.current = departure;
    // Listeners first (the checkpoint channel already exists), then the handshake; only an accepted handshake arms
    // the unload fence. Without it main cannot gate this window, and nothing here claims protection.
    useEffect(() => {
      if (!lifecycle || typeof lifecycle.onProjectDeparture !== 'function') return undefined;
      let alive = true, disarm = null;
      const offRequest = lifecycle.onProjectDeparture((request) => departureRef.current.onRequest(request));
      const offCancelled = lifecycle.onProjectDepartureCancelled?.((requestId) => departureRef.current.onCancelled(requestId));
      return () => { alive = false; offRequest?.(); offCancelled?.(); };
    }, [lifecycle]);
    // Ready is registered for this frame once startup has settled (listeners are already attached).
    useEffect(() => {
      if (!lifecycle || startup !== 'done' || typeof lifecycle.setProjectLifecycleReady !== 'function') return undefined;
      let alive = true, disarm = null;
      void Promise.resolve(lifecycle.getProjectSession()).then((session) => lifecycle.setProjectLifecycleReady(session.context, true)).then((result) => {
        if (alive && result?.accepted) disarm = departureRef.current.armUnloadFence();
      }, () => undefined);
      return () => { alive = false; disarm?.(); };
    }, [lifecycle, startup]);
    // A startup sheet never stacks on another modal. It waits while the update panel is visible, any other dialog is up,
    // or a project transition runs, then opens once. While main's first update state is still pending it waits briefly
    // (main answers from memory); a failed query opens at once. Past that wait the sheet opens without treating the update
    // as hidden: a panel that becomes visible later waits for this sheet to close (AppUpdateDialog). A document loaded since
    // startup retires it; an offer whose copies were shown meanwhile (offer tokens record only rendered rows) is not
    // repeated, while a failed-recent or first-use sheet always still opens.
    const startupSheet = useRef(null), menuSheet = useRef(null), projectsDialogRef = useRef(projectsDialog);
    projectsDialogRef.current = projectsDialog;
    const [startupSheetQueued, setStartupSheetQueued] = useState(0);
    useEffect(() => {
      if (!startupSheet.current && !menuSheet.current) return undefined;
      // A held Projects/New request (showProjects) presents after the startup sheet, once no other sheet is up.
      const tryMenu = () => {
        const queued = menuSheet.current;
        if (!queued) return true;
        if (queued.epoch !== documentEpoch.current) { menuSheet.current = null; return true; }
        if (projectTransitionRef.current || (!projectsDialogRef.current && otherSheetUp())) return false;
        menuSheet.current = null;
        presentProjects(queued.mode, queued.notice, queued.focusRecordId);
        return true;
      };
      const tryOpen = () => {
        const queued = startupSheet.current;
        if (!queued) return tryMenu();
        if (queued.epoch !== documentEpoch.current) { startupSheet.current = null; return tryMenu(); }
        const updatesUnknown = appUpdatesKnownRef.current === 'pending' && Date.now() - queued.at < 1500;
        if (updatesUnknown || projectTransitionRef.current || projectsDialogRef.current || otherSheetUp()) return false;
        startupSheet.current = null;
        const listing = queued.request.recoveries;
        if (queued.offerOnly && !unofferedRecoveries(Array.isArray(listing?.entries) ? listing.entries : [], readOfferedRecoveries()).length) return tryMenu();
        setProjectsDialog(queued.request);
        return !menuSheet.current;
      };
      if (tryOpen()) return undefined;
      const timer = setInterval(() => { if (tryOpen()) clearInterval(timer); }, 150);
      return () => clearInterval(timer);
    }, [startupSheetQueued, appUpdates.state, appUpdates.known, projectsDialog, projectTransition, presentProjects]);
    // Startup: main's bounded, discriminated result. Every non-opened outcome is a blank, protected Untitled (never the
    // demo) with the sheet that explains it: recovered edits first, a failed recent row, or first-use New.
    useEffect(() => {
      if (startup !== 'pending') return undefined;
      let alive = true;
      const api = window.bordeauxAPI;
      void (async () => {
        // Main probes read-only under this transition; an opened probe is adopted (activated) only under the same
        // ownership, so a slow start can never activate a source beneath an editable Untitled. (Taken after the effect
        // returns, since taking ownership renders synchronously.)
        await null;
        if (!alive) return;
        const transition = takeTransition('startup');
        let result, opened = null, detach = null, startContext = null;
        try {
          await transition.ready;
          startContext = (await api.getProjectSession()).context;
          result = await api.getProjectStartup({ context: startContext, transition: transition.token });
          if (result.status === 'opened') {
            opened = result.needsAdoption && typeof api.adoptProjectStartup === 'function' ? await api.adoptProjectStartup(result.startupId, transition.token) : result.opened;
          }
        } catch (error) {
          opened = null;
          result = { ...(result || {}), status: 'unavailable', reason: 'error', recent: result?.status === 'unavailable' ? result.recent : null, fact: firstFact(error) };
        }
        try {
          // The probe is read-only, and a reload keeps main's previous target. Any non-opened, thrown or failed-adoption
          // start detaches under the original startup context and token (cancelling first would end the token), and only
          // then does the blank document exist; ownership ends after it is loaded.
          if (!opened?.project && alive && projectTransitionRef.current === transition) detach = startContext && transition.token ? await detachStartup(startContext, transition.token) : { ok: false, fact: 'Startup didn’t begin' };
          if (!alive) return;
          if (opened?.project) {
            projectLocationRef.current = opened.location || null;
            setProjectLocation(opened.location || null);
            setSaveState({ status: opened.location?.projectPath ? 'saved' : 'draft', error: '' });
            loadProject(opened.project, opened.location, { session: opened.session });
          } else {
            projectLocationRef.current = null;
            setProjectLocation(null);
            setSaveState({ status: 'idle', error: '' });
            loadProject(blankProject(), null, { session: detach?.session });
          }
        } finally { releaseTransition(transition); }
        invalidateScheduledAutosave();
        // Checkpoints start only for an adopted source or a verified detached blank document.
        startupSettled.current = Boolean(opened?.project || detach?.ok);
        startupDetachFailed.current = !startupSettled.current;
        const listing = result.recoveries && Array.isArray(result.recoveries.entries) && !result.recoveries.error ? result.recoveries : null;
        const offer = listing ? unofferedRecoveries(listing.entries, readOfferedRecoveries()) : [];
        const failedRecent = result.status === 'unavailable' && result.recent?.id ? result.recent.id : null;
        const request = offer.length ? { mode: 'list', recoveries: result.recoveries, startup: { focus: 'recovery', recentId: failedRecent, announce: failedRecent ? 'Last project couldn’t open' : '' } }
          : opened?.project ? null
          // First use only for a real first start: not when recovery listing failed or main is resuming after a crash.
          : result.status === 'none' && listing && !result.resuming && detach?.ok ? { mode: 'new', firstUse: true, recoveries: result.recoveries }
          : { mode: 'list', recoveries: result.recoveries, startup: { focus: failedRecent ? 'recent' : 'search', recentId: failedRecent,
            announce: detach && !detach.ok ? 'Couldn’t start a new project · ' + detach.fact : failedRecent ? 'Last project couldn’t open' : result.status === 'none' ? '' : result.fact ? 'Couldn’t open the last project · ' + firstFact(result.fact) : 'Couldn’t check recent projects' } };
        setStartup('done');
        // The sheet is queued for this exact document and opens once no other modal (the update panel first) is up.
        if (request) {
          startupSheet.current = { request: { ...request, returnFocus: null, ...(detach && !detach.ok ? { notice: { blocked: 'no-target', message: detach.fact + ' · Open or create a project' } } : {}) },
            epoch: documentEpoch.current, at: Date.now(), offerOnly: Boolean(offer.length && opened?.project) };
          setStartupSheetQueued((count) => count + 1);
        }
      })();
      return () => { alive = false; };
    // Startup runs once per mounted window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const onExportBdx = useCallback(async (pathId) => {
      if (!flushProjectDraft()) return;
      if (!window.bordeauxAPI?.exportBdx) { setExportError('BDX export is available in the Bordeaux desktop app.'); return; }
      const selected = typeof pathId === 'string' ? pathId : docRef.current?.id;
      if (!selected) { setExportError('Select a path before exporting BDX.'); return; }
      setExportError(''); setBdxNotice('');
      setRobotProjectState((current) => ({ ...current, operation: 'export' }));
      try {
        const result = await window.bordeauxAPI.exportBdx(materializeProject(), selected);
        if (result?.exported) setBdxNotice({ detail: 'Saved ' + result.relativePath + ', ' + result.sampleCount + ' samples, ' + result.eventCount + ' events. Local export complete; robot code checks compatibility before execution.' });
      } catch (error) { setExportError(operationErrorMessage(error)); }
      finally { setRobotProjectState((current) => ({ ...current, operation: null })); }
    }, [flushProjectDraft, materializeProject]);

    useEffect(() => {
      if (!window.bordeauxAPI) return undefined;
      const api = window.bordeauxAPI;
      return api.onMenuCommand(({ command, payload }) => {
        // A project transition owns the window; native commands are ignored until it ends.
        if (projectTransitionRef.current) return;
        if (command === 'new-project') showProjects('new');
        else if (command === 'show-projects') showProjects('list');
        else if (command === 'open-project') void switchFromMenu(() => api.openProject());
        else if (command === 'open-project-file') void switchFromMenu(() => api.openProjectFile());
        else if (command === 'open-folder') void switchFromMenu(() => api.openProjectFolder());
        else if (command === 'open-recent') void switchFromMenu(() => api.openRecentProject(payload));
        else if (command === 'save-project') void requestSaveCopy(false);
        else if (command === 'save-project-as') void requestSaveCopy();
        else if (command === 'export-bdx') void onExportBdx();
        else if (command === 'robot-link') void linkRobotProject();
        else if (command === 'robot-build') void buildRobotCatalog();
      });
    }, [showProjects, switchFromMenu, requestSaveCopy, onExportBdx, linkRobotProject, buildRobotCatalog]);
    // The native menu owns ⌘O/⌘N in the desktop app; this covers the browser renderer. Opening twice is harmless.
    // Capture, because the library and form fields stop their own key events from bubbling.
    useEffect(() => {
      const onKey = (event) => {
        // Capture only this view shortcut so library row key ownership cannot swallow it.
        if (page === 'plan' && event.key === '\\' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
          && !event.repeat && !event.isComposing && !event.defaultPrevented && !event.target.isContentEditable
          && !event.target.closest?.('textarea,select,input:not([type="range"]),[role="textbox"]')
          && !document.querySelector('dialog:modal,[role="dialog"][aria-modal="true"],[role="menu"],[popover]:popover-open')) {
          event.preventDefault();
          toggleFieldFocus();
          return;
        }
        if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.isComposing || event.defaultPrevented) return;
        const key = event.key.toLowerCase();
        if ((key !== 'o' && key !== 'n') || document.querySelector('dialog:modal')) return;
        event.preventDefault();
        showProjects(key === 'n' ? 'new' : 'list');
      };
      window.addEventListener('keydown', onKey, true);
      return () => window.removeEventListener('keydown', onKey, true);
    }, [showProjects, page, toggleFieldFocus]);
    const projectFolder = projectLocation?.folderPath || null;
    const projectStatus = saveState.status === 'error' && !saveState.retryExport ? 'failed'
      : !projectFolder ? (recoveredFrom ? 'recovered' : 'unsaved') : saveState.status === 'saving' || dirty ? 'saving' : 'saved';
    const retrySave = () => saveState.retryExport || saveState.retrySave ? saveProject(saveState.retrySaveAs === true) : scheduleAutosave(true, { user: true });
    const projectChip = h(ProjectChip, { key: projectKey, name: projectFolderName(projectLocation) || project.name, folderPath: projectFolder, status: projectStatus,
      writing: saveState.status === 'saving' || saveState.writing === true, saveError: saveState.error, attempt: saveState.attempt,
      sourceChange: saveState.sourceChange, reloadError: saveState.reloadError, reloadKept, notice: actionNotice,
      showFailure: showFailure && showFailure.epoch === documentEpoch.current && showFailure.generation === saveStateEpoch.current ? showFailure : null,
      recovery: recoveryState, recoveredFrom, bdxPending, bdxError: saveState.status === 'error' && saveState.retryExport ? saveState.error : '', bdxDetails: saveState.exportDetails,
      robotCode: { ...robotProjectState, name: robotProjectState.catalog?.projectName, commands: robotProjectState.catalog?.commands?.length },
      actions: { projects: () => showProjects('list'), create: () => showProjects('new'), save: () => requestSaveCopy(false), saveCopy: requestSaveCopy,
        retrySave, linkCode: linkRobotProject, refreshCode: refreshRobotProject, rescanCode: typeof window.bordeauxAPI?.inspectLabviewCommands === 'function' ? () => refreshRobotProject(true) : undefined, useCode: useSuggestedRobotCode, recentCode: openRecentRobotProject, buildCode: buildRobotCatalog, ...(typeof window.bordeauxAPI?.listProjectRecoveries === 'function' ? { manageRecoveries } : {}),
        ...(lifecycle && typeof window.bordeauxAPI?.reloadProjectSource === 'function' ? { reloadSource: () => { void reloadSource(); } } : {}),
        ...(lifecycle && typeof window.bordeauxAPI?.revealProjectSource === 'function' ? { showSource: () => { void showSourceFile(); },
          showFailureSeen: (seen) => setShowFailure((failure) => failure === seen ? null : failure) } : {}),
        ...(reloadKept && typeof window.bordeauxAPI?.listProjectRecoveries === 'function' ? { recoveredEdits: () => showProjects('list', undefined, reloadKept.recordId) } : {}) } });
    const api = window.bordeauxAPI;
    // Main installs only after this window approves start-install, so the update panel always becomes visible while the
    // pending sheet is up, and it waits for every other modal (AppUpdateDialog). Once main shows that exact attempt
    // installing, the panel's own modal is the fence and owns the stalled Close (opened in the same commit that unmounts the
    // pending sheet); finish-handoff keeps the pending sheet.
    const departureUpdate = departure.view?.phase === 'approved' ? departure.view.request.update : null;
    const updatePanelOwnsDeparture = projectTransition?.owner === 'departure' && departureUpdate?.continuation === 'start-install'
      && appUpdates.state?.phase === 'installing' && appUpdates.state.installAttemptId === departureUpdate.attemptId;
    const projectsSheet = projectsDialog ? h(ProjectsDialog, { request: projectsDialog, onClose: closeProjects, pending: projectTransition, queuedDeparture: departure.queued,
      current: { name: projectFolderName(projectLocation) || project.name, folderPath: projectFolder, projectPath: projectLocation?.projectPath || null,
        ...(projectLocation?.legacyFile ? { legacyFile: projectLocation.legacyFile } : {}), recoveryRecordId: sessionRecordId, untitled: !projectFolder && !recoveredFrom },
      actions: {
        listRecent: () => api.listRecentProjects(), removeRecent: (id) => api.removeRecentProject(id),
        // Show in Finder/Explorer: main resolves a recent by its stable id, and an unlisted current project only for the exact
        // context (target generation included) shown when it was chosen, so a retarget meanwhile reveals nothing. A
        // displayed path is never sent.
        ...(typeof api?.revealRecentProject === 'function' ? { revealRecent: (id) => api.revealRecentProject({ id }),
          ...(typeof api.getProjectSession === 'function' ? { revealCurrent: async () => {
            const context = sessionContext.current, session = await api.getProjectSession();
            return sameContext(context, session?.context) && sessionContext.current === context ? api.revealRecentProject({ current: context }) : { revealed: false, code: 'stale', fact: 'The project changed' };
          } } : {}) } : {}),
        creationDefaults: () => api.getProjectCreationDefaults(), chooseParent: (current) => api.chooseProjectParentDirectory(current),
        openRecent: (id, options) => switchProject(() => api.openRecentProjectById(id), options),
        openFolder: (options) => switchProject(() => api.openProjectFolder(), options),
        openFile: (options) => switchProject(() => api.openProjectFile(), options),
        // Only the robot and the current path's limits carry over; paths, routines, commands and links never do.
        create: ({ name, parentDirectory, sameRobot }, options) => switchProject(() => api.createNamedProject({ name, parentDirectory,
          ...(sameRobot ? { template: { robot: projectRef.current.robot, ...(docRef.current?.constraints ? { constraints: docRef.current.constraints } : {}) } } : {}) }), options),
        // Save copy: the form's owner is this exact document as main has it now (like any explicit save, only once startup
        // has settled with this window's own target); its defaults are read-only suggestions. An older bridge or the browser
        // has no copy form (as for the menu and chip): a block's Save… and Save copy… stay the picker inside its switch.
        ...(typeof lifecycle?.getProjectCopyDefaults === 'function' ? {
          copyOwner: async () => {
            if (!startupSettled.current) throw showNoSaveTarget();
            return { epoch: documentEpoch.current, context: (await readBoundSession()).context };
          },
          ownsCopy, copyDefaults: async (request) => api.getProjectCopyDefaults(request), copy: submitCopy, copyInside: copyBody,
        } : { save: () => saveProject(false), saveCopy: () => saveProject(true) }),
        // A blocked switch's changed document: main reveals only a managed file of this exact project.
        ...(lifecycle && typeof api?.revealProjectSource === 'function' ? { revealSource: (file, current) => { const epoch = documentEpoch.current; return showProjectSource(api, file, sessionContext.current, () => epoch === documentEpoch.current && current()); } } : {}),
        // Recovered edits: listed read-only; restore goes through the same owner as Open and loads detached.
        ...(typeof api?.listProjectRecoveries === 'function' ? {
          listRecoveries: (options) => options ? api.listProjectRecoveries(options) : api.listProjectRecoveries(),
          restoreRecovery: (id, options) => switchProject(async () => { const session = await api.getProjectSession(); return api.restoreProjectRecovery(session.context, id); }, options),
          revealRecovery: (id) => api.revealProjectRecovery(id),
          recoveriesShown: (displayed, known) => rememberOfferedRecoveries(displayed, known),
          recoveryCapacity: noteRecoveryCapacity,
          // Manage reads this window's own copy from main's session as it lists (reuse can change it).
          currentRecoveryId: async () => (await api.getProjectSession())?.recoveryRecordId || null,
        } : {}),
        // Discard: main reserves the displayed copy for this session's exact context; the second, separate press sends
        // that same context, so a document switched meanwhile fails closed in main.
        ...(typeof api?.prepareProjectRecoveryDiscard === 'function' && typeof api?.discardProjectRecovery === 'function' ? {
          prepareDiscard: async (id) => { const session = await api.getProjectSession(); return { ...(await api.prepareProjectRecoveryDiscard(session.context, id)), context: session.context }; },
          discard: (token, context) => api.discardProjectRecovery(context, token),
        } : {}),
      } }) : projectTransition && !updatePanelOwnsDeparture && (projectTransition.owner !== 'departure' || departure.view?.phase !== 'choosing' && departure.view?.phase !== 'save-copy')
        && h(ProjectPending, { phase: projectTransition.phase, queuedDeparture: departure.queued,
          // Once a departure is approved the window is only waiting to go; say that, not "Saving…".
          label: departure.view && (departure.view.phase === 'approving' || departure.view.phase === 'approved') ? departureCopy(departure.view.request.reason).leaving : projectTransition.label || '' });
    const departureSheet = departure.view && (departure.view.phase === 'choosing' || departure.view.phase === 'save-copy') && h(ProjectDeparture, {
      reason: departure.view.request.reason, subject: projectFolderName(projectLocation) || project.name, outcome: departure.view.outcome, step: departure.view.step,
      pending: departure.view.phase === 'save-copy' ? 'save-copy' : null, saveCopyFact: departure.view.saveCopyFact,
      onKeepEditing: departure.keepEditing, onSaveCopy: departure.saveCopy, onLeave: departure.leave, onDiscardStep: departure.discardStep, onDiscard: departure.discard,
      onManage: typeof window.bordeauxAPI?.listProjectRecoveries === 'function' ? () => departure.manageRecoveries(manageRecoveries) : undefined });
    const departureHint = departure.hint && h(DepartureHint, { anchor: departure.hint.anchor, reason: departure.hint.reason, onDismiss: departure.dismissHint });

    // Escape on the field, and on the closed command chooser, clears the selection on a current plan.
    const escapeSelection = () => {
      if (page !== 'plan' || !derivationCurrent) return false;
      setTool('select'); setHeadMenu(null); setWaypointPreviewRequest(null); select(null, -1);
      return true;
    };
    useEffect(() => {
      const onKey = (e) => {
        if (e.defaultPrevented || document.querySelector('dialog:modal, [role="dialog"][aria-modal="true"]')) return;
        if (e.target.closest && e.target.closest('.editor-library,.library-divider,[role="menu"]')) return;
        const matches = e.target.matches && e.target.matches.bind(e.target);
        if (e.key === 'Tab') { keyboardNavigation.current = true; return; }
        const nativeKeyboardControl = e.target.closest?.('[data-role="issue"],[data-problems-control]') || keyboardNavigation.current && matches && matches('button,summary,select,input[type="range"]');
        // A focused timeline control for the selected object takes the field's nudge, Delete and Escape;
        // Enter and Space still press it, and other buttons keep their native keys.
        const selectionControl = nativeKeyboardControl && sel.kind && e.target.dataset?.selection === sel.kind + ':' + sel.idx
          && (e.key.indexOf('Arrow') === 0 || e.key === 'Delete' || e.key === 'Backspace' || e.key === 'Escape');
        const textEditing = nativeKeyboardControl || e.target.isContentEditable || (matches && matches('textarea,input:not([type="range"])'));
        const k = e.key.toLowerCase();
        const toolShortcut = !e.metaKey && !e.ctrlKey && !e.altKey && !textEditing && TOOL_SHORTCUTS[k];
        if (page === 'plan' && toolShortcut) {
          e.preventDefault();
          if (typeof e.target.blur === 'function') e.target.blur();
          setTool(toolShortcut);
          return;
        }
        const formControl = matches && matches('input,select,textarea,[contenteditable="true"]');
        if (formControl) return;
        if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
        if ((e.metaKey || e.ctrlKey) && k === 'y') { e.preventDefault(); redo(); return; }
        // Native controls own navigation and deletion keys during keyboard use.
        if (nativeKeyboardControl && !selectionControl) return;
        if (page !== 'plan') return;
        if (!derivationCurrent) return;
        if (e.key.indexOf('Arrow') === 0 && sel.kind) {
          const base = e.shiftKey ? 0.25 : e.altKey ? 0.01 : 0.05;
          let dx = 0, dy = 0;
          if (e.key === 'ArrowUp') dy = base; else if (e.key === 'ArrowDown') dy = -base;
          else if (e.key === 'ArrowRight') dx = base; else if (e.key === 'ArrowLeft') dx = -base;
          if (dx || dy) {
            e.preventDefault();
            if (sel.kind === 'wp') nudgeWp(sel.idx, dx, dy);
            else if (sel.kind === 'rt' || sel.kind === 'em') { const dir = (e.key === 'ArrowRight' || e.key === 'ArrowUp') ? 1 : -1; nudgeFrac(sel.kind, sel.idx, dir * (e.shiftKey ? 0.02 : 0.005)); }
          }
          return;
        }
        if (k === 'g') setShowGrid((s) => !s);
        else if (k === 'f') setView(FIT);
        else if (e.key === 'Escape') escapeSelection();
        else if ((e.key === 'Backspace' || e.key === 'Delete') && sel.kind) {
          e.preventDefault();
          if (sel.kind === 'wp') delWp(sel.idx); else if (sel.kind === 'rt') delTarget(sel.idx); else if (sel.kind === 'em') delMarker(sel.idx); else if (sel.kind === 'cr') delRange(sel.idx);
        }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [undo, redo, sel, delWp, delTarget, delMarker, delRange, select, page, derivationCurrent, nudgeWp, nudgeFrac, playbackStore]);

    useEffect(() => {
      let held = false;
      const onDown = (event) => {
        if (!isPlaybackSpace(event, page)) return;
        event.preventDefault(); event.stopPropagation();
        if (held || event.repeat) return;
        held = true;
        if (page === 'plan' && derivationCurrent) playbackStore.toggle();
        else if (page === 'auto' && !run.blocked && run.total > 0) routinePlaybackStore.toggle();
      };
      const onUp = (event) => {
        if (event.key !== ' ' || !held) return;
        held = false; event.preventDefault(); event.stopPropagation();
      };
      const release = () => { held = false; };
      window.addEventListener('keydown', onDown, true); window.addEventListener('keyup', onUp, true); window.addEventListener('blur', release);
      return () => { window.removeEventListener('keydown', onDown, true); window.removeEventListener('keyup', onUp, true); window.removeEventListener('blur', release); };
    }, [page, derivationCurrent, playbackStore, routinePlaybackStore, run.blocked, run.total]);

    const pathIndex = (id) => project.paths.findIndex((path) => path.id === id);
    // A focused draft commits first, so Push (including ⇧⌘P from a field) sends what is shown. An invalid draft keeps focus instead.
    const pushActions = { ...pushController, requestPush: (scope) => { if (!flushProjectDraft()) return; flushSync(() => finishEdit());
      if (scope?.kind === 'paths' && scope.pathIds.some((id) => (projectRef.current.paths.find((path) => path.id === id)?.waypoints?.length || 0) < 2)) return;
      // Committing a field draft blurs it. Give the review a real origin, so cancelling returns to Push, not the page;
      // any other focused control (Push itself, a library row) stays the origin.
      if (!document.activeElement || document.activeElement === document.body) focusIfAvailable(document.querySelector('.push-button'));
      pushController.requestPush(scope); } };
    // Places keep each mode's state: returning from Settings resumes the editor mode as it was, while moving between
    // Paths and Routines goes through the same switches (and draft commits) the library always used.
    const leaveForPage = (next) => { retireDeletion(true); finishEdit(); playbackStore.reset(); routinePlaybackStore.reset(); setPage(next); };
    const onPlace = (place) => {
      if (place === 'settings') { if (page !== 'robot') leaveForPage('robot'); }
      else if (place === 'paths') { if (page === 'robot' && editorPage === 'plan') leaveForPage('plan'); else setActive(activeIdx); }
      else if (page === 'robot' && editorPage === 'auto') leaveForPage('auto');
      else setActiveRoutine(routine.id);
    };
    const renderLibrary = (mode, structure) => h(LibraryRail, {
      key: projectKey + ':' + mode, preferenceKey: libraryPreferenceKey, mode, hidden: mode === 'paths' && fieldFocus, project, routines,
      activePathId: doc.id, activeRoutineId: routine.id, times, selection: pushSelection,
      onPath: (id) => { const index = pathIndex(id); if (index >= 0) setActive(index); }, onRoutine: setActiveRoutine,
      controller: pushActions,
      deletionNotice: h(DeletionNotice, { notice: deletionNotice, onUndo: undoDeletion, onDismiss: (action) => { if (deletionAction.current === action) retireDeletion(); } }),
      actions: { preflight: preflightDeletion, addPath, appendPath, addRoutine, duplicateRoutine, deleteRoutine, renameRoutine, exportPath: onExportBdx,
        duplicatePath: (id) => dupPath(pathIndex(id)), deletePath: delPath, renamePath: (id, name) => renamePath(pathIndex(id), name),
        addFolder: addPathFolder, renameFolder: renamePathFolder, deleteFolder: deletePathFolder,
        movePath: (id, folderId) => movePathToFolder(pathIndex(id), folderId), linkPath: setPathLink },
    }, structure);

    const bandActions = { ...inspActions, renamePath: (name) => renamePath(activeIdx, name), setRangeEnd, addRangeAt, addSlowZone, moveRangeHandle, addMarkerAt, addWaypoint, escapeSelection, setWaypointPositionLink };
    const selNode = (page === 'auto' && routineSel) ? AUTO.findNode(routine, routineSel) : null;
    const fieldNotices = [
      bdxNotice && { id: 'bdx-export', label: 'BDX exported', detail: bdxNotice.detail, autoDismissMs: 5000, dismissKey: bdxNotice,
        action: { label: 'Dismiss', onClick: () => setBdxNotice((current) => current === bdxNotice ? '' : current) } },
      exportError && { id: 'export', error: true, label: 'Export failed', detail: exportError,
        action: { label: 'Dismiss', onClick: () => setExportError('') } },
      editingFailure && { id: 'planning', error: true, label: 'Couldn’t time this path', detail: editingFailure.message,
        action: { label: 'Try again', onClick: editing.retry } },
      !optimizationOpen && selectedOutcome.unvalidated && { id: 'optimization', error: true, label: 'Optimization unavailable', detail: 'Saved optimization is unverified. Review before use.',
        action: { label: 'Optimize', onClick: () => setOptimizationOpen(true) } },
    ].filter(Boolean);


    if (startup === 'pending' || !derivation.value) {
      return h('main', { className: 'editor-startup', 'aria-busy': true, 'aria-label': 'Preparing editor' },
        h('div', { className: 'editor-startup-toolbar' }),
        h('div', { className: 'editor-startup-body', 'aria-hidden': true },
          h('div', { className: 'editor-startup-library' }), h('div', { className: 'editor-startup-field' }), h('div', { className: 'editor-startup-inspector' })));
    }

    return h('div', { className: 'app' },
      h(AppUpdateDialog, { state: appUpdates.state, ownsDeparture: updatePanelOwnsDeparture, ...appUpdates.actions, onEditingResumed: resumeEditingAfterInstall }),
      h(Panels.Toolbar, { page, onPlace, project: projectChip, onUndo: undo, onRedo: redo,
        push: page !== 'robot' && h(PushControl, { place: page === 'auto' ? 'routines' : 'paths', paths: project.paths, selection: pushSelection, activeRoutine: routine, controller: pushActions }),
        canUndo: history.canUndo(scopes), canRedo: history.canRedo(scopes),
        optimizationOpen, toggleOptimization, optimizationApplied: Boolean(editing.ready && editing.acceptedTrajectory),
        updateState: appUpdates.state, onOpenUpdates: () => window.bordeauxAPI?.setAppUpdatesVisible(true), onInstallUpdate: appUpdates.actions.onInstall }),
      h(RobotPushDialog, { controller: pushController, onExportBdx }),
      projectsSheet, departureSheet, departureHint,
      h(DiagnosticBundleDialog, { getProject: materializeProject, targetSelector: '.robot-connection-diagnostics', onOpen: pushController.close, renderKey: pushController.open + ':' + pushController.phase,
        // Its trigger lives in the closed connection dialog; return to what opened that dialog instead.
        onClose: () => pushController.returnFocus() || focusIfAvailable(document.querySelector('.push-menu-trigger')) || focusIfAvailable(document.querySelector('.push-button')) }),
      page === 'robot'
        ? h('main', { className: 'page-main' }, h(RobotPage, { robot, setRobot, unitSystem, setUnitSystem, pushController, mcpEnabled, updateState: appUpdates.state,
          onOpenUpdates: () => ['available', 'downloading', 'downloaded', 'installing', 'error'].includes(appUpdates.state?.phase)
            ? window.bordeauxAPI.setAppUpdatesVisible(true) : appUpdates.actions.onCheck(), agentProposal: agentProposal && agentProposal.operation === 'configureRobot' ? agentProposal : null, onApplyProposal: applyAgentProposal, onRejectProposal: rejectAgentProposal }))
        : page === 'auto'
        ? h('main', { className: 'stage stage-auto' },
            renderLibrary('routines', null),
            h(RoutineWorkspace, {
              routine, run, robot,
              flow: h(RoutinePanelPlayback, { key: routine.id, embedded: true, issues: routineIssues, collapsedIds: routineCollapsed[projectKey + ':' + routine.id] || [], onCollapsedIdsChange: (ids) => setRoutineCollapsed((current) => ({ ...current, [projectKey + ':' + routine.id]: ids })), store: routinePlaybackStore, routine, run, paths: project.paths, selId: routineSel, onSelect: selectRoutineStep, acq, catalog: robotProjectState.catalog }),
              field: h(React.Fragment, null,
                h(RoutineFieldPlayback, { store: routinePlaybackStore, run, selectedId: routineSel, doc, derived, sel: { kind: null, idx: -1 }, tool: 'select', view, setView, alliance, showGrid, robot, drive: robot.drive, accent, metric, actions: autoFieldActions }),
                h(Panels.ViewControls, { zoomPct, zoomBy, onFit, showGrid, setShowGrid, onFlip: flipPaths })),
              // Pending plans are loading; anything else blocking the preview is a fact with its reason, never "Planning…".
              status: run.blocked && h('div', { className: 'routine-status ' + (run.planningStatus === 'pending' || run.planningStatus === 'idle' ? 'planning' : 'error'), role: run.planningStatus === 'pending' || run.planningStatus === 'idle' ? 'status' : 'alert' },
                h('span', { className: 'routine-status-icon' }, h(UI.Icon, { name: run.planningStatus === 'pending' || run.planningStatus === 'idle' ? 'route' : 'info', size: 14 })),
                h('div', { className: 'routine-status-copy' },
                  h('b', null, run.planningStatus === 'error' ? 'Routine planning failed' : run.planningStatus === 'pending' || run.planningStatus === 'idle' ? 'Planning routine trajectories…' : 'Preview unavailable'),
                  run.planningError && h('span', null, run.planningError))),
              transport: h(RoutineTransportPlayback, { store: routinePlaybackStore, run }) }),
            h('aside', { className: 'rail rail-r' + (selNode ? '' : ' collapsed'), 'aria-label': 'Routine step inspector' },
              selNode && h(StepInspector, { node: selNode, routine, issues: routineIssues, paths: project.paths, acq, run, robotProject: { ...robotProjectState, link: linkRobotProject } })))
        : h('main', { className: 'stage stage-plan workspace', style: { '--band-height': bandHeight + 'px' } },
            renderLibrary('paths', null),
            h(PathWorkspace, { key: projectKey + ':' + doc.id, rootRef: workColumn, editStore, previewer: editPreviewer, doc, derived, derivedPath: derivation.path,
              robot, field: planningField, plannerId, actions: bandActions, sel, playbackStore, issues: planIssues, timingPending: !comparing && editing.pending,
              stale: !derivationCurrent, flushDraft: flushProjectDraft }, (scene) => h(React.Fragment, null,
            // Ready means the current path's timing has arrived; editing never waits for it.
            h('div', { className: 'fieldcol', 'data-planning-ready': derivationCurrent && !derivation.pending },
              h('div', { style: { display: 'contents' }, inert: derivationCurrent ? undefined : '' },
              h(Panels.ToolRail, { tool, setTool }),
              h(EditablePlaybackField, { ...scene, store: playbackStore, editStore, robot, insertionPreview: waypointPreview, proposalPreviews: agentProposal && agentProposal.status === 'ready' ? agentProposalPreview.previews : [], sel, tool, view, setView, alliance, showGrid, drive: robot.drive, accent, metric, actions: fieldActions, showHandles: true })),
              h('div', { className: 'field-notices' },
              h(FieldStatus, { key: doc.id, notices: fieldNotices }),
              (tool !== 'select' || unfinishedPath) && !waypointPreview && h('div', { className: 'stage-hint', dangerouslySetInnerHTML: { __html: toolHint(tool, doc.waypoints?.length || 0) } }),
              waypointPreview && h('div', { className: 'insert-preview', inert: derivationCurrent ? undefined : '', role: 'region', 'aria-label': 'Preview waypoint insertion' },
                h('div', { className: 'insert-preview-copy' },
                  h('b', null, waypointPreview.pending ? 'Preparing waypoint preview' : waypointPreview.error ? 'Waypoint preview unavailable' : 'Preview waypoint'),
                  h('span', null, waypointPreview.error ? (waypointPreview.error.message || String(waypointPreview.error)) : waypointPreview.message)),
                h('div', { className: 'insert-preview-actions' },
                  h('button', { type: 'button', onClick: () => setWaypointPreviewRequest(null) }, 'Cancel'),
                  h('button', { className: 'primary', type: 'button', disabled: !waypointPreview.derived, onClick: applyWaypointPreview }, waypointPreview.actionLabel || 'Insert waypoint'))),
              agentProposal && h('div', { className: 'insert-preview agent-proposal', inert: derivationCurrent ? undefined : '', role: 'region', 'aria-label': 'Agent path proposal' },
                h('div', { className: 'insert-preview-copy' },
                  h('b', null, agentProposal.operation === 'replace' ? 'Agent repair proposal' : 'Agent path proposal'),
                  h('span', null, agentProposal.intent),
                  h('span', { className: 'agent-proposal-status' }, agentProposal.status === 'ready' ? 'Preview only — the project has not changed.' : agentProposal.status === 'stale' ? 'Stale — the project changed. Ask the agent to regenerate.' : agentProposal.status === 'applied' ? 'Applied as one undoable project change.' : 'Rejected.'),
                  agentProposal.status === 'ready' && h('div', { className: 'agent-candidates', role: 'radiogroup', 'aria-label': 'Agent proposal candidates' }, agentCandidates.map((candidate) => h('button', { key: candidate.id, type: 'button', role: 'radio', 'aria-checked': agentCandidate && candidate.id === agentCandidate.id, className: agentCandidate && candidate.id === agentCandidate.id ? 'selected' : '', onClick: () => setAgentCandidateId(candidate.id) }, candidate.label + (candidate.valid === false ? ', invalid' : candidate.metrics ? ', ' + candidate.metrics.totalTimeS.toFixed(2) + ' s' : '')))),
                  agentCandidate && agentCandidate.metrics && h('span', null, UnitPrefs.format(agentCandidate.metrics.totalDistanceM, 'm', 2) + ', ' + UnitPrefs.format(agentCandidate.metrics.minimumClearanceM, 'm', 2) + ' modeled clearance'),
                  agentCandidate && agentCandidate.valid === false && agentCandidate.rejectionReason && h('span', { className: 'agent-proposal-status' }, 'Blocked: ' + agentCandidate.rejectionReason),
                  agentProposal.status === 'ready' && agentProposal.operation !== 'configureRobot' && agentProposalPreview.pending && h('span', { className: 'agent-proposal-status', role: 'status', 'aria-live': 'polite' }, 'Preparing the selected path preview…'),
                  agentProposal.status === 'ready' && agentProposal.operation !== 'configureRobot' && agentProposalPreview.error && h('span', { className: 'agent-proposal-status', role: 'alert' }, 'Selected path preview unavailable: ' + (agentProposalPreview.error.message || String(agentProposalPreview.error))),
                  agentProposal.recommendationReason && h('span', null, agentProposal.recommendationReason),
                  agentProposal.advisories && agentProposal.advisories.map((notice, index) => h('span', { key: 'advisory-' + index, className: 'agent-proposal-status' }, notice)),
                  agentProposal.blockingIssues && agentProposal.blockingIssues.map((issue, index) => h('span', { key: 'block-' + index, className: 'agent-proposal-status' }, 'Blocked: ' + issue))),
                h('div', { className: 'insert-preview-actions' },
                  agentProposal.status === 'ready' && h('button', { type: 'button', onClick: rejectAgentProposal }, 'Reject'),
                  agentProposal.status === 'ready' && h('button', { className: 'primary', type: 'button', disabled: !agentProposalCanApplyCandidate || (agentProposal.blockingIssues && agentProposal.blockingIssues.length > 0), onClick: applyAgentProposal }, agentProposal.operation === 'replace' ? 'Apply repair' : 'Add path'))),
              ),
              h('div', { className: 'field-view-footer', inert: derivationCurrent ? undefined : '' },
                h(PathHoverReadout, { store: scene.hoverStore, context: scene.hoverContext, tl: scene.tl, metric }),
                h('div', { className: 'field-view-tools' },
                  h(Panels.MetricControl, { metric, setMetric, derived: scene.derived }),
                  h(Panels.ViewControls, { zoomPct, zoomBy, onFit, showGrid, setShowGrid, onFlip: flipPaths, fieldFocus, toggleFieldFocus })))),
            h(BandDivider, { height: bandHeight, max: bandMax, onChange: setBandOverride }),
            h(PathBand, { ...scene, robot, sel, project, drive: robot.drive,
              actions: bandActions, edit: { begin: beginEdit, mutate, finish: finishEdit, cancel: cancelEdit, draft: editStore.getSnapshot, flushDraft: flushProjectDraft },
              playbackStore, stale: !derivationCurrent,
              metric,
              robotProject: { ...robotProjectState, link: linkRobotProject }, moreOpen: inspectorOpen,
              documentKey: projectKey,
              commandPickFor: commandPick && commandPick.documentKey === projectKey && commandPick.pathId === doc.id ? commandPick.markerId : null,
              onMore: () => (inspectorOpen ? closeInspector() : openInspector()) }))),
            h('aside', { className: 'rail rail-r' + (inspectorOpen || optimizationOpen ? '' : ' collapsed'), 'aria-label': optimizationOpen ? 'Path optimization' : 'Path inspector' },
              optimizationOpen ? h(OptimizationPanel, {
                path: doc, paths: project.paths, state: optimizationState, candidate, accepted, stale: staleOptimization,
                baselineTime, pending: normal.status === 'pending', error: normalError, mode: comparisonMode, unitSystem,
                searchStatus: candidate?.routeSearch?.status, searchReason: candidate?.routeSearch?.reason,
                recovery: normal.errorKind === 'timeout' ? { label: 'Try again', onClick: normal.retry }
                  : { label: 'Edit path', onClick: openInspector },
                onStart: startOptimization,
                onStartAll: () => { setComparison(null); void optimizer.startAll(); }, onCancel: optimizer.cancel,
                onCompare: compareTrajectory, onApply: applyOptimization, onNormal: useNormalTrajectory,
                onSelectPath: (id) => { const index = project.paths.findIndex((path) => path.id === id); if (index >= 0) setActive(index); },
                onClose: closeOptimization,
              }) : inspectorOpen
                ? h(ContextInspector, { project, setWaypointPositionLink, doc, sel, derived, repairMode: false, pending: false, actions: inspActions, drive: robot.drive, robot, robotProject: robotProjectState, onClose: closeInspector })
                : null),
            headMenu && h(UI.ContextMenu, { x: headMenu.x, y: headMenu.y, items: headMenu.items, returnFocus: headMenu.returnFocus, onClose: () => setHeadMenu(null) })));
  }

  function toolHint(tool, waypoints = 2) {
    if (waypoints < 2) return tool === 'waypoint' ? 'Click the field to place the <b>' + (waypoints ? 'next waypoint' : 'first waypoint') + '</b>'
      : 'Press <b>W</b>, then click the field to ' + (waypoints ? 'continue' : 'start') + ' this path';
    if (tool === 'waypoint') return 'Click the field to place the <b>next endpoint</b>';
    if (tool === 'rotation') return 'Click the path to set a <b>rotation target</b>';
    if (tool === 'marker') return 'Click the path to place a <b>command</b>';
    if (tool === 'range') return 'Drag along the path to add a <b>zone</b>, then set its limits';
    return '';
  }

  class AppErrorBoundary extends React.Component {
    constructor(props) { super(props); this.state = { error: null }; }
    static getDerivedStateFromError(error) { return { error }; }
    render() {
      if (!this.state.error) return this.props.children;
      return h('main', { className: 'fatal-error', role: 'alert' },
        h('h1', null, 'Bordeaux could not render this project'),
        h('p', null, this.state.error.message || String(this.state.error)),
        h('button', { type: 'button', onClick: () => window.location.reload() }, 'Reload project'));
    }
  }

// Pointer callbacks can finish after selection changes. The edited document's
// identity determines its destination, regardless of a callback's selected index.
function replaceEditedPath(project, edited) {
  const index = project.paths.findIndex((item) => item.id === edited.id);
  if (index < 0) return project;
  const paths = project.paths.slice(), before = paths[index];
  paths[index] = edited;
  return PathLinks.sync({ ...project, paths }, edited.id, before);
}

export { App, AppErrorBoundary, replaceEditedPath, agentProposalMatchesPublishedContext, agentProposalPreviewResult, canApplyAgentProposalCandidate, currentPathLength, duplicatePathForLibrary, requestWaypointPreview, selectedAgentProposalPreview, stableRoutineOverlay, waypointPreviewResult };
