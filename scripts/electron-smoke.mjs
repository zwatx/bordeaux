import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import electron from "electron";
import fs from "node:fs/promises";
import net from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);

/** Seed an actual managed source before launch; first-use production startup intentionally has no demo. */
async function seedSmokeProject(directory) {
  const { createDemoProject } = require("../dist-electron/shared/project/defaults.js");
  const { autosaveProjectFolder, projectWorkspacePath, readProject } = require("../dist-electron/electron/projectFiles.js");
  const { readRecentProjectFiles, writeRecentProjectFiles } = require("../dist-electron/electron/recentProjectFiles.js");
  const saved = await autosaveProjectFolder(directory, createDemoProject(), null, { createProject: true });
  const workspace = projectWorkspacePath(directory);
  const reopened = await readProject(workspace, { recordOpened: false });
  assert.deepEqual(reopened.project, saved, "Smoke seed must roundtrip through the real project codec");
  assert.ok(saved.paths.some(candidate => candidate.waypoints.length >= 2), "Smoke seed requires authored path geometry");
  const recents = path.join(directory, "recent-projects.json");
  await writeRecentProjectFiles(recents, [directory]);
  assert.deepEqual(await readRecentProjectFiles(recents), [directory], "Smoke startup must discover the actual seeded source");
  return workspace;
}

// The GUI smoke owns machine-wide desktop focus, even across separate clones.
const smokeLockPort = 24968;

async function acquireSmokeLock() {
  const deadline = Date.now() + 60000;
  while (true) {
    const server = net.createServer((socket) => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen({ host: "127.0.0.1", port: smokeLockPort, exclusive: true }, () => {
          server.off("error", onError);
          resolve();
        });
      });
      return server;
    } catch (error) {
      if (error?.code !== "EADDRINUSE" || Date.now() >= deadline) {
        throw new Error("Could not acquire the Bordeaux Electron smoke lock.", { cause: error });
      }
      await delay(100);
    }
  }
}

