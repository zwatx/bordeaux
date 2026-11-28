"""Author Bordeaux's macOS LabVIEW 2026 connector inspection helper, InspectCommandsMac.vi.

Developer-only, like build-labview-wrapper-helper.py: --native-tools points to the directory containing
lvscript.py/lvbuild.py, and LabVIEW 2026 must be running with VI Server TCP enabled on 127.0.0.1 and
VI Scripting (with private members) enabled. The shipped desktop runs the saved VI over VI Server TCP;
it needs no Python, toolkit or scripting setting. Build and verify with LabVIEW 2026 26.3.1f1 (64-bit).

The helper is the macOS counterpart of InspectCommands.ps1's inspection request, one VI per run:
  1. finds the already-open project whose path equals 'project path' (Application Project.Projects[] ->
     Project.Path), never opening a project (error 5101 when none matches),
  2. takes that project's My Computer application instance (Project.App Ref) and refuses any other
     context name (error 5102),
  3. with a blank 'vi path', stops there: a project and context check,
  4. otherwise opens the VI in that context with options 0x20 (no load dialogs, no run reservation),
     refuses a VI LabVIEW loaded from another path (error 5103) and reads its name, description,
     VI type, execution state and modification bitsets before and after the read,
  5. with 'read default' false, exports the connector (VI Export Interface, the COM _ExportInterface2),
     skipping a global VI (VI Type 3); with 'read default' true, reads the saved default of the control
     labelled 'control name' (Ctrl Val.Get Default) instead.
It never runs, edits or saves the inspected VI and closes its reference. Error 5100 is internal (a
skipped step) and is cleared before 'error out'.
"""
import argparse
import json
import os
import sys
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument('--native-tools', type=Path, required=True)
parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'resources/labview-inspection/InspectCommandsMac.vi')
args = parser.parse_args()
os.environ.setdefault('LABVIEW_WORKER_NAMESPACE', 'bordeaux-mac-inspection-authoring')
sys.path.insert(0, str(args.native_tools.resolve()))
import lvscript
from lvscript import Session
from lvbuild import VIBuilder, Node

SKIPPED, PROJECT_NOT_OPEN, WRONG_CONTEXT, WRONG_VI = 5100, 5101, 5102, 5103
AUTO_ERROR_HANDLING = 'Automatic Error Handling'
GLOBAL_VI = 3  # VI Type enum: global VIs have no callable connector
s = Session()
if s.version_info['major'] != 26:
    raise RuntimeError(f'Build InspectCommandsMac.vi with LabVIEW 2026, not {s.version_info["actual_version"]}.')
output = args.output.resolve()
if output.exists():
    raise RuntimeError(f'{output} exists; choose a fresh output path. Existing helper artifacts are preserved.')
output.parent.mkdir(parents=True, exist_ok=True)
ERROR_FROM_CODE = Path(lvscript.LV) / 'vi.lib' / 'Utility' / 'error.llb' / 'Error Cluster From Error Code.vi'
STANDARD = {'reference', 'reference out', 'error in (no error)', 'error out'}


def terminal(node, name, source):
    """A member node lists an input and output with the same name; pick by direction."""
    matches = [ref for label, ref, is_source in node.terminals if label == name and bool(is_source) == source]
    if len(matches) != 1:
        raise KeyError(f'{name!r} ({"output" if source else "input"}) not unique in {[t[0] for t in node.terminals]}')
    return matches[0]


def member(builder, kind, cls, name, reference=None, error=None, **inputs):
    where = builder._xy()
    before = set(s.prop_get('Diagram', 'Nodes[]', builder.diagram))
    s._member_node(builder.diagram, kind, cls, name, False, where, builder.path)
    added = set(s.prop_get('Diagram', 'Nodes[]', builder.diagram)) - before
    ref, = [ref for ref in added if s.prop_get('GObject', 'Class Name', ref) == ('Invoke' if kind == 'method' else 'Property')]
    node = Node(ref, builder._terminals(ref))
    if reference is not None:
        builder.wire(reference, node['reference'])
    if error is not None:
        builder.wire(error, node['error in (no error)'])
    for label, src in inputs.items():
        builder.wire(src, terminal(node, label.replace('__', ' '), False))
    return node


def value(node):
    """The one value output of a single-item property node."""
    outputs = [ref for label, ref, source in node.terminals if source and label not in STANDARD]
    if len(outputs) != 1:
        raise KeyError(f'expected one value output in {[t[0] for t in node.terminals]}')
    return outputs[0]


