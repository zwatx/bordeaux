# Bordeaux planner corpus

`v1` is a frozen, Bordeaux-authored set of synthetic tactical scenarios for the 2026 REBUILT field. It contains no donated paths, private strategy, team identity, commands, credentials, or third-party material, so Bordeaux may redistribute it without seeking outside permission.

The corpus is intentionally useful but modest in what it proves. It covers trench and bump crossings, curved neutral-zone travel, mirrored alliance geometry, an interior stop, and a rolling endpoint for one fixed swerve model. A benchmark may call these representative tactical scenarios; it may not call them real-team, competition-proven, or statistically representative of FRC autonomous strategy.

The project and manifest were frozen before cross-planner results were observed. Any future geometry or scenario change must create a new version directory and digest instead of rewriting `v1`, which prevents a solver result from quietly tuning the benchmark input.

The manifest pins the field, robot, scenario intent, and SHA-256 of the canonical Bordeaux project. Repository tests reject migration, digest drift, team-sensitive content, and baseline geometry that cannot produce a valid trajectory.

`v1/fixed-geometry.json` selects the first fixed-geometry benchmark cases and records their deterministic seeds, normalization rules, validation tolerances, and source digests. Its sibling `.sha256` file freezes that benchmark manifest itself. The neutral validator recomputes index, distance, and progress from submitted timestamped poses; densely checks the fixed curve, heading law, footprint, stops, waits, endpoint speeds, and motion constraints; and makes validity a prerequisite for leaderboard ranking. Tank paths use the same correctness checks but are excluded from the first swerve leaderboard.

`v1/corridor.json` defines the separate swerve-only corridor class. It freezes endpoints, ordered topology gates, stops, waits, event order, deterministic seeds, and a tube around each authored reference path while allowing a planner to change internal geometry and heading. The validator bounds source spacing, then independently densifies submitted poses so a sparse chord or a rotated footprint cannot escape between samples. The corpus contains no corridor editor and is versioned by its own digest.

## Blue-origin revision

`v2` is the current corpus in `wpilib-blue-origin/2026-welded/1`. It converts the synthetic v1 semantic field sketches and corridor gates to official meters while preserving named portal ownership and guardrail lanes. Headings and handles follow the X reflection. The neutral slalom additionally contracts X by 10% about midfield to retain its neutral-only intent: the old oversized rectangle left clearance that the welded field's full-depth barrier no longer provides for the unchanged 0.84 m robot. Its corridor gates receive the same contraction. This adjustment targets geometric clearance, not a timing result. Each manifest records its original project digest and the conversion, and all new project/manifest digests are frozen. The original v1 directory remains unchanged for historical regression and compatibility checks. Benchmark results from different coordinate revisions must not be compared as the same input.
