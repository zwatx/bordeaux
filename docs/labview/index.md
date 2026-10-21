# LabVIEW integration

Bordeaux authors paths and routines for LabVIEW robot code. Commands come from a linked `.lvproj` and saved NI connector inspection. The desktop contains no robot-language compiler and does not install a robot runtime.

## Path files

Export a selected path as a `.bdx` binary. The [binary format](binary-format.md) fixes byte order, metadata, trajectory samples, follow sections, command arguments and event scheduling fields. The writer has independent byte-layout tests and synthetic golden fixtures. Eventless paths require no command catalog; commanded paths require saved NI parameter type evidence. Event records resolve GUI IDs through those descriptors to original command VI basenames for the existing dynamic wrapper dispatcher (`bordeaux-dynamic-wrappers/1`). Old files containing hashed command IDs must be re-exported. Only markers with command invocations produce events; an eventless path runs no event commands.

BDX file names use only ASCII letters, digits, `.`, `_` and `-`, with at most 80 characters before `.bdx`. Windows device names get a leading `_` (`_CON.bdx`). If two exportable paths map to the same file name, the save fails instead of overwriting one with the other. An unrelated file that already has that name is preserved and reported.

This export profile supports time markers, optional time repeats, scalar arguments and saved defaults. Conditional/position markers, position-follow sections, automatic path-end cancellation, arrays and clusters are rejected explicitly. Wrappers remain reentrant VIs included by static reference for deployment and resolved dynamically by robot code; Bordeaux requires no catalog VI or filename mapping.

## Robot code

Robot integration uses ordinary `.vi` and `.ctl` files alongside team code. Readers decode files, math helpers calculate SI setpoints, and the scheduler returns typed command requests. Caller code supplies measured pose, time, enable/stop state and condition results, then handles motors and command execution. No installed native library is required.

The separate NI construction work is not runtime verification. Neither a catalog nor successful binary export proves the robot-side implementation has been run. Routine authoring remains available in the editor; AQU robot execution is deferred.

## Project links

Link robot code from the project menu or the path command panel. When the Bordeaux project has a folder, Bordeaux saves `editor.labviewProjectPath` relative to that folder, using `/` separators, and schedules the local project save immediately after linking. Recent selections are cached locally. Commit the project file with the `.lvproj` in the same repository layout so teammates inherit the link. Sibling folders (`../Robot/Robot.lvproj`) are supported. Opening a different checkout resolves against that checkout and does not rewrite a machine-specific bookmark into the project file.

The relative link takes precedence over old local bookmarks, even when its file is missing. A linked file that is not in this checkout shows **Robot code · Missing** without an error; a file that exists but cannot be loaded (invalid XML, a refused symlink, a catalog failure) shows the robot-code failure. Only a project with a saved link or an old bookmark is looked up: Missing links offer **Use filename.lvproj** only when exactly one file appears directly in the project folder and its first two ancestors; otherwise use **Link robot code…**. A project that never linked robot code is not scanned and gets no proposal. Lookup is bounded and never searches descendant trees. Read failures during lookup suppress the suggestion without an error. Symlinks, junctions, network paths and absolute or protocol links are rejected. Automatic restore and explicit Link read local project/catalog files and saved connector metadata; **Refresh commands** reuses validated session or saved metadata before inspecting NI; **Rescan command inputs** forces a new inspection, including unsaved LabVIEW edits.

Save copy rebases the link to the same intended file. A detached recovery has no trusted current folder, so its copy records `labviewProjectPath: null` and requires explicit relinking; it cannot accidentally attach to a different same-named file next to the new copy. The same missing state is used when rebasing cannot form a portable path across Windows drives. Null intentionally suppresses old bookmark fallback. A field that is absent retains legacy bookmark behavior. Linking an Untitled project or linking across drives uses a local bookmark; a first save makes that link relative when possible and then drops the local bookmark from the project file. Viewing sources and recent robot-code links remains available in the project menu; each recent shows its parent location and when it was last linked, since clones share a project name. A routine command step without linked robot code keeps its saved command and offers **Link robot code…**.

## Discovery

See [command discovery](discovery.md) for source inventory and saved NI metadata. Stable IDs connect authoring entries to caller-owned robot handlers. No VI refnum or memory address is serialized into path files.

## Robot delivery

Direct BDX export is available locally. **Push path** uploads the selected path files through SFTP as `admin` at the configured robot address, using the robot's SSH service on port 22 and an empty password. Newly uploaded BDX files are readable by the LabVIEW runtime running as `lvuser`. The default destination is `/home/lvuser/natinst/bin/Paths/`, matching the LabVIEW autonomous loader. Saved connections using the former `/natinst/bin/Paths` default are corrected when loaded; other custom directories are preserved. The destination is shown before every upload. Directory links are followed, as with a normal file copy. Bordeaux uses the OpenSSH rename extension when available; a server without it uses standard SFTP rename for new files and a direct overwrite for an existing selected file. Direct overwrites are not atomic: an interrupted copy can leave that selected file incomplete. Final readback still verifies the bytes, and a failure names the transfer step and reports which files were verified. Other files are never removed.

Set up the robot once and confirm its SSH identity. Subsequent pushes go directly to the selected-file review with the saved robot and directory; no separate connection or trust step is required. In the review, **Change** keeps the selection and reuses the known identity if the address and SSH key still match. A different robot or changed key requires identity confirmation. After a failed upload, **Try again** prepares a fresh review of the selected paths using the remembered robot. Connection checks report missing required parent directories before trust; only missing descendants inside the allowed upload area are created during upload.

In **Settings → Robot connection**, **Edit → Save** stores the address, port and destination locally without connecting. Directory-only edits retain the remembered SSH identity; changing the host or port clears it and requires **Connect** and identity review before a push. Saving settings discards any prior upload review; select paths and review the destination again when ready to send.

Review lists the exact filenames and destination before sending. Each file is written to a temporary file, read back, then published at its matching filename and read back again. Publication uses an atomic rename when supported, or the selected-file copy fallback described above. Other files are preserved. Multi-path uploads commit each file separately; if a later transfer fails or is canceled, the error reports already verified files and any uncertain replacement. The account must have write access to the destination; Bordeaux does not change robot permissions.

For selecting a complete path and converting BDX field velocities into the legacy swerve coordinate system, see [robot playback integration](robot-playback-integration.md).

“Uploaded and verified” means the selected BDX bytes are stored on the robot. It does not require a Bordeaux receiver, acknowledge runtime compatibility, activate a routine, or start execution. LabVIEW code remains responsible for loading and validating the files. Routine delivery, full-project replacement, and runtime pin/rollback are not part of direct file upload. Routine documents autosave locally; AQU robot execution remains deferred.