def panel_object(builder, style, label, position):
    ref = s.new_object(builder.panel, style, position)
    s.prop_set('Text', 'Text', s.prop_get('Control', 'Label', ref), label)
    return s.prop_get('Control', 'Terminal', ref)


def string_constant(builder, text):
    ref = s.new_object(builder.diagram, 'String Constant', builder._xy())
    s.prop_set('Constant', 'Value', ref, text)
    return s.prop_get('Constant', 'Terminal', ref)


def path_to_string(builder, path):
    node = builder.node('Path To String')  # node() reserves its own 'path' argument
    builder.wire(path, node['path'])
    return node['string']


panel_slot = [0]


def indicator(builder, source, label):
    """An indicator of the source's exact type, labelled for the VI Server caller."""
    made = s.method('Terminal', 'Create Indicator', source)
    ref = next(item for item in made.values() if isinstance(item, int) and item)
    control = s.prop_get('ControlTerminal', 'Control', ref) if s.prop_get('GObject', 'Class Name', ref).endswith('Terminal') else ref
    s.prop_set('Text', 'Text', s.prop_get('Control', 'Label', control), label)
    column, row = divmod(panel_slot[0], 12)
    panel_slot[0] += 1
    s.prop_set('GObject', 'Position', control, (320 + 300 * column, 20 + 60 * row))
    term = s.prop_get('Control', 'Terminal', control)
    if not s.prop_get('Terminal', 'Connected Wire', term):
        builder.wire(source, term)


def error_unless(builder, condition, code, error=None):
    """Error `code` when `condition` is false; otherwise passes `error` (an earlier error always wins)."""
    selected = builder.node('Select', s=condition, t=builder.const(0), f=builder.const(code))
    inputs = {'error code (0)': selected['s? t:f']}
    if error is not None:
        inputs['error in (no error)'] = error
    return builder.subvi(ERROR_FROM_CODE, **inputs)['error out']


def clear_skipped(builder, error):
    """`error` without the internal SKIPPED marker."""
    unbundle = builder.node('Unbundle')
    inputs = [ref for _, ref, source in unbundle.terminals if not source]
    builder.wire(error, inputs[0])
    code = [ref for _, ref, source in s.terminal_rows(unbundle.ref) if source][1]  # status, code, source
    skipped = builder.node('Equal?', x=code, y=builder.const(SKIPPED))
    no_error = builder.subvi(ERROR_FROM_CODE, **{'error code (0)': builder.const(0)})['error out']
    return builder.node('Select', s=skipped['x = y?'], t=no_error, f=error)['s? t:f']


def merge(builder, first, second):
    merged = builder.node('Merge Errors', **{'error in[0]': first})
    builder.wire(second, merged['error in[1]'])
    return merged['error out']


b = VIBuilder(s, output)
project_path = panel_object(b, 'String Control (modern)', 'project path', (20, 20))
vi_path = panel_object(b, 'String Control (modern)', 'vi path', (20, 90))
control_name = panel_object(b, 'String Control (modern)', 'control name', (20, 160))
read_default = panel_object(b, 'Push Button', 'read default', (20, 230))
# Every request reports its errors through 'error out'; LabVIEW must never show an error dialog.
s.prop_set('VI', AUTO_ERROR_HANDLING, s.vi(output), False)

# 1. The exact project, only if it is already open (COM AllProjects -> Path).
projects = member(b, 'property', 'Application', 'Project.Projects[]')
project_count = b.node('Array Size', array=value(projects))
paths_loop = b.for_loop(project_count['size(s)'], location=(900, 40), size=(500, 260))
listed = paths_loop.body.node('Index Array', array=paths_loop.outer(value(projects)), index=paths_loop.i)
listed_path = member(paths_loop.body, 'property', 'Project', 'Path', listed['element'])
listed_text = path_to_string(paths_loop.body, value(listed_path))
# A project closing mid-list only drops its own path (automatic error handling is off below).
found = b.node('Search 1D Array', element=project_path)
b.wire(paths_loop.indexed(listed_text), found['1D array'])
is_open = b.node('Greater Or Equal To 0?', x=found['index of element'])
project_error = error_unless(b, is_open['x >= 0?'], PROJECT_NOT_OPEN, projects['error out'])
project = b.node('Index Array', array=value(projects), index=found['index of element'])

