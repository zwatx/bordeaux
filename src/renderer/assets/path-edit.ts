import type { PathDoc } from "../../core/types";

  /** A tiny external store that confines high-frequency canvas drafts to subscribers. */
  function create<T extends { id: string } = PathDoc>() {
    const listeners = new Set<() => void>();
    let draft: T | null = null;
    let revision = 0;
    let cancelRevision = 0;
    let lastResolution: "finish" | "cancel" | null = null;
    const emit = () => listeners.forEach((listener) => listener());
    return {
      begin(value: T) {
        if (draft) return false;
        draft = value;
        lastResolution = null;
        revision += 1;
        return true;
      },
      update(value: T) {
        if (!draft) return false;
        draft = value;
        revision += 1;
        emit();
        return true;
      },
      finish() {
        if (!draft) return null;
        const value = draft;
        draft = null;
        lastResolution = 'finish';
        revision += 1;
        emit();
        return value;
      },
      cancel() {
        const hadDraft = Boolean(draft);
        draft = null;
        lastResolution = hadDraft ? 'cancel' : null;
        if (hadDraft) revision += 1;
        cancelRevision += 1;
        emit();
        return hadDraft;
      },
      getSnapshot() {
        return draft;
      },
      getRevision() {
        return revision;
      },
      getCancelRevision() {
        return cancelRevision;
      },
      getLastResolution() {
        return lastResolution;
      },
      materialize<P extends { paths: T[] }>(project: P): P {
        if (!draft || !project || !Array.isArray(project.paths)) return project;
        const active = draft;
        const index = project.paths.findIndex((path) => path.id === active.id);
        if (index < 0 || project.paths[index] === draft) return project;
        const paths = project.paths.slice();
        paths[index] = draft;
        return { ...project, paths };
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    };
  }

export const PathEdit = Object.freeze({ create });
