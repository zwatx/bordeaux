import type { BordeauxHost } from "../hosts/contract";

declare global {
  interface Window {
    /** Absent in a plain browser. A host may implement only part of the contract; callers check before calling. */
    bordeauxAPI?: Partial<BordeauxHost>;
  }
}

export {};
