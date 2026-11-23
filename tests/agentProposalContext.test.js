import { describe, expect, it } from "vitest";
import { agentProposalMatchesPublishedContext } from "../src/renderer/lib/agentProposalContext";
import { freshProject } from "../src/renderer/lib/editorProject";
import { buildBdxExport } from "../src/core/export/bdx";
import { createDemoProject } from "../src/core/project/defaults";
import { validateProject } from "../src/core/validation";

describe("renderer agent proposal context", () => {
  it("creates an immediately exportable project with the active field reference", () => {
    const project = freshProject();

    expect(validateProject(project)).toEqual({ ok: true, issues: [] });
    expect(project.field).toEqual(createDemoProject().field);
    expect(() => buildBdxExport(project)).not.toThrow();
  });

  it("does not bless an unpublished project that keeps the same revision and active path", () => {
    const publishedProject = { name: "Published project" };
    const published = { revision: 4, project: publishedProject, activePathId: "path_a", editRevision: 8 };
    const proposal = {
      baseSessionId: "session_a",
      baseRevision: 4,
      baseActivePathId: "path_a",
      baseRobotCatalogFingerprint: "catalog_a",
    };
    const current = {
      project: publishedProject,
      activePathId: "path_a",
      editRevision: 8,
      robotCatalogFingerprint: "catalog_a",
      hasDraft: false,
    };

    expect(agentProposalMatchesPublishedContext(proposal, "session_a", published, current)).toBe(true);
    expect(agentProposalMatchesPublishedContext(proposal, "session_a", published, {
      ...current,
      project: { name: "Opened before delayed publication" },
    })).toBe(false);
    expect(agentProposalMatchesPublishedContext({ ...proposal, baseActivePathId: "path_b" }, "session_a", published, current)).toBe(false);
    expect(agentProposalMatchesPublishedContext(proposal, "session_a", published, { ...current, robotCatalogFingerprint: "catalog_b" })).toBe(false);
  });
});