const smokeLock = await acquireSmokeLock();
let smokeDirectory;
try {
  smokeDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-electron-smoke-")));
  await seedSmokeProject(smokeDirectory);
  await fs.copyFile(new URL("./electron-smoke-renderer.js", import.meta.url), path.join(smokeDirectory, "renderer.js"));
  const robotRoot = path.join(smokeDirectory, "robot-project");
  await fs.mkdir(robotRoot, { recursive: true });
  await fs.writeFile(path.join(robotRoot, "SmokeRobot.lvproj"), "<Project/>");
  const declaration = {
    schemaVersion: "bordeaux-labview-catalog/1", catalogId: "SmokeRobot",
    commands: [{ id: "frc.robot.SmokeCommand", label: "Smoke Command", vi: "SmokeCommand.vi", parameters: [
      { name: "count", label: "Count", defaultValue: 2, min: 1, max: 9, schema: { kind: "integer" } },
      { name: "sequence", label: "Sequence", defaultValue: "9007199254740993", min: "0", max: "9223372036854775807", schema: { kind: "integerString" } },
      { name: "tags", label: "Tags", defaultValue: ["auto"], schema: { kind: "array", element: { kind: "string" } } },
    ] }, { id: "frc.robot.LargeEnumCommand", label: "Choose Autonomous Mode", vi: "LargeEnumCommand.vi", parameters: [
      { name: "mode", label: "Autonomous mode", defaultValue: "MODE_001", schema: { kind: "enum", enumValues: Array.from({ length: 160 }, (_, index) => `MODE_${String(index + 1).padStart(3, "0")}`) } },
    ] }],
    conditions: [{ id: "frc.robot.SmokeConditions#ready", label: "Ready", vi: "Ready.vi" }],
  };
  // Declarative file fixtures only; these bytes are never opened or executed by NI.
  for (const vi of ["SmokeCommand.vi", "LargeEnumCommand.vi", "Ready.vi"]) await fs.writeFile(path.join(robotRoot, vi), "SMOKE TEST ONLY");
  await fs.writeFile(path.join(robotRoot, "bordeaux-catalog.json"), JSON.stringify(declaration));

  const packagedExecutable = process.env.BORDEAUX_SMOKE_EXECUTABLE;
  const childEnvironment = { ...process.env, BORDEAUX_SMOKE_TEST: "1", BORDEAUX_SMOKE_DIRECTORY: smokeDirectory };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  const child = spawn(packagedExecutable || electron, packagedExecutable ? ["--enable-mcp-access"] : ["dist-electron/electron/main.js", "--enable-mcp-access"], {
    cwd: process.cwd(),
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
  child.stderr.on("data", (chunk) => { output += chunk; process.stderr.write(chunk); });

  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      // Result output can still be buffered when exit fires; close waits for both output streams.
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }

  assert.equal(timedOut, false, "Electron smoke exceeded its 30-second deadline");
  assert.equal(code, 0, `Electron smoke process exited with code ${code}`);
  const resultLine = output.split(/\r?\n/).find((line) => line.startsWith("BORDEAUX_SMOKE_RESULT "));
  assert.ok(resultLine, "Electron smoke process did not return results");
  const result = JSON.parse(resultLine.slice("BORDEAUX_SMOKE_RESULT ".length));
  const { robotHardLimits } = require("../dist-electron/shared/robotLimits.js");
  const presetLimits = robotHardLimits(result.motorPresetRobot);
  assert.ok(presetLimits?.electrical, "Preset autosave must use the electrical drive model");
  assert.ok(Math.abs(result.motorPresetRobot.maxSpeed - presetLimits.maxSpeedMps) <= 1e-9,
    "Preset autosave speed must match the shared electrical model");
  const presetModel = result.motorPresetRobot.driveModel;
  const unloadedSpeed = presetModel.motorFreeRpm / 60 * Math.PI * presetModel.wheelDiameterM / presetModel.gearRatio;
  assert.ok(result.motorPresetRobot.maxSpeed < unloadedSpeed,
    "Default voltage reserve and losses must reduce the unloaded preset speed");
  assert.deepEqual(result.unnamed, [], "All controls must have accessible names");
  assert.ok(result.main > 0, "Main landmark must exist");
  assert.ok(result.nav > 0, "Navigation landmark must exist");
  for (const check of [
    "api", "root", "startupAdopted", "validation", "motorPreset", "eventMarkerAutosave", "multiRoutineUi", "robotPushUi",
    "robotDiscovery", "robotBuilt", "robotRecent", "missingTypeEvidenceRejected", "eventlessBdxExported",
    "restored", "roundTrip", "editorRestored", "nodeGlobalsBlocked", "popupBlocked", "inlineScriptBlocked",
    "filesWritten", "invalidDraftBlockedClose", "closedWithExactSourceReceipt", "updaterIntegration", "updaterPopoverVisible", "unsavedDraftRetained", "folderBdxSaved", "sourceSavedOnBdxFailure",
  ]) assert.equal(result[check], true, check);
  for (const check of [
    "markerInspector", "linkAction", "commandEnabled", "commandSearch", "recentHiddenForSingleProject",
    "cancelSwitch", "parameter", "jsonShapeRejected", "jsonShapeAccepted", "longRangeRejected", "exactInteger",
    "largeEnumPicker", "accessible",
  ]) assert.equal(result.robotUi[check], true, `robotUi.${check}`);
  assert.equal(result.robotUi.commandOptions, declaration.commands.length + 1, "Declared LabVIEW commands plus No command option");
  const generatedPaths = await fs.readdir(path.join(smokeDirectory, "Paths"));
  assert.ok(generatedPaths.some(name => name.endsWith(".bdx")), "Save writes BDX into Paths");
  console.log("BORDEAUX_SMOKE_OK");
} finally {
  try {
    if (smokeDirectory) await fs.rm(smokeDirectory, { recursive: true, force: true });
  } finally {
    await new Promise((resolve, reject) => smokeLock.close((error) => error ? reject(error) : resolve()));
  }
}
