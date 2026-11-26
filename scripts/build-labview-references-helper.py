"""Author Bordeaux's command wrapper references helper and its empty managed-VI template.

Developer-only, like build-labview-wrapper-helper.py: --native-tools points to the directory containing
lvscript.py/lvbuild.py. The shipped desktop runs the saved helper through NI COM; it needs no Python.
Build and verify with LabVIEW 2025 25.3.3f3.

UpdateCommandWrapperReferences.vi edits the managed VI in the robot target's application context, where
Autonomous.vi loads it, so an open project sees the new references without reopening. It:
  1. finds the named project target and opens the managed VI in that target's context,
  2. refuses (error 5001) a VI whose description lacks the Bordeaux marker and (error 5002) one with unsaved edits,
  3. deletes the VI's existing Static VI Reference nodes and adds one per wrapper path,
  4. writes the description (which records the wrapper list hash) and saves the VI in place,
  5. counts the saved Static VI References, and reverts the in-memory VI if any edit step failed.
Error 5003: the target name is not in the project. It never runs a wrapper or the managed VI.
"""
import argparse
import json
import os
import sys
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--native-tools', type=Path, required=True)
parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'resources/labview-inspection')
parser.add_argument('--labview', type=Path, default=Path(r'C:\Program Files (x86)\National Instruments\LabVIEW 2025'))
args = parser.parse_args()
os.environ.setdefault('LABVIEW_WORKER_NAMESPACE', 'bordeaux-wrapper-authoring')
sys.path.insert(0, str(args.native_tools.resolve()))
from lvscript import Session
from lvbuild import VIBuilder, Node

MARKER = 'bordeaux-command-wrappers/1'
TEMPLATE_DESCRIPTION = ('Managed by Bordeaux. Holds a static VI reference to every command wrapper so that running '
                        'from the LabVIEW project loads and deploys them. Place this VI once on the Autonomous.vi '
                        'block diagram. Bordeaux rewrites it when wrappers change; do not edit it.\n\n'
                        f'{MARKER} sha256:none')
s = Session()
output = args.output.resolve()
helper_path, template_path = output / 'UpdateCommandWrapperReferences.vi', output / 'CommandWrapperReferences.vi'
for existing in (helper_path, template_path):
    if existing.exists():
        raise RuntimeError(f'{existing} exists; choose a fresh output directory. Existing helper artifacts are preserved.')
VILIB = args.labview / 'vi.lib' / 'Utility'
ERROR_FROM_CODE = VILIB / 'error.llb' / 'Error Cluster From Error Code.vi'
TRAVERSE = VILIB / 'traverseref.llb' / 'Traverse for GObjects.vi'


def terminal(node, name, source):
    """A member node lists an input and output with the same name; pick by direction."""
    matches = [ref for label, ref, is_source in node.terminals if label == name and bool(is_source) == source]
    if len(matches) != 1:
        raise KeyError(f'{name!r} ({"output" if source else "input"}) not unique in {[t[0] for t in node.terminals]}')
    return matches[0]


def member(builder, kind, cls, name, reference=None, error=None, write=False, **inputs):
    where = builder._xy()
    before = set(s.prop_get('Diagram', 'Nodes[]', builder.diagram))
    s._member_node(builder.diagram, kind, cls, name, write, where, builder.path)
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


def string_constant(builder, value):
    ref = s.new_object(builder.diagram, 'String Constant', builder._xy())
    s.prop_set('Constant', 'Value', ref, value)
    return s.prop_get('Constant', 'Terminal', ref)


def string_control(builder, label, y, indicator=False):
    ref = s.new_object(builder.panel, 'String Indicator (modern)' if indicator else 'String Control (modern)', (400 if indicator else 20, y))
    s.prop_set('Text', 'Text', s.prop_get('Control', 'Label', ref), label)
    return s.prop_get('Control', 'Terminal', ref)


def string_array_control(builder, label, y):
    array = s.new_object(builder.panel, 'Array (modern)', (20, y))
    s.new_object(array, 'String Control (modern)')
    s.prop_set('Text', 'Text', s.prop_get('Control', 'Label', array), label)
    return s.prop_get('Control', 'Terminal', array)


