import type { BordeauxProject } from "../shared/types";
import type { OpenedProject, ProjectLocation } from "../shared/project/desktopProjects";

interface ProjectActivationCompletion {
  generation: number;
  location: ProjectLocation;
  session?: OpenedProject["session"];
  remembered: Promise<unknown>;
  currentGeneration: () => number;
}

/** A recents write can outlive its active project; never publish that obsolete selection. */
export async function completeProjectActivation(project: BordeauxProject, activation: ProjectActivationCompletion): Promise<OpenedProject> {
  const location = { ...activation.location }, session = activation.session && structuredClone(activation.session);
  await activation.remembered;
  if (activation.currentGeneration() !== activation.generation) {
    throw Object.assign(new Error("Another project is now active. This earlier project operation was superseded."), {
      code: "PROJECT_OPERATION_SUPERSEDED",
    });
  }
  return { project, location, ...(session ? { session } : {}) };
}
