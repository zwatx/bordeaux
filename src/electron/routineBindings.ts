import type { XElement } from 'builder-util-runtime/out/xml';
import type { BinaryBindings } from '../core/export/robotBinary';
import { encodeBdxArgument } from '../core/export/robotBinary';
import type { RoutineRuntimeBindings, RuntimeScalar, RuntimeOutput } from '../core/export/routineRuntime';
import type { RobotValueSchema } from '../core/types';
import { parseLabviewXml } from './labviewProjectDiscovery';
import { statusCluster, typedefs } from './labviewNiTypes';

const basename = (value: string) => value.split(/[\\/]/).at(-1) ?? '';
const tags: Record<string, number> = { Boolean: 1, I8: 2, U8: 3, I16: 4, U16: 5, I32: 6, U32: 7, I64: 8, U64: 9, SGL: 10, DBL: 11, String: 12, EB: 13, EW: 14, EL: 15 };
const metadata = new Set(['Name', 'Val', 'NumElts', 'Dimsize', 'Choice']);
function checkSchema(xml: XElement, schema: RobotValueSchema): void {
  const kind = xml.name === 'Boolean' ? 'boolean' : xml.name === 'String' ? 'string' : ['EB', 'EW', 'EL'].includes(xml.name) ? 'enum'
    : ['I64', 'U64', 'U32'].includes(xml.name) ? 'integerString' : ['SGL', 'DBL'].includes(xml.name) ? 'number' : 'integer';
  if (!tags[xml.name] || schema.kind !== kind || (kind === 'enum'
    ? JSON.stringify(schema.enumValues) !== JSON.stringify(xml.getElements('Choice').map(item => item.value))
    : schema.valueType !== xml.name)) throw new Error('Command scalar schema disagrees with saved NI connector type');
}

