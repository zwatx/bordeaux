# Bordeaux software and asset rights

## Apache-2.0 software

Unless a file states otherwise, the Bordeaux application source, build tooling,
source documentation, and LabVIEW integration source are licensed under the
[Apache License 2.0](LICENSE). Packaged copies carry `LICENSE` and `NOTICE`.

## Bordeaux identity

The Apache License does not grant trademark rights. The Bordeaux name and
product identity, the wine-glass mark, logos, icons, trade dress, and other
source-identifying elements remain outside the Apache-2.0 software grant. No
trademark license or permission to present a modified product as an official
Bordeaux release is granted. Apache-2.0 section 6 still permits reasonable and
customary use needed to describe the software's origin and reproduce `NOTICE`.

## Brand assets

Brand assets under `build/`, including the wine-glass artwork and application
icons, are not relicensed under Apache-2.0 merely because they are stored next
to the software. Their inclusion in an official Bordeaux binary does not grant
separate rights to use them on a fork, product, service, or campaign.

## Fonts

The bundled Space Grotesk and JetBrains Mono font files under
`src/renderer/assets/*.woff2` remain under the SIL Open Font License 1.1, not
Apache-2.0. Their copyright notices and full license are distributed in
[`licenses/OFL-1.1.txt`](licenses/OFL-1.1.txt). The files came from the official
Google Fonts releases for [Space Grotesk](https://github.com/google/fonts/tree/main/ofl/spacegrotesk)
and [JetBrains Mono](https://github.com/google/fonts/tree/main/ofl/jetbrainsmono).

The checked-in WOFF2 provenance digests are:

| Family | SHA-256 |
| --- | --- |
| JetBrains Mono `5212942a-e8a9-49c9-9687-e590adce5f6e.woff2` | `d44eb1936043a56038eb02dd70b243f379bef65783f94ec12f277550720411f1` |
| JetBrains Mono `70a5258e-5ffc-4ab8-9e26-eb5a1dc45e1d.woff2` | `9c38cb2d0d2d93c1ee6e21fa78db76f13ea7e15e15cc64214c7ca89b6aaa35c4` |
| JetBrains Mono `75942de6-7641-4396-9ec1-6f8aecca76d2.woff2` | `2c32b9b3ee358c119e210f6f5195f9bd34894d78a785ff2e95d60e718e400af4` |
| JetBrains Mono `9159e081-66f2-48ad-986a-f8a7ce5ae00c.woff2` | `4995a9a43ac659ec32fcd8b463755cd6a07b31a6e6b3894a6a153b661cf490e2` |
| JetBrains Mono `9720fba3-d472-4015-8174-9a76a96ee3a7.woff2` | `9343de2ca5d9549f792e7962375af8efb0f320c7643bfd36c884b5a30e5c396f` |
| JetBrains Mono `f43a65b8-4147-4e04-867c-3e12cc9ad7ef.woff2` | `49c3da6c9a2b279b0f1f860f5cfb1f5dc38d88a5c7be9c9b1837bbc4e3db6111` |
| Space Grotesk `98640faa-af85-4deb-8b67-c9c878328d73.woff2` | `a0d054c4af557de20afd6ca59f47ab353bcaec49c63ff04b6c9d39d0f8910557` |
| Space Grotesk `e5baa99d-fba3-44ea-85b3-2e3f8f2341dc.woff2` | `054c266fbb441ee059365dba0885d206f67ca05b375de869b88e02ebfccc9b9d` |
| Space Grotesk `ffa637e1-07fe-493d-8dd2-c2aa214e1fec.woff2` | `d699664b145bfeeccc66a4cce7fa55e14eb63efd7ec6b0b2ec52e25dd98f3917` |

## Video and third-party media

Video, competition-field imagery, photographs, audio, and other third-party
media are not covered by Apache-2.0. A media file may ship publicly only when
its provenance record identifies its source or creator, copyright owner,
applicable license or written permission, allowed distribution, and a checksum.
Absence of such a record grants no right to publish or reuse the file.

## Runtime dependencies

The desktop application uses `ssh2` 1.17.0 for its constrained SFTP client.
`ssh2` remains under Brian White's MIT License, reproduced in
[`licenses/ssh2-MIT.txt`](licenses/ssh2-MIT.txt). Its exact package and
transitive dependency versions and integrity digests remain recorded in
`package-lock.json`.

## Field data

`src/core/field/wpilib/2026-rebuilt-andymark.json` is the unmodified WPILib
AndyMark field layout for 2026 REBUILT, obtained from the allwpilib
`v2027.0.0-alpha-8` tag. Its SHA-256 is
`5225a3c49bf403e920a353ed46639691ae2f12e93af4309ff5e3c1044de3d8fb`.
It remains under the WPILib BSD 3-Clause License, reproduced in
[`licenses/WPILib-BSD-3-Clause.txt`](licenses/WPILib-BSD-3-Clause.txt).

## Provenance records

This file is the distribution-level rights index. Font provenance is recorded
above. Project-specific asset sets may carry a more detailed provenance record
beside their source; those records govern the assets they identify and must be
kept with any public distribution. Package dependency names, versions,
integrity digests, and declared licenses are recorded in `package-lock.json`;
each dependency remains under its own license.
## LabVIEW native dependencies

The LabVIEW native adapter source is application source under Apache-2.0.
`labview/vendor/nlohmann/json.hpp` is the unmodified nlohmann/json 3.12.0
single header, obtained from the upstream `v3.12.0` tag. Its SHA-256 is
`aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63`.
The MIT license is preserved in `labview/vendor/nlohmann/LICENSE.MIT`
(SHA-256 `46a65cffd1ea955132d95a8dd921640714a8d6b537d2e4e482d31145ae95b603`).
It provides strict JSON parsing on the JVM-free runtime and avoids maintaining
a second bespoke JSON parser on the robot.

Windows native libraries statically link the MinGW/GCC runtime support used by
the documented compiler. `labview/vendor/mingw-w64-copyright.txt`,
`labview/vendor/GPL-3.txt`, and `labview/vendor/GCC-RUNTIME-EXCEPTION.txt` preserve
the applicable notices and runtime exception. The build copies these notices
into every native bundle. NI software and NI-generated wrapper VIs are not
included in the current bundle; valid VI generation and NI execution remain
explicit verification gates.