def indicator_from(builder, source, label):
    made = s.method('Terminal', 'Create Indicator', source)
    ref = next(value for value in made.values() if isinstance(value, int) and value)
    control = s.prop_get('ControlTerminal', 'Control', ref) if s.prop_get('GObject', 'Class Name', ref).endswith('Terminal') else ref
    s.prop_set('Text', 'Text', s.prop_get('Control', 'Label', control), label)
    term = s.prop_get('Control', 'Terminal', control)
    builder.wire(source, term)


def class_constant(builder, name):
    spec = s.new_object(builder.diagram, 'Class Specifier Constant', builder._xy())
    types = s.prop_get('ClassSpecifierConstant', 'AllTypes[]', spec)
    s.method('ClassSpecifierConstant', 'SetType', spec, **{'ID String': next(row[0] for row in types if row[2] == name)})
    return s.prop_get('Constant', 'Terminal', spec)


def error_unless(builder, condition, code, error):
    """Error `code` when `condition` is false; otherwise passes `error` through."""
    selected = builder.node('Select', s=condition, t=builder.const(0), f=builder.const(code))
    raised = builder.subvi(ERROR_FROM_CODE, **{'error code (0)': selected['s? t:f'], 'error in (no error)': error})
    return raised['error out']


def traverse(builder, vi, error):
    """Static VI References on the block diagram of `vi`."""
    node = builder.subvi(TRAVERSE, **{'VI Refnum': vi, 'Class Name': string_constant(builder, 'StaticVIReference'), 'error in (no error)': error})
    made = s.method('Terminal', 'Create Constant', node['Traverse Target'])
    ring = next(value for value in made.values() if isinstance(value, int) and value)
    choices = list(s.prop_get('Enum', 'Strings[]', ring))
    s.prop_set('Constant', 'Value', ring, choices.index('BD'))  # ['FP', 'BD', 'Other'] in LabVIEW 2025
    builder.wire(s.prop_get('Constant', 'Terminal', ring), node['Traverse Target'])
    return node


def merge_iterations(builder, loop_errors, prior):
    merged = builder.node('Merge Errors', **{'error in[0]': prior})
    builder.wire(loop_errors, merged['error in[1]'])
    return merged['error out']


# ---- helper ------------------------------------------------------------------------------------------------------
b = VIBuilder(s, helper_path)
project_path = string_control(b, 'project path', 20)
target_name = string_control(b, 'target name', 90)
references_path = string_control(b, 'references path', 160)
description = string_control(b, 'description', 230)
marker = string_control(b, 'marker', 300)
wrapper_paths = string_array_control(b, 'wrapper paths', 370)

project = member(b, 'method', 'Application', 'Project.Open', **{'Path': b.node('String To Path', string=project_path)['path']})
targets = member(b, 'property', 'Project', 'Targets', terminal(project, 'Project:Open', True), project['error out'])
target_count = b.node('Array Size', array=targets['Targets'])
names_loop = b.for_loop(target_count['size(s)'], location=(900, 40), size=(500, 300))
target_item = names_loop.body.node('Index Array', array=names_loop.outer(targets['Targets']), index=names_loop.i)
target_label = member(names_loop.body, 'property', 'ProjectItem', 'Name', target_item['element'])
found = b.node('Search 1D Array', element=target_name)
b.wire(names_loop.indexed(target_label['Name']), found['1D array'])
target = b.node('Index Array', array=targets['Targets'], index=found['index of element'])
has_target = b.node('Greater Or Equal To 0?', x=found['index of element'])
target_error = error_unless(b, has_target['x >= 0?'], 5003, targets['error out'])
context = member(b, 'property', 'TargetItem', 'Application', target['element'], target_error)
context_name = member(b, 'property', 'Application', 'App.ContextName', context['Context'], context['error out'])
indicator_from(b, context_name['App.ContextName'], 'context name')
opened = b.node('Open VI Reference', **{'application reference (local)': context['Context'],
                                       'vi path': b.node('String To Path', string=references_path)['path'],
                                       'error in (no error)': context_name['error out']})
