/** Narrow desktop capabilities. Menus and their commands remain owned by main. */
export type WindowAction = "minimize" | "toggle-maximize" | "close";
export type WindowMenu = "application" | "file" | "robot" | "agents" | "view" | "help";
export interface WindowState { maximized: boolean; fullscreen: boolean; focused: boolean }
export interface WindowMenuAnchor { x: number; y: number }
export interface WindowMenuEntry {
  token: string; id: string; label: string; enabled: boolean; separator: boolean;
  checked?: boolean; accelerator?: string; children?: WindowMenuEntry[];
}
