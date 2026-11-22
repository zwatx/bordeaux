import type { BordeauxHost } from "../hosts/contract";

declare global {
  interface Window {
    bordeauxAPI?: BordeauxHost;
  }
}

export {};
