/** Narrow desktop capabilities. Menus and their commands remain owned by main. */
export type WindowAction = "minimize" | "toggle-maximize" | "close";
export type WindowMenu = "file" | "robot" | "agents" | "view" | "help";
export interface WindowState { maximized: boolean; fullscreen: boolean; focused: boolean }
export interface WindowMenuAnchor { x: number; y: number }
export const WINDOWS_TITLE_BAR_HEIGHT = 36;
