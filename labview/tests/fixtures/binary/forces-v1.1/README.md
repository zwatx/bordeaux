# BDX 1.1 force fixtures

These files are synthetic application byte fixtures, not evidence of LabVIEW or robot execution. The original 1.0 fixtures remain in `../blue-origin/`.

The header is major 1, minor 1. Each sample is fifteen big-endian DBLs (120 bytes):

`t, s, f, x, y, headingRad, travelHeadingRad, velocityMps, accelerationMps2, angularVelocityRadps, curvatureInvM, forceLFN, forceLBN, forceRFN, forceRBN`.

Forces are signed newtons in LF/LB/RF/RB order. The `.expected.json` files are decoded evidence in this column order; the manifest records file lengths and SHA256. The fixture drivetrain in `tests/fixtures/forceExportRobot.ts` is synthetic and must not configure a robot. `TEST-ONLY.command-types.json` supplies synthetic NI type evidence only.

Regenerate deliberately with `BORDEAUX_UPDATE_BDX_FIXTURES=1 npx vitest run tests/robotBinary.test.ts` (set the environment variable using the local shell). Ordinary tests compare the frozen bytes, CRC and decoded evidence. See `docs/labview/binary-format.md` for version checks, manual typedef fields, sign handling and migration requirements.
