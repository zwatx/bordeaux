import { describe, expect, it } from "vitest";
import { binaryFileName } from "../src/core/export/robotBinary";
import { projectFileName } from "../src/electron/projectFiles";
import { truncateUtf8 } from "../src/core/portableFileName";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const wellFormed = (text: string) => Buffer.from(text, "utf8").toString("utf8") === text;

describe("portable derived file names", () => {
  it("prefixes Windows device names in any case, with extensions or spaces before them", () => {
    for (const [name, file] of [
      ["CON", "_CON.bdx"], ["con", "_con.bdx"], ["Nul", "_Nul.bdx"], ["aux", "_aux.bdx"], ["PRN", "_PRN.bdx"],
      ["COM1", "_COM1.bdx"], ["com0", "_com0.bdx"], ["LPT9", "_LPT9.bdx"], ["COM¹", "_COM1.bdx"],
      ["CON.foo", "_CON.foo.bdx"], ["nul.tar.gz", "_nul.tar.gz.bdx"], ["CON.", "_CON.bdx"], [".aux", "_aux.bdx"],
    ]) expect(binaryFileName(name)).toBe(file);
    for (const [name, file] of [
      ["CON", "_CON.bordeaux"], ["con.bordeaux", "_con.bordeaux"], ["Aux.bordeaux.json", "_Aux.bordeaux"],
      ["lpt1.backup", "_lpt1.backup.bordeaux"], ["NUL .old", "_NUL .old.bordeaux"], ["COM²", "_COM².bordeaux"], ["CONOUT$", "_CONOUT$.bordeaux"],
    ]) expect(projectFileName(name)).toBe(file);
  });

  it("keeps ordinary names, including ones containing device names", () => {
    for (const name of ["Console", "Icon", "Second-Auxiliary", "COM10", "LPT", "NULL", "conduit.v2", "Auto_CON", "Opening"]) {
      expect(binaryFileName(name)).toBe(`${name}.bdx`);
      expect(projectFileName(name)).toBe(`${name}.bordeaux`);
    }
    expect(binaryFileName("Path with spaces")).toBe("Path-with-spaces.bdx");
    expect(binaryFileName("x".repeat(200))).toBe(`${"x".repeat(80)}.bdx`);
    expect(projectFileName("x".repeat(200))).toBe(`${"x".repeat(120)}.bordeaux`);
    expect(projectFileName("Robot.bordeaux.json")).toBe("Robot.bordeaux");
  });

  it("keeps a device-name prefix within each format's length cap", () => {
    const binary = binaryFileName(`CON.${"x".repeat(200)}`);
    expect(binary).toBe(`_CON.${"x".repeat(75)}.bdx`);
    expect(binary.length).toBe(84);
    const project = projectFileName(`CON.${"路".repeat(200)}`);
    expect(project.startsWith("_CON.路")).toBe(true);
    expect(bytes(project)).toBeLessThanOrEqual(255);
  });

  it("bounds Unicode project names in UTF-8 bytes on code point boundaries", () => {
    // 120 CJK characters would be 369 bytes; 82 of them fill the 255-byte component.
    expect(projectFileName("路".repeat(120))).toBe(`${"路".repeat(82)}.bordeaux`);
    const emoji = projectFileName(`a${"🚀".repeat(100)}`);
    // The 120-unit character cap splits a surrogate pair; the whole emoji is dropped.
    expect(emoji).toBe(`a${"🚀".repeat(59)}.bordeaux`);
    expect(wellFormed(emoji)).toBe(true);
    for (const name of ["é".repeat(130), `${"ab"}${"😀".repeat(80)}`, "한국어".repeat(50)]) {
      const file = projectFileName(name);
      expect(bytes(file)).toBeLessThanOrEqual(255);
      expect(wellFormed(file)).toBe(true);
      expect(name.startsWith(file.slice(0, -".bordeaux".length))).toBe(true);
    }
  });

  it("truncates UTF-8 by whole code points", () => {
    expect(truncateUtf8("a路b", 3)).toBe("a");
    expect(truncateUtf8("a路b", 4)).toBe("a路");
    expect(truncateUtf8("😀😀", 7)).toBe("😀");
    expect(truncateUtf8("😀😀", 8)).toBe("😀😀");
    expect(truncateUtf8("é", 1)).toBe("");
  });
});
