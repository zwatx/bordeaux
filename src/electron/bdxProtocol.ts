import type { BordeauxProject } from "../core/types";
import type { BinaryBindings, BinarySelection } from "../core/export/robotBinary";
export interface BdxJob { project: BordeauxProject; selection: BinarySelection; bindings: BinaryBindings }
export interface BdxBatchJob { project: BordeauxProject; selections: BinarySelection[]; bindings: BinaryBindings }
