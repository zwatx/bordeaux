"""Author Bordeaux's self-contained VI Scripting helper using a local native authoring toolkit.

Developer-only: --native-tools points to the directory containing lvscript.py/lvbuild.py.
The shipped desktop invokes the saved VI through NI COM; it needs no Python or MCP server.
Never runs the command VI. Build and verify with LabVIEW 2025 25.3.3f3.
"""
import argparse
import json
import os
import sys
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--native-tools', type=Path, required=True)
parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'resources/labview-inspection/CreateCommandWrapper.vi')
args = parser.parse_args()
os.environ.setdefault('LABVIEW_WORKER_NAMESPACE', 'bordeaux-wrapper-authoring')
sys.path.insert(0, str(args.native_tools.resolve()))
from lvscript import Session
from lvbuild import VIBuilder, Node

s = Session()
output = args.output.resolve()
output.parent.mkdir(parents=True, exist_ok=True)
if output.exists():
    raise RuntimeError('Choose a fresh output path; existing helper artifacts are preserved.')
b = VIBuilder(s, output)


def member(builder, kind, cls, name, reference=None, error=None, write=False):
    where = builder._xy()
    before = set(s.prop_get('Diagram', 'Nodes[]', builder.diagram))
    s._member_node(builder.diagram, kind, cls, name, write, where, builder.path)
    added = set(s.prop_get('Diagram', 'Nodes[]', builder.diagram)) - before
    node, = [ref for ref in added if s.prop_get('GObject', 'Class Name', ref) == ('Invoke' if kind == 'method' else 'Property')]
    result = Node(node, builder._terminals(node))
    if reference is not None:
        builder.wire(reference, result['reference'])
    if error is not None:
        builder.wire(error, result['error in (no error)'])
    return result


def port(builder, terminal, label, indicator):
    made = s.method('Terminal', 'Create Indicator' if indicator else 'Create Control', terminal)
    ref = next(value for value in made.values() if isinstance(value, int) and value)
    cls = s.prop_get('GObject', 'Class Name', ref)
    control = s.prop_get('ControlTerminal', 'Control', ref) if cls.endswith('Terminal') else ref
    s.prop_set('Text', 'Text', s.prop_get('Control', 'Label', control), label)
    term = s.prop_get('Control', 'Terminal', control)
    builder.wire(terminal, term) if indicator else builder.wire(term, terminal)
    return term


def string_control(label, y):
    ref = s.new_object(b.panel, 'String Control (modern)', (20, y))
    s.prop_set('Text', 'Text', s.prop_get('Control', 'Label', ref), label)
    return s.prop_get('Control', 'Terminal', ref)


source = string_control('command path', 20)
destination = string_control('wrapper path', 100)
terminal_numbers = b.control('terminal numbers', 'dbl[]')
source_path = b.node('String To Path', string=source)
destination_path = b.node('String To Path', string=destination)
fresh = b.node('New VI')
b.wire(b.const(1), fresh['vi type (standard vi)'])
reentrant = member(b, 'property', 'VI', 'Exec.IsReentrant', fresh['vi refnum'], fresh['error out'], True)
b.wire(b.const(True), reentrant['Exec.IsReentrant'])
diagram = member(b, 'property', 'VI', 'Diagram', fresh['vi refnum'], reentrant['error out'])
subvi = b.node('New VI Object')
spec = s.new_object(b.diagram, 'Class Specifier Constant', b._xy())
types = s.prop_get('ClassSpecifierConstant', 'AllTypes[]', spec)
s.method('ClassSpecifierConstant', 'SetType', spec, **{'ID String': next(row[0] for row in types if row[2] == 'SubVI')})
b.wire(s.prop_get('Constant', 'Terminal', spec), subvi['vi object class'])
b.wire(b.const(2084, 'U32'), subvi['style'])
b.wire(diagram['Diagram'], subvi['owner refnum'])
b.wire(diagram['error out'], subvi['error in (no error)'])
b.wire(source_path['path'], subvi['path'])
made = s.method('Terminal', 'Create Constant', subvi['position/next to'])
position = next(value for value in made.values() if isinstance(value, int) and value)
b.wire(s.prop_get('Constant', 'Terminal', position), subvi['position/next to'])
terms = member(b, 'property', 'Node', 'Terminals[]', subvi['object refnum'], subvi['error out'])
count = b.node('Array Size', array=terminal_numbers)
loop = b.for_loop(count['size(s)'], location=(900, 100), size=(1250, 650))
loop_body = loop.body
number = loop_body.node('Index Array', array=loop.outer(terminal_numbers), index=loop.i)
index = loop_body.node('Index Array', array=loop.outer(terms['Terms[]']), index=number['element'])
indexed = index['element']
direction = member(loop_body, 'property', 'Terminal', 'IsSource', indexed)
case = loop_body.case(direction['IsSource'], ['False', 'True'], location=(1050, 200), size=(800, 450))
errors = []
for name, frame in zip(case.names, case.frames):
    terminal = case.outer(indexed)
    error = case.outer(direction['error out'])
    create = member(frame, 'method', 'Terminal', 'Create Indicator' if name.strip() == 'True' else 'Create Control', terminal, error)
    created = create['Create Indicator[1]'] if name.strip() == 'True' else create['Create Control[1]']
    control_term = member(frame, 'property', 'Control', 'Terminal', created, create['error out'])
    connect = member(frame, 'method', 'Terminal', 'Connect Wire', terminal, control_term['error out'])
    frame.wire(control_term['Terminal'], connect['Wire Source[0]'])
    errors.append(connect['error out'])
loop_error = case.output(errors)
iteration_error = loop_body.node('Select', s=loop_body.const(True), t=loop_error, f=loop_error)
saved = member(b, 'method', 'VI', 'Save Instrument', fresh['vi refnum'])
error_array = loop.indexed(iteration_error.out)
first_error = b.node('Index Array', array=error_array)
b.wire(first_error['element'], saved['error in (no error)'])
error_wire = s.prop_get('Terminal', 'Connected Wire', first_error['array'])
error_source = next(term for term in s.prop_get('Wire', 'Terminals[]', error_wire) if s.prop_get('Terminal', 'IsSource', term))
port(b, error_source, 'terminal errors', True)
b.wire(destination_path['path'], saved['Path to saved file[0]'])
close = b.node('Close Reference')
b.wire(fresh['vi refnum'], close['reference'])
b.wire(saved['error out'], close['error in (no error)'])
port(b, close['error out'], 'error out', True)
b.describe('Creates a reentrant command wrapper. Wires all subVI inputs/outputs to named controls/indicators. No connector assignments. Never executes the command.')
ok, errors = b.finish()
print(json.dumps({'path': str(output), 'executable': ok, 'errors': errors}, default=str))
if not ok:
    raise RuntimeError('Generated wrapper helper is broken; inspect its reported errors.')