vi = opened['vi reference']
previous = member(b, 'property', 'VI', 'Description', vi, opened['error out'])
indicator_from(b, previous['Description'], 'previous description')
marked = b.node('Search/Split String', string=previous['Description'], **{'search string/char (-)': marker})
has_marker = b.node('Greater Or Equal To 0?', x=marked['offset of match'])
changes = member(b, 'property', 'VI', 'Mods.UserChanges', vi, previous['error out'])
unchanged = b.node('Not', x=changes['Mods.User Changes']).out
owned = error_unless(b, has_marker['x >= 0?'], 5001, changes['error out'])
editable = error_unless(b, unchanged, 5002, owned)

diagram = member(b, 'property', 'VI', 'Block Diagram', vi, editable)
old = traverse(b, vi, diagram['error out'])
old_count = b.node('Array Size', array=old['References'])
delete_loop = b.for_loop(old_count['size(s)'], location=(900, 400), size=(500, 300))
old_item = delete_loop.body.node('Index Array', array=delete_loop.outer(old['References']), index=delete_loop.i)
deleted = member(delete_loop.body, 'method', 'Generic', 'Delete', old_item['element'], delete_loop.outer(old['error out']))
after_delete = merge_iterations(b, delete_loop.indexed(deleted['error out']), old['error out'])

wrapper_count = b.node('Array Size', array=wrapper_paths)
add_loop = b.for_loop(wrapper_count['size(s)'], location=(900, 760), size=(900, 400))
body = add_loop.body
wrapper = body.node('Index Array', array=add_loop.outer(wrapper_paths), index=add_loop.i)
created = body.node('New VI Object', **{'vi object class': add_loop.outer(class_constant(b, 'StaticVIReference')),
                                        'owner refnum': add_loop.outer(diagram['Diagram']),
                                        'error in (no error)': add_loop.outer(after_delete)})
body.wire(add_loop.outer(b.const(2084, 'U32')), created['style'])  # 2084: Static VI Reference ('style' is node()'s own argument)
placed = s.method('Terminal', 'Create Constant', created['position/next to'])
position = next(value for value in placed.values() if isinstance(value, int) and value)
body.wire(s.prop_get('Constant', 'Terminal', position), created['position/next to'])
pointed = member(body, 'property', 'StaticVIReference', 'Path', created['object refnum'], created['error out'], write=True,
                 Path=body.node('String To Path', string=wrapper['element'])['path'])
released = body.node('Close Reference', reference=pointed['reference out'], **{'error in (no error)': pointed['error out']})
after_add = merge_iterations(b, add_loop.indexed(released['error out']), after_delete)

tidied = member(b, 'method', 'Diagram', 'Clean Up Diagram', diagram['Diagram'], after_add)
described = member(b, 'property', 'VI', 'Description', vi, tidied['error out'], write=True, Description=description)
saved = member(b, 'method', 'VI', 'Save Instrument', vi, described['error out'])
counted = traverse(b, vi, saved['error out'])
indicator_from(b, counted['# of Refs'], 'reference count')

# An edit that failed after the ownership checks leaves the loaded VI changed in memory; revert it to the saved file.
status = b.node('Unbundle By Name')
b.wire(counted['error out'], status.terminals[[source for _, _, source in status.terminals].index(False)][1])
case = b.case(status.out, ['False', 'True'], location=(1900, 400), size=(500, 300))
reverted = member(case.frame('True'), 'method', 'VI', 'Revert VI', case.outer(vi), case.outer(editable))
handle = case.output_named({'True': reverted['reference out'], 'False': case.outer(vi)})
closed = b.node('Close Reference', reference=handle, **{'error in (no error)': counted['error out']})
indicator_from(b, closed['error out'], 'error out')
b.describe('Bordeaux: rewrites the managed command wrapper references VI in the robot target context. '
           'Deletes its Static VI References, adds one per wrapper path, records the description and saves. '
           'Refuses an unmarked VI (5001), unsaved edits (5002) and an unknown target (5003). Never runs a wrapper.')
ok, errors = b.finish()

# ---- empty managed-VI template ------------------------------------------------------------------------------------
t = VIBuilder(s, template_path)
t.describe(TEMPLATE_DESCRIPTION)
template_ok, template_errors = t.finish()
print(json.dumps({'helper': str(helper_path), 'executable': ok, 'errors': errors,
                  'template': str(template_path), 'templateExecutable': template_ok, 'templateErrors': template_errors}, default=str))
if not ok or not template_ok:
    raise RuntimeError('A generated helper is broken; inspect its reported errors.')
