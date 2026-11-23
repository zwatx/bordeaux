import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

function parseArguments(argumentsList) {
  if (argumentsList.length === 0) return { output: undefined };
  if (argumentsList.length === 2 && argumentsList[0] === "--output" && argumentsList[1] && !argumentsList[1].startsWith("-")) {
    return { output: argumentsList[1] };
  }
  throw new Error("Usage: certify-field [--output <path>]");
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  const { output } = parseArguments(process.argv.slice(2));
  const require = createRequire(import.meta.url);
  const { certifyField } = require("../dist-electron/core/field/certification.js");
  const report = certifyField();
  const contents = `${JSON.stringify(report, null, 2)}\n`;

  if (output) {
    const target = path.resolve(process.cwd(), output);
    fs.writeFileSync(target, contents, { encoding: "utf8", flag: "w" });
  }
  process.stdout.write(contents);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  emit({
    schemaVersion: "bordeaux-field-certification/1.0",
    passed: false,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
