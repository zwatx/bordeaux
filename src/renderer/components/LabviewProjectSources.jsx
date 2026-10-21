import * as React from "react";

const h = React.createElement;

export function LabviewProjectPanel({ robotProject }) {
  const [showRecent, setShowRecent] = React.useState(false);
  const catalog = robotProject?.catalog;
  const operation = robotProject?.operation;
  const windows = typeof window !== 'undefined' && window.bordeauxAPI?.platform === 'win32';
  const inspection = catalog?.labviewDiscovery?.inspection;
  const busy = !!operation;
  const recent = (robotProject?.recentProjects || []).filter((project) => project.id !== robotProject?.bookmarkId);
  const commands = catalog?.commands || [];
  React.useEffect(() => setShowRecent(false), [robotProject?.bookmarkId]);
  return h('section', { className: 'labview-project-panel', 'aria-label': 'LabVIEW project', 'aria-busy': busy },
    h('div', { className: 'labview-project-heading' }, 'LabVIEW project'),
    catalog && h('strong', { className: 'labview-project-name' }, catalog.projectName),
    h('p', { className: 'labview-project-status', role: 'status' }, busy ? (operation === 'build' ? 'Building command catalog…' : 'Syncing project and commands…')
      : !catalog ? 'Choose a project to load its commands.'
      : robotProject.status === 'stale' ? 'Project changed. Sync to update commands.'
      : commands.length + ' command' + (commands.length === 1 ? '' : 's') + ' available'),
    h('div', { className: 'labview-project-actions' },
      h('button', { className: 'qbtn', type: 'button', disabled: busy, onClick: robotProject?.link }, catalog ? 'Change project' : 'Choose LabVIEW project'),
      catalog && h('button', { className: 'qbtn', type: 'button', disabled: busy, onClick: robotProject?.refresh, title: windows ? 'Reload the project and inspect command inputs in LabVIEW' : 'Reload project sources and saved command inputs' }, 'Sync commands')),
    catalog?.conditions?.length > 0 && !catalog.authoritative && h('button', { className: 'labview-text-action', type: 'button', disabled: busy, onClick: robotProject?.build }, 'Build catalog for conditions'),
    !windows && catalog && h('p', { className: 'labview-project-help' }, 'Using saved inputs. Sync on Windows to update them.'),
    inspection?.reason && !robotProject?.error && h('p', { className: 'cmd-project-warning' }, inspection.reason),
    robotProject?.error && h('p', { className: 'cmd-project-error', role: 'alert' }, robotProject.error),
    robotProject?.notice && h('p', { className: 'cmd-project-notice', role: 'status' }, robotProject.notice),
    recent.length > 0 && h('button', { className: 'labview-text-action', type: 'button', disabled: busy, 'aria-expanded': showRecent, onClick: () => setShowRecent(!showRecent) }, showRecent ? 'Hide recent projects' : 'Recent projects'),
    showRecent && h('div', { className: 'labview-recent-projects' }, recent.map((project) => h('button', { key: project.id, type: 'button', disabled: busy, onClick: () => robotProject.openRecent(project.id) },
      h('strong', null, project.projectName), h('span', null, project.folderName)))),
    catalog && h(LabviewProjectSources, { key: catalog.labviewDiscovery?.projectFile, catalog }));
}

/** Project membership is useful evidence, but does not establish a VI's connector contract. */
export function LabviewProjectSources({ catalog, initiallyExpanded = false }) {
  const [expanded, setExpanded] = React.useState(initiallyExpanded);
  const [query, setQuery] = React.useState('');
  const [limit, setLimit] = React.useState(40);
  const discovery = catalog && catalog.labviewDiscovery;
  if (!discovery) return null;
  const search = query.trim().toLowerCase();
  const sources = discovery.items.filter((item) => item.file || item.status !== 'present');
  const matches = sources.filter((item) => [item.name, item.target, item.file, item.type, item.reason].filter(Boolean).join(' ').toLowerCase().includes(search));
  const warnings = catalog.warnings || [];
  return h('div', { className: 'labview-sources' },
    h('button', { className: 'labview-text-action', type: 'button', 'aria-expanded': expanded, onClick: () => setExpanded(!expanded) }, expanded ? 'Hide sources' : 'View sources (' + discovery.viCount + ' VIs)'),
    expanded && h('div', { className: 'labview-source-content' },
    h('p', { className: 'labview-source-meta' }, discovery.projectFile + ', ' + discovery.targets.map((target) => target.name).join(', ')),
    discovery.inspection?.reason && h('p', { className: 'labview-source-meta' }, discovery.inspection.reason),
    h('label', { className: 'fieldlabel' }, 'Find a project source',
      h('input', { className: 'textinput', type: 'search', value: query, placeholder: 'Name, folder, or target',
        onChange: (event) => { setQuery(event.target.value); setLimit(40); },
        onKeyDown: (event) => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); setLimit(40); } },
      })),
    h('div', { className: 'labview-source-list', tabIndex: 0, role: 'region', 'aria-label': 'LabVIEW project sources' },
      matches.slice(0, limit).map((item) => h('div', { className: 'labview-source-row', key: item.target + ':' + item.projectPath + ':' + item.file },
        h('strong', null, item.name),
        h('span', { className: 'labview-source-meta' }, item.target + ', ' + (item.file || item.projectPath)),
        item.status !== 'present' && h('span', { className: 'cmd-project-warning' }, item.reason || item.status))),
      !matches.length && h('p', { className: 'seg-hint' }, sources.length ? 'No sources match this search.' : 'This project has no file references.')),
    matches.length > limit && h('button', { className: 'morebtn', type: 'button', onClick: () => setLimit(limit + 40) }, 'Show more sources (' + (matches.length - limit) + ' remaining)'),
    discovery.truncated && h('p', { className: 'cmd-project-warning' }, 'The project exceeded discovery limits. Some sources are not shown.'),
    warnings.length > 0 && h('div', { className: 'labview-source-warnings' },
      h('strong', null, warnings.length + ' discovery warning' + (warnings.length === 1 ? '' : 's')),
      h('div', { className: 'source-warning-list' }, warnings.map((warning, index) => h('p', { key: index }, warning)))),
    (discovery.inspection?.unsupported || []).map((item) => h('div', { className: 'cmd-project-warning', key: item.target + ':' + item.file }, h('strong', null, item.file), h('p', null, item.reason)))));
}