/** Resolve portable runtime names and terminal types without asserting runtime availability. */
export function routineBindingsFromBinary(binary: BinaryBindings, selectedCommands?: ReadonlySet<string>): RoutineRuntimeBindings {
  const commands: RoutineRuntimeBindings['commands'] = Object.create(null);
  for (const command of binary.catalog.commands) {
    if (selectedCommands && !selectedCommands.has(command.id)) continue;
    if (binary.catalog.commands.filter(item => item.id === command.id).length !== 1) throw new Error(`${command.label}: command ID is ambiguous in saved NI metadata`);
    const raw = command.labviewConnector;
    if (!raw || !command.labviewLegacy) continue;
    const vi = basename(raw.file);
    if (!/^.+\.vi$/i.test(vi) || Buffer.byteLength(vi) > 256 || binary.catalog.commands.filter(item => basename(item.labviewConnector?.file ?? '').toLowerCase() === vi.toLowerCase()).length !== 1) continue;
    const lengths = [raw.terminalNumbers, raw.directions, raw.requirements, raw.captions, raw.typeXml, raw.extendedInfo].map(item => item.length);
    if (lengths.some(length => length !== lengths[0]) || lengths[0] > 64 || new Set(raw.terminalNumbers).size !== lengths[0]) throw new Error(`${command.label}: malformed saved NI connector evidence`);
    const terminals = raw.typeXml.map((value, index) => {
      const xml = parseLabviewXml(value), name = xml.elementValueOrEmpty('Name');
      if (!name.trim() || name.includes('\0') || Buffer.byteLength(name) > 256 || ![0, 1].includes(raw.directions[index]) || !Number.isInteger(raw.terminalNumbers[index]) || raw.terminalNumbers[index] < 0 || raw.terminalNumbers[index] > 255) throw new Error(`${command.label}: invalid terminal identity`);
      return { xml, name, terminal: raw.terminalNumbers[index], direction: raw.directions[index], typedef: typedefs(raw.extendedInfo[index], name).root };
    });
    if (new Set(terminals.map(item => item.name)).size !== terminals.length) throw new Error(`${command.label}: NI controls require unique names for dynamic invocation`);
    const statuses = terminals.filter(item => basename(item.typedef ?? '') === 'Command Status Info.ctl');
    if (statuses.length !== 2 || !statuses.every(item => statusCluster(item.xml))) throw new Error(`${command.label}: invalid inspected command lifecycle`);
    const inputStatus = statuses.find(item => item.direction === 0), outputStatus = statuses.find(item => item.direction === 1);
    if (!inputStatus || !outputStatus) throw new Error(`${command.label}: missing command status input/output`);
    const scalar = (xml: XElement, name: string, terminal: number): RuntimeScalar => {
      const tag = tags[xml.name], choices = ['EB', 'EW', 'EL'].includes(xml.name) ? xml.getElements('Choice').map(item => item.value) : [];
      if (!tag || choices.length > 1024 || new Set(choices).size !== choices.length || (tag >= 13 && !choices.length)) throw new Error(`${command.label}.${name}: unsupported scalar NI type`);
      return { name, terminal, niType: xml.name, tag, choices };
    };
    const inputs = terminals.filter(item => item.direction === 0 && !statuses.includes(item)).map(item => {
      const parameters = command.parameters.filter(parameter => parameter.role === 'argument' && parameter.name === item.name);
      if (parameters.length !== 1) throw new Error(`${command.label}.${item.name}: ambiguous NI input`);
      checkSchema(item.xml, parameters[0].schema);
      if (Object.hasOwn(parameters[0], 'defaultValue')) {
        const choices = item.xml.getElements('Choice').map(choice => choice.value);
        let saved = raw.defaults[item.name];
        if (['EB', 'EW', 'EL'].includes(item.xml.name) && typeof saved === 'number') saved = choices[saved];
        if (['I64', 'U64', 'U32'].includes(item.xml.name) && typeof saved === 'number' && Number.isSafeInteger(saved)) saved = String(saved);
        if (!Object.hasOwn(raw.defaults, item.name) || saved !== parameters[0].defaultValue) throw new Error(`${command.label}.${item.name}: saved default evidence changed; inspect commands again`);
        encodeBdxArgument({ niType: item.xml.name, choices }, parameters[0].defaultValue);
      }
      return scalar(item.xml, item.name, item.terminal);
    });
    if (command.parameters.some(item => item.role !== 'argument') || inputs.length !== command.parameters.length || new Set(inputs.map(item => item.name)).size !== inputs.length) throw new Error(`${command.label}: unsupported or ambiguous command inputs`);
    const outputs: RuntimeOutput[] = (command.outputs ?? []).map(output => {
      const matches = terminals.filter(item => item.direction === 1 && item.terminal === output.terminalNumber);
      if (matches.length !== 1) throw new Error(`${command.label}.${output.name}: missing output terminal evidence`);
      const terminal = matches[0], fieldPath = output.fieldPath ?? [terminal.name];
      if (fieldPath.length < 1 || fieldPath.length > 16 || fieldPath[0] !== terminal.name) throw new Error(`${command.label}.${output.name}: invalid output field path`);
      let xml = terminal.xml;
      for (const name of fieldPath.slice(1)) {
        const children = (xml.elements ?? []).filter(item => !metadata.has(item.name) && item.elementValueOrEmpty('Name') === name);
        if (xml.name !== 'Cluster' || children.length !== 1) throw new Error(`${command.label}.${output.name}: ambiguous output field path`);
        xml = children[0];
      }
      checkSchema(xml, output.schema);
      return { ...scalar(xml, output.name, terminal.terminal), fieldPath };
    });
    if (new Set(outputs.map(item => item.name)).size !== outputs.length || outputs.length > 64) throw new Error(`${command.label}: ambiguous outputs`);
    commands[command.id] = { vi, statusInput: inputStatus.terminal, statusOutput: outputStatus.terminal,
      statusInputName: inputStatus.name, statusOutputName: outputStatus.name, inputs, outputs };
  }
  return { binary, commands, definitionJson: JSON.stringify({ binary: binary.definitionJson, commands }) };
}

/** Includes saved output/lifecycle evidence, which the standalone BDX input hash intentionally omits. */
export function routineEvidenceSnapshot(binary: BinaryBindings): string {
  return JSON.stringify(binary.catalog.commands.map(command => ({ id: command.id, parameters: command.parameters, outputs: command.outputs, connector: command.labviewConnector })));
}
