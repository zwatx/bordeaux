(async () => {
  const waitFor = async (predicate, label, attempts = 200) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Smoke timed out waiting for ' + label);
  };
  let initialSession;
  await waitFor(async () => {
    initialSession = await window.bordeauxAPI.getProjectSession();
    return initialSession.lifecycleReady && initialSession.location?.folderPath && initialSession.location?.projectPath
      && document.querySelector('.places .place') && !document.querySelector('[role="dialog"], dialog[open]')
      && document.querySelector('.stage-plan .fieldcol')?.dataset.planningReady === 'true'
      && document.querySelector('.fieldsvg path[data-role="seg"]');
  }, 'real source startup adoption, lifecycle readiness and visible path', 400);
  const startupAdopted = Boolean(initialSession.lifecycleReady && initialSession.location.projectPath);
  const sameContext = (left, right) => left?.windowEpoch === right?.windowEpoch
    && left?.documentSessionId === right?.documentSessionId && left?.targetGeneration === right?.targetGeneration;
  // Each robot operation receives main's current document identity, never a startup or pre-New context.
  const inCurrentProject = async (operation, label) => {
    const session = await window.bordeauxAPI.getProjectSession();
    const result = await operation(session.context);
    if (!sameContext(session.context, (await window.bordeauxAPI.getProjectSession()).context)) {
      throw new Error('Smoke project session changed during ' + label);
    }
    return result;
  };
  const projectMenuItem = (label) => [...document.querySelectorAll('#project-menu button')]
    .find((button) => (button.querySelector('span')?.textContent || button.textContent).trim() === label);
  const openProjectMenu = async () => {
    if (!document.getElementById('project-menu')) document.querySelector('.project-chip').click();
    await waitFor(() => document.getElementById('project-menu'), 'project menu');
  };
  // Source activation replaces the document session; checkpoint polling must only read.
  const savedCheckpoint = async () => {
    const session = await window.bordeauxAPI.getProjectSession();
    const receipt = session.latestSource;
    if (!receipt) return null;
    const update = await window.bordeauxAPI.getProjectCheckpoint(session.context, receipt.operationId);
    if (!update || update.source !== 'saved' || !update.canonicalProject || !update.location
      || update.sourceReceipt?.kind !== 'source' || update.sourceReceipt.operationId !== receipt.operationId
      || update.sourceReceipt.digest !== receipt.digest || update.sourceReceipt.snapshotRevision !== receipt.snapshotRevision
      || JSON.stringify(update.sourceReceipt.context) !== JSON.stringify(session.context)) return null;
    const current = await window.bordeauxAPI.getProjectSession();
    if (JSON.stringify(current.context) !== JSON.stringify(session.context)) throw new Error('Smoke readback session changed');
    return { project: update.canonicalProject, location: update.location };
  };
  const unnamedOnPage = () => {
    const controls = [...document.querySelectorAll('button,input,select,textarea,[role="button"]')];
    const name = (el) => el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || el.labels?.[0]?.textContent || (el.matches('button,[role="button"]') ? el.textContent : '');
    return controls.filter((el) => !String(name(el) || '').trim()).map((el) => el.className);
  };
  const addMarker = async (fraction) => {
    document.activeElement?.blur();
    // Command edits can start a new preview and temporarily make the field inert.
    // Wait for the same interactive state before each native marker placement.
    await waitFor(() => {
      const field = document.querySelector('.stage-plan .fieldcol');
      return field?.dataset.planningReady === 'true';
    }, 'interactive field before marker placement');
    const segment = document.querySelector('.fieldsvg path[data-role="seg"]');
    if (!segment) throw new Error('Smoke marker placement requires a visible path');
    const point = segment.getPointAtLength(segment.getTotalLength() * fraction).matrixTransform(segment.getScreenCTM());
    window.__bordeauxSmokeInput = { x: Math.round(point.x), y: Math.round(point.y) };
    for (let attempt = 0; attempt < 200; attempt++) {
      if (!window.__bordeauxSmokeInput) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Smoke marker pointer input was not delivered');
  };
  const unnamed = [...unnamedOnPage()];
  for (const page of ['Routines', 'Settings']) {
    [...document.querySelectorAll('.places .place')].find((button) => button.textContent.trim() === page)?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    unnamed.push(...unnamedOnPage());
  }
  await waitFor(() => [...document.querySelectorAll('.settings-row')].some(row => row.textContent.includes('Software updates')), 'software updates settings entry');
  const updatesButton = [...document.querySelectorAll('.settings-row')].find(row => row.textContent.includes('Software updates')).querySelector('button');
  updatesButton.focus();
  updatesButton.click();
  await waitFor(() => document.querySelector('.app-update-dialog')?.open, 'native updater state opens in-app dialog');
  const updateState = await window.bordeauxAPI.getAppUpdateState();
  const updaterStateVisible = updateState.visible && typeof updateState.currentVersion === 'string'
    && Boolean(document.querySelector('.app-update-versions')?.textContent.includes(updateState.currentVersion));
  document.querySelector('button[aria-label="Close updates"]').click();
  await waitFor(async () => !document.querySelector('.app-update-dialog')?.open && !(await window.bordeauxAPI.getAppUpdateState()).visible, 'updater closes through native IPC');
  const updaterIntegration = updaterStateVisible && document.activeElement === updatesButton;
  const project = { schemaVersion: '1.0', field: { id: '2026-rebuilt', revision: '2026-manual-tu19-welded-4', coordinateSchemaId: 'wpilib-blue-origin/2026-welded/1' }, name: 'Smoke edited', robot: { drive: 'swerve', w: .8, l: .8, maxSpeed: 4 }, paths: [{ id: 'path_smoke', name: 'Smoke', waypoints: [{ x: 1, y: 1, theta: 0, thetaOn: true, linked: true, stop: false, prevC: { x: .8, y: 1 }, nextC: { x: 1.2, y: 1 } }, { x: 2, y: 1, theta: 0, thetaOn: true, linked: true, stop: false, prevC: { x: 1.8, y: 1 }, nextC: { x: 2.2, y: 1 } }], targets: [], markers: [{ id: 'event_smoke', f: .5, name: 'Smoke event', invocation: { commandId: 'frc.robot.SmokeCommand', arguments: { count: 2, sequence: '9007199254740993', tags: ['auto'] }, cancelOnPathEnd: true } }], ranges: [], constraints: { maxVel: 2, maxAccel: 2, maxDecel: 2, maxAngVel: 180, maxAngAccel: 360 }, startVel: 0, goalVel: 0 }], pathLinks: [], routines: [{ id: 'routine_smoke_active', name: 'Smoke routine', nodes: [{ id: 'routine_smoke', type: 'path', ref: 'path_smoke' }] }], activeRoutineId: 'routine_smoke_active', plannerId: 'profiledSpline' };
  await window.bordeauxAPI.saveProject(project, true);
  await waitFor(() => document.getElementById('robot-drive-motor'), 'robot settings');
  document.getElementById('robot-drive-motor').click();
  for (let attempt = 0; attempt < 50 && !document.querySelector('#robot-drive-motor-listbox [data-value="rev-neo"]'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  document.querySelector('#robot-drive-motor-listbox [data-value="rev-neo"]')?.click();
  let motorAutosave;
  await waitFor(async () => {
    motorAutosave = await savedCheckpoint();
    return motorAutosave?.project.robot.driveModel?.motorId === 'rev-neo';
  }, 'motor preset autosave');
  const motorPreset = motorAutosave.project.robot.driveModel?.motorId === 'rev-neo'
    && motorAutosave.project.robot.driveModel?.motorFreeRpm === 5676
    && Number.isFinite(motorAutosave.project.robot.maxSpeed)
    && motorAutosave.project.robot.maxSpeed > 0;
  // The main harness compares persisted speed with the shared electrical model.
  // A preset's no-load gearing speed is no longer the planning speed.
  const motorPresetRobot = motorAutosave.project.robot;
  const validation = await window.bordeauxAPI.validateProject(project);
  const robotConnection = await inCurrentProject((context) => window.bordeauxAPI.linkRobotProject(context), 'LabVIEW link');
  const builtRobotConnection = await inCurrentProject((context) => window.bordeauxAPI.buildRobotCatalog(context), 'catalog build');
  const recentRobotProjects = await window.bordeauxAPI.listRecentRobotProjects();
  if (recentRobotProjects.length !== 1) throw new Error('Smoke requires exactly its seeded recent robot project');
  const reopenedRobotConnection = await inCurrentProject((context) => window.bordeauxAPI.openRecentRobotProject(recentRobotProjects[0].id, context), 'recent robot code');
  const portableLink = reopenedRobotConnection.editorLink;
  if (portableLink?.labviewProjectPath !== 'robot-project/SmokeRobot.lvproj' || 'robotProjectBookmarkId' in portableLink) {
    throw new Error('Smoke robot code must use the main-authored relative LabVIEW link');
  }
  // API probes above exercise real discovery/build/recents. The shipping chip action adopts the link into App.
  await openProjectMenu();
  const linkButton = projectMenuItem('Link robot code…');
  if (!linkButton || linkButton.disabled) throw new Error('Project menu must offer Link robot code');
  linkButton.click();
  await waitFor(() => !document.getElementById('project-menu'), 'robot-code link menu closes');
  await openProjectMenu();
  await waitFor(() => projectMenuItem('Change robot code…') && !projectMenuItem('Change robot code…').disabled
    && document.querySelector('.project-menu-code')?.textContent.includes('SmokeRobot'), 'linked robot code in project menu');
  const changeButton = projectMenuItem('Change robot code…');
  changeButton.click();
  await waitFor(() => !document.getElementById('project-menu'), 'robot-code change menu closes');
  await openProjectMenu();
  await waitFor(() => projectMenuItem('Change robot code…') && !projectMenuItem('Change robot code…').disabled
    && document.querySelector('.project-menu-code')?.textContent.includes('SmokeRobot'), 'changed robot code in project menu');
  const linkedCodeName = document.querySelector('.project-menu-code').textContent;
  const recentCodeButton = projectMenuItem('Recent robot code');
  if (!recentCodeButton) throw new Error('Linked robot code must expose its recent list');
  recentCodeButton.click();
  await waitFor(() => recentCodeButton.getAttribute('aria-expanded') === 'true', 'expanded recent robot code');
  const recentHiddenForSingleProject = !document.querySelector('.project-menu-recent');
  document.querySelector('.project-chip').click();
  const secondPath = structuredClone(project.paths[0]);
  secondPath.id = 'path_smoke_second'; secondPath.name = 'Smoke second';
  secondPath.markers = [];
  const persistedProject = { ...project, paths: [...project.paths, secondPath], editor: { activePathId: secondPath.id, ...portableLink } };
  [...document.querySelectorAll('.places .place')].find((button) => button.textContent.trim() === 'Paths')?.click();
  for (let attempt = 0; attempt < 100; attempt++) {
    const planStage = document.querySelector('.stage-plan .fieldcol');
    if (planStage?.dataset.planningReady === 'true') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await addMarker(0.4);
  // Placement opens the shipping docked command chooser directly. Parameters remain behind More.
  await waitFor(() => document.getElementById('band-command-search') && document.querySelector('#band-command-listbox [role="option"]'), 'direct marker command chooser');
  const directCommandOptions = [...document.querySelectorAll('#band-command-listbox [role="option"]')];
  if (directCommandOptions.length !== robotConnection.catalog.commands.length) throw new Error('Direct chooser must offer the discovered commands');
  document.querySelector('#band-command-listbox [data-value="frc.robot.SmokeCommand"]').click();
  await waitFor(() => document.getElementById('band-command-value')?.textContent === 'Smoke Command'
    && !document.getElementById('band-command-listbox'), 'direct marker command selection');
  const more = document.querySelector('.pp-more');
  if (more && more.getAttribute('aria-expanded') !== 'true') more.click();
  await waitFor(() => document.querySelector('.cmd-command-editor .choice-change'), 'selected marker command inspector');
  document.querySelector('.cmd-command-editor .choice-change').click();
  await waitFor(() => document.getElementById('event-marker-command')?.disabled === false, 'inspector command search enabled');
  const commandPicker = document.getElementById('event-marker-command');
  const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const commandOptions = [...document.querySelectorAll('#event-marker-command-results [role="option"]')];
  const commandSearch = commandPicker;
  // The inline browser searches command labels and parameter metadata even in small catalogs.
  setInputValue.call(commandSearch, 'Smoke Count');
  commandSearch.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => document.querySelectorAll('#event-marker-command-results [role="option"]').length === 1, 'command and parameter search');
  const smokeCommandOption = [...document.querySelectorAll('#event-marker-command-results [role="option"]')]
    .find((option) => option.querySelector('strong')?.textContent === 'Smoke Command');
  if (!smokeCommandOption) throw new Error('Smoke Command was not found by command and parameter search');
  smokeCommandOption.click();
  await waitFor(() => document.getElementById('event-command-param-tags'), 'selected command parameters');
  const jsonParameter = document.getElementById('event-command-param-tags');
  const exactIntegerParameter = document.getElementById('event-command-param-sequence');
  const smokeParametersPresent = Boolean(document.getElementById('event-command-param-count') && jsonParameter && exactIntegerParameter);
  const setTextAreaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  if (jsonParameter) {
    setTextAreaValue.call(jsonParameter, '{}');
    jsonParameter.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    jsonParameter.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  await waitFor(() => jsonParameter?.getAttribute('aria-invalid') === 'true', 'invalid JSON parameter rejected');
  const jsonShapeRejected = jsonParameter?.getAttribute('aria-invalid') === 'true';
  if (jsonParameter) {
    setTextAreaValue.call(jsonParameter, '["auto"]');
    jsonParameter.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    jsonParameter.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  await waitFor(() => jsonParameter?.getAttribute('aria-invalid') === 'false', 'valid JSON parameter accepted');
  if (exactIntegerParameter) {
    setInputValue.call(exactIntegerParameter, '9223372036854775808');
    exactIntegerParameter.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    exactIntegerParameter.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  await waitFor(() => exactIntegerParameter?.getAttribute('aria-invalid') === 'true', 'out-of-range I64 rejected');
  const longRangeRejected = exactIntegerParameter?.getAttribute('aria-invalid') === 'true';
  if (exactIntegerParameter) {
    setInputValue.call(exactIntegerParameter, '9007199254740993');
    exactIntegerParameter.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    exactIntegerParameter.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  await waitFor(() => exactIntegerParameter?.getAttribute('aria-invalid') === 'false', 'exact I64 accepted');
  document.querySelector('.cmd-command-editor .choice-change')?.click();
  await waitFor(() => document.querySelector('#event-marker-command-results [role="option"]'), 'change command browser');
  const largeEnumCommandOption = [...document.querySelectorAll('#event-marker-command-results [role="option"]')]
    .find((option) => option.querySelector('strong')?.textContent === 'Choose Autonomous Mode');
  if (!largeEnumCommandOption) throw new Error('Large enum command was not available');
  largeEnumCommandOption.click();
  await waitFor(() => document.getElementById('event-command-param-mode'), 'large enum parameter');
  const largeEnumPicker = document.getElementById('event-command-param-mode');
  largeEnumPicker?.click();
  for (let attempt = 0; attempt < 50 && !document.querySelector('#event-command-param-mode-listbox [role="option"]'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const largeEnumOptions = [...document.querySelectorAll('#event-command-param-mode-listbox [role="option"]')];
  const largeEnumOverflowNotice = document.querySelector('#event-command-param-mode-listbox .cmd-picker-more')?.textContent || '';
  const largeEnumSearch = document.getElementById('event-command-param-mode-search');
  if (largeEnumSearch) {
    setInputValue.call(largeEnumSearch, 'MODE_150');
    largeEnumSearch.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  for (let attempt = 0; attempt < 50 && !document.querySelector('#event-command-param-mode-listbox [data-value="MODE_150"]'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const largeEnumChoice = [...document.querySelectorAll('#event-command-param-mode-listbox [role="option"]')]
    .find((option) => option.getAttribute('data-value') === 'MODE_150');
  largeEnumChoice?.click();
  for (let attempt = 0; attempt < 50 && document.getElementById('event-command-param-mode-value')?.textContent !== 'MODE_150'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const robotUi = {
    markerInspector: Boolean(document.querySelector('section[aria-label="Marker command"]') && !document.querySelector('.ctxinsp .labview-project-panel') && linkedCodeName.includes('SmokeRobot')),
    linkAction: Boolean(linkButton && changeButton),
    commandEnabled: Boolean(commandPicker && !commandPicker.disabled),
    commandOptions: commandOptions.length,
    commandSearch: commandSearch?.getAttribute('role') === 'combobox',
    recentHiddenForSingleProject,
    cancelSwitch: Boolean(document.getElementById('event-command-cancel') && document.querySelector('.cmd-toggle-track')),
    parameter: smokeParametersPresent,
    jsonShapeRejected,
    jsonShapeAccepted: jsonParameter?.getAttribute('aria-invalid') === 'false',
    longRangeRejected,
    exactInteger: exactIntegerParameter?.value === '9007199254740993' && exactIntegerParameter?.type === 'text',
    largeEnumDetails: { optionCount: largeEnumOptions.length, overflowNotice: largeEnumOverflowNotice, searchPresent: Boolean(largeEnumSearch), selectedValue: document.getElementById('event-command-param-mode-value')?.textContent, commandFound: Boolean(largeEnumCommandOption), pickerFound: Boolean(largeEnumPicker) },
    largeEnumPicker: largeEnumOptions.length === 80
      && largeEnumOverflowNotice.includes('80 of 160 shown')
      && Boolean(largeEnumSearch)
      && document.getElementById('event-command-param-mode-value')?.textContent === 'MODE_150',
    accessible: unnamedOnPage().length === 0,
  };
  await addMarker(0.65);
  let markerAutosave;
  await waitFor(async () => {
    markerAutosave = await savedCheckpoint();
    return markerAutosave?.project.paths[0].markers.length === 2;
  }, 'second event marker autosave');
  const eventMarkerAutosave = markerAutosave.project.paths[0].markers.length === 2
    && markerAutosave.project.paths[0].markers[1].name === 'event2'
    && markerAutosave.project.editor?.labviewProjectPath === portableLink.labviewProjectPath
    && !('robotProjectBookmarkId' in markerAutosave.project.editor);
  await waitFor(async () => !(await window.bordeauxAPI.getAppUpdateState()).projectDirty, 'marker autosave settled before source roundtrip');
  let missingTypeEvidenceRejected = false;
  const commandedExport = structuredClone(persistedProject);
  commandedExport.paths[0].markers[0].invocation.cancelOnPathEnd = false;
  // The declarative fixture has commands but no NI connector/type evidence. Keep its real link so this
  // tests that evidence gate, rather than accepting a missing-command or mismatched-project refusal.
  try { await window.bordeauxAPI.exportBdx(commandedExport, commandedExport.paths[0].id); }
  catch (error) { missingTypeEvidenceRejected = /has no inspected original VI filename/.test(String(error && error.message || error)); }
  if (!missingTypeEvidenceRejected) throw new Error('Commanded export must reject missing inspected VI evidence');
  const eventless = structuredClone(persistedProject);
  for (const path of eventless.paths) path.markers = [];
  const exportedBdx = await window.bordeauxAPI.exportBdx(eventless, eventless.paths[0].id);
  // Repeated Save keeps the source admitted. New would detach main while leaving App on its old document.
  const generated = await window.bordeauxAPI.saveProject(eventless, true);
  const saved = await window.bordeauxAPI.saveProject(persistedProject, true);
  if (generated.location?.projectPath !== initialSession.location.projectPath || saved.location?.projectPath !== initialSession.location.projectPath) {
    throw new Error('Smoke Save must retain its admitted source');
  }
  const savedFolderName = saved.location.folderPath.split(/[\\/]/).filter(Boolean).at(-1);
  const beforeReopen = await window.bordeauxAPI.getProjectSession();
  await openProjectMenu();
  projectMenuItem('Projects…').click();
  await waitFor(() => document.querySelector('dialog.pj-sheet[open][aria-label="Projects"] [data-action="open-folder"]'), 'Projects Open folder action');
  document.querySelector('dialog.pj-sheet[open][aria-label="Projects"] [data-action="open-folder"]').click();
  let reopenedSession;
  await waitFor(async () => {
    reopenedSession = await window.bordeauxAPI.getProjectSession();
    return reopenedSession.context.documentSessionId !== beforeReopen.context.documentSessionId && reopenedSession.lifecycleReady
      && reopenedSession.location.projectPath === initialSession.location.projectPath
      && !document.querySelector('dialog.pj-sheet[open]')
      && document.querySelector('.editor-library .library-pick[aria-current="true"]')?.dataset.libraryItem === secondPath.id;
  }, 'real source reopened through App with restored active path');
  // An actual App Save checkpoints the source it just loaded. The canonical readback must belong to this
  // new session and include the loaded path/routine/editor state; no replacement of the IPC bridge is needed.
  await openProjectMenu();
  await waitFor(() => projectMenuItem('Change robot code…') && !projectMenuItem('Change robot code…').disabled
    && document.querySelector('.project-menu-code')?.textContent.includes('SmokeRobot'), 'relative LabVIEW link restored after source reopen');
  projectMenuItem('Save').click();
  let opened;
  await waitFor(async () => {
    opened = await savedCheckpoint();
    return opened?.project.editor?.activePathId === secondPath.id;
  }, 'reopened source checkpoint');
  if (!sameContext(reopenedSession.context, (await window.bordeauxAPI.getProjectSession()).context)) throw new Error('Smoke reopened source session changed');
  const restored = opened;
  [...document.querySelectorAll('.places .place')].find((button) => button.textContent.trim() === 'Routines')?.click();
  await waitFor(() => document.querySelector('.places [aria-current="page"]')?.textContent === 'Routines', 'routine library');
  const routineLibraryOpened = document.querySelector('.places [aria-current="page"]')?.textContent === 'Routines';
  const routineRows = () => [...document.querySelectorAll('.editor-library .library-pick[data-library-item]')];
  const activeRoutineRow = () => document.querySelector('.editor-library .library-pick[aria-current="true"]');
  const routineName = (row) => row?.querySelector('.library-name')?.textContent;
  const originalRoutineIds = routineRows().map(row => row.dataset.libraryItem);
  document.querySelector('button[aria-label="New routine"]')?.click();
  // Creation selects the new routine and opens its rename form; the committed row exists only after Save name.
  await waitFor(() => document.querySelector('.library-rename input[aria-label="Name"]')?.value === 'New routine', 'new routine rename form');
  document.querySelector('.library-rename').requestSubmit();
  await waitFor(() => {
    const row = activeRoutineRow();
    return !document.querySelector('.library-rename') && routineName(row) === 'New routine'
      && row.dataset.libraryItem && !originalRoutineIds.includes(row.dataset.libraryItem)
      && routineRows().length === originalRoutineIds.length + 1;
  }, 'new routine committed as the selected distinct row');
  const newRoutineId = activeRoutineRow().dataset.libraryItem;
  const newRoutineSelected = routineName(activeRoutineRow()) === 'New routine' && !originalRoutineIds.includes(newRoutineId);
  document.querySelector('button[aria-label="Actions for New routine"]').click();
  await waitFor(() => [...document.querySelectorAll('.library-menu button')].some(button => button.textContent.trim() === 'Duplicate'), 'routine Duplicate action');
  [...document.querySelectorAll('.library-menu button')].find((button) => button.textContent.trim() === 'Duplicate').click();
  await waitFor(() => document.querySelector('.library-rename input[aria-label="Name"]')?.value === 'New routine copy', 'duplicate routine rename form');
  document.querySelector('.library-rename').requestSubmit();
  await waitFor(() => {
    const row = activeRoutineRow(), id = row?.dataset.libraryItem, rows = routineRows();
    return !document.querySelector('.library-rename') && routineName(row) === 'New routine copy'
      && id && id !== newRoutineId && !originalRoutineIds.includes(id)
      && rows.length === originalRoutineIds.length + 2 && new Set(rows.map(item => item.dataset.libraryItem)).size === rows.length
      && rows.some(item => item.dataset.libraryItem === newRoutineId && routineName(item) === 'New routine');
  }, 'duplicate routine committed as the selected distinct row');
  const duplicateRoutineId = activeRoutineRow().dataset.libraryItem;
  const routineDuplicateSelected = routineName(activeRoutineRow()) === 'New routine copy' && duplicateRoutineId !== newRoutineId;
  const multiRoutineUi = routineLibraryOpened && newRoutineSelected && routineDuplicateSelected;
  const routineUiDetails = { routineLibraryOpened, newRoutineSelected, routineDuplicateSelected, originalCount: originalRoutineIds.length,
    finalCount: routineRows().length, newRoutineId, duplicateRoutineId, selectedName: routineName(activeRoutineRow()) };
  // SFTP delivery uploads paths only; the routine toolbar has no Push action or placeholder label.
  const routineDeliveryBlocked = ![...document.querySelectorAll('.push-control button')].some((button) => button.textContent.trim() === 'Push routine')
    && !document.querySelector('.push-local')
    && !document.querySelector('[aria-labelledby="robot-file-title"]')?.open;
  if (!routineDeliveryBlocked) throw new Error('Routines must stay local without a Push action');
  [...document.querySelectorAll('.places .place')].find(button => button.textContent.trim() === 'Paths').click();
  await waitFor(() => [...document.querySelectorAll('.push-control .push-button')].some(button => button.textContent.trim() === 'Push path'), 'path push action');
  [...document.querySelectorAll('.push-control .push-button')].find(button => button.textContent.trim() === 'Push path').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await waitFor(() => document.querySelector('[aria-labelledby="robot-file-title"]')?.open
    && document.querySelector('[aria-labelledby="robot-file-title"] input[placeholder="roborio-2468-frc.local"]'), 'SFTP connection fields');
  const robotPushUi = routineDeliveryBlocked && window.bordeauxAPI.robotDeliveryCapabilities.pathPush && window.bordeauxAPI.robotDeliveryCapabilities.routinePush === false
    && [...document.querySelectorAll('[aria-labelledby="robot-file-title"] input')].some(input => input.value === '/home/lvuser/natinst/bin/Paths')
    && !document.querySelector('[aria-labelledby="robot-file-title"]').textContent.includes('compatible LabVIEW BDX receiver');
  // Exercise real unsaved renderer state. A raw setDirty(true) is overwritten
  // legitimately when an earlier autosave finishes, making the close probe race.
  document.querySelector('button[aria-label="Close robot files"]').click();
  [...document.querySelectorAll('.places .place')].find(button => button.textContent.trim() === 'Settings').click();
  await waitFor(() => document.querySelector('input[aria-label="Drive reduction"]'), 'unsaved draft input');
  await new Promise(resolve => setTimeout(resolve, 1100));
  const unsavedInput = document.querySelector('input[aria-label="Drive reduction"]');
  unsavedInput.focus();
  setInputValue.call(unsavedInput, '-');
  unsavedInput.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  unsavedInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  await waitFor(() => unsavedInput.getAttribute('aria-invalid') === 'true', 'invalid draft remains unsaved');
  await new Promise(resolve => setTimeout(resolve, 1100));
  const unsavedDraftRetained = (await window.bordeauxAPI.getAppUpdateState()).projectDirty === true;

  const probe = document.createElement('script'); probe.textContent = 'window.__bordeauxInlineScriptRan = true'; document.head.appendChild(probe);
  const editorRestored = opened.project.editor?.activePathId === secondPath.id && opened.project.editor?.labviewProjectPath === portableLink.labviewProjectPath && !('robotProjectBookmarkId' in opened.project.editor);
  const popupBlocked = window.open('https://example.com') === null;
  await window.bordeauxAPI.setAppUpdatesVisible(true);
  await waitFor(() => document.querySelector('.app-update-dialog')?.open, 'updater visible for final built-app capture');
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const updateDialog = document.querySelector('.app-update-dialog');
  const updaterModalVisible = updateDialog.matches(':modal') && updateDialog.getBoundingClientRect().width > 0;
  return { startupAdopted, updaterIntegration, updaterModalVisible, unsavedDraftRetained, title: document.title, api: typeof window.bordeauxAPI?.saveProject === "function", root: Boolean(document.getElementById("root")?.children.length), fatalError: document.querySelector('.fatal-error')?.textContent || '', unnamed, main: document.querySelectorAll('main').length, nav: document.querySelectorAll('nav').length, validation: validation.ok, motorPreset, motorPresetRobot, eventMarkerAutosave, multiRoutineUi, routineUiDetails, robotPushUi, robotDiscovery: robotConnection.catalog.projectName === 'SmokeRobot' && robotConnection.catalog.commands.some((command) => command.id === 'frc.robot.SmokeCommand'), robotBuilt: builtRobotConnection.catalog.authoritative === true && builtRobotConnection.catalog.catalogHash === reopenedRobotConnection.catalog.catalogHash, robotRecent: recentRobotProjects.length === 1 && reopenedRobotConnection.catalog.projectName === 'SmokeRobot', robotUi, missingTypeEvidenceRejected, folderBdxSaved: generated.saved && generated.bdxCount === eventless.paths.length && !generated.exportError, sourceSavedOnBdxFailure: saved.saved && Boolean(saved.exportError), eventlessBdxExported: exportedBdx.exported && exportedBdx.eventCount === 0, restored: restored.project.name === savedFolderName, roundTrip: saved.saved && opened.project.name === savedFolderName && opened.project.routines.find((routine) => routine.id === opened.project.activeRoutineId)?.nodes[0]?.ref === 'path_smoke' && !('routine' in opened.project), editorRestored, nodeGlobalsBlocked: typeof require === 'undefined', popupBlocked, inlineScriptBlocked: !window.__bordeauxInlineScriptRan };
})();
