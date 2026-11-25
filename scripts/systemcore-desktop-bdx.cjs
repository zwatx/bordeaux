// Prints the BDX the desktop app builds for a recorded project and command list: name, SHA-256 and bytes, as JSON.
// Run under Electron's Node (ELECTRON_RUN_AS_NODE=1), the engine the desktop app builds BDX files with; JavaScript
// engines differ in the last digits of some float math, so a plain Node build is not the desktop's answer.
//   ELECTRON_RUN_AS_NODE=1 electron scripts/systemcore-desktop-bdx.cjs <fixture.json>   (after npm run build:electron)
const fs = require('node:fs');
const path = require('node:path');
const { buildRobotBinary } = require(path.resolve(__dirname, '../dist-electron/core/export/robotBinary'));
const { decodeProjectValue } = require(path.resolve(__dirname, '../dist-electron/core/project/fileFormat'));
const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const built = buildRobotBinary(decodeProjectValue(fixture.project).project, { kind: 'path', id: fixture.pathId }, fixture.bindings);
process.stdout.write(JSON.stringify({ fileName: built.fileName, sha256: built.sha256, base64: Buffer.from(built.bytes).toString('base64'), eventCount: built.eventCount, engine: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}` }));
