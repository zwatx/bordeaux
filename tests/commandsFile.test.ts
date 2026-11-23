import { describe, expect, it } from "vitest";
import fixture from "./fixtures/systemcoreCommandProject.json";
import { decodeCommandsFile, encodeCommandsFile } from "../src/core/export/commandsFile";
import type { BinaryBindings } from "../src/core/export/robotBinary";

const bindings = fixture.bindings as unknown as BinaryBindings;
/** Re-serializes a written command list after an edit, as a hand edit on the robot would leave it. */
const edited = (edit: (file: { bindings: Record<string, any> }) => void) => {
  const file = JSON.parse(encodeCommandsFile(bindings));
  edit(file);
  return JSON.stringify(file);
};

describe("command list file", () => {
  it("reads back exactly what the desktop wrote", () => {
    expect(decodeCommandsFile(encodeCommandsFile(bindings))).toEqual(bindings);
  });

  it.each([
    ["a catalog command", (file: { bindings: Record<string, any> }) => { file.bindings.catalog.commands[0].name = "Edited"; }],
    ["a parameter type", (file: { bindings: Record<string, any> }) => { file.bindings.parameterTypes["fixture.command"].power = { niType: "SGL" }; }],
    ["the NI definitions", (file: { bindings: Record<string, any> }) => { file.bindings.definitionJson = file.bindings.definitionJson.replace("DBL", "SGL"); }],
  ])("refuses a file whose %s changed after the desktop wrote it", (_label, edit) => {
    expect(() => decodeCommandsFile(edited(edit))).toThrow("was changed after the desktop wrote it");
  });

  it("refuses a file without its hash", () => {
    expect(() => decodeCommandsFile(edited((file) => { delete (file as Record<string, unknown>).sha256; }))).toThrow("was changed after the desktop wrote it");
  });
});