# 2. That project's My Computer application instance (COM Project.Application).
context = member(b, 'property', 'Project', 'App Ref', project['element'], project_error)
context_name = member(b, 'property', 'Application', 'App.ContextName', value(context), context['error out'])
indicator(b, value(context_name), 'Application:Context Name')
version = member(b, 'property', 'Application', 'App.Version', value(context), context_name['error out'])
indicator(b, value(version), 'Application:Version Number')
my_computer = b.node('Equal?', x=value(context_name), y=string_constant(b, 'My Computer'))
context_error = error_unless(b, my_computer['x = y?'], WRONG_CONTEXT, version['error out'])

# 3. A blank VI path skips every VI step: a project and context check only.
blank = b.node('Empty String/Path?', **{'string/path': vi_path})
wanted = b.node('Not', x=blank['empty?']).out
vi_error = error_unless(b, wanted, SKIPPED, context_error)

# 4. The VI in that context: no load dialogs, no run reservation (0x20), exact path, metadata.
opened = b.node('Open VI Reference', **{'application reference (local)': value(context),
                                       'vi path': b.node('String To Path', string=vi_path)['path'],
                                       'options': b.const(0x20, 'U32'), 'error in (no error)': vi_error})
vi = opened['vi reference']
MODS = (('Mods.VI', 'VI Modifications Bitset'), ('Mods.Front Panel', 'Front Panel Mods Bitset'),
        ('Mods.Block Diagram', 'Block Diagram Mods Bitset'))


def read_mods(handle, error, prefix):
    """The three NI modification bitsets on their own error chain: a global VI has no block diagram (1035),
    and that must not fail the request. Ordered by the reference wire."""
    for prop, label in MODS:
        read = member(b, 'property', 'VI', prop, handle, error)
        indicator(b, value(read), f'{prefix}:{label}')
        handle, error = read['reference out'], read['error out']
    indicator(b, clear_skipped(b, error), f'{prefix} Error')
    return handle


loaded = member(b, 'property', 'VI', 'Path', read_mods(vi, opened['error out'], 'Modifications'), opened['error out'])
indicator(b, value(loaded), 'VI Path')
same = b.node('Equal?', x=path_to_string(b, value(loaded)), y=vi_path)
chain = error_unless(b, same['x = y?'], WRONG_VI, loaded['error out'])
vi_type = member(b, 'property', 'VI', 'VIType', vi, chain)
indicator(b, value(vi_type), 'VI Type')
chain = vi_type['error out']
for prop, label in (('Name', 'VI Name'), ('Description', 'VI Description'), ('Exec.State', 'Execution:State')):
    read = member(b, 'property', 'VI', prop, vi, chain)
    indicator(b, value(read), label)
    chain = read['error out']

# 5. The connector (not for globals or default reads), or one control's saved default.
is_global = b.node('Equal?', x=value(vi_type), y=b.const(GLOBAL_VI))
skip_connector = b.node('Or', x=read_default, y=is_global['x = y?'])
connector = member(b, 'method', 'VI', 'Export Interface', vi,
                   error_unless(b, b.node('Not', x=skip_connector['x .or. y?']).out, SKIPPED, chain))
for name in ('Num Connections', 'Captions', 'Wire Requirements', 'I/O Status', 'Data Types', 'ConNum', 'Extended Information'):
    indicator(b, terminal(connector, name, True), name)
default = member(b, 'method', 'VI', 'Ctrl Val.Get Default', terminal(connector, 'reference out', True),
                 error_unless(b, read_default, SKIPPED, chain), Control__Name=control_name)
indicator(b, terminal(default, 'Ctrl Val.Get Default', True), 'Control Value:Get Default')
result = merge(b, clear_skipped(b, connector['error out']), clear_skipped(b, default['error out']))

# Modifications after the read, read even when the read failed (not for a blank vi path).
after = error_unless(b, wanted, SKIPPED)
handle = read_mods(terminal(default, 'reference out', True), after, 'Modifications After')
closed = b.node('Close Reference', reference=handle, **{'error in (no error)': after})
indicator(b, merge(b, result, clear_skipped(b, closed['error out'])), 'error out')
b.describe('Bordeaux: reads one VI\'s connector, or one control\'s saved default, in the My Computer context of '
           'an already-open project, for the macOS LabVIEW 2026 command catalog. Never runs, edits or saves the '
           'VI. Errors: 5101 project not open, 5102 not the My Computer context, 5103 LabVIEW loaded the VI '
           'from another path. A blank vi path checks only the project and context.')
ok, errors = b.finish()
print(json.dumps({'helper': str(output), 'executable': ok, 'errors': errors}, default=str))
if not ok:
    raise RuntimeError('The generated helper is broken; inspect its reported errors.')
