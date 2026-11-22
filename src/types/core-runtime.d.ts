/**
 * The only runtime globals src/core may use, beyond ES2022 itself.
 * Each exists in browsers, Web Workers and Node, so core runs in Electron and in the SystemCore web build.
 * tsconfig.core.json loads this file instead of the DOM or Node type libraries.
 * Add a global here only when every one of those runtimes provides it, and only the members core calls.
 */

declare function structuredClone<T>(value: T): T;
declare function setTimeout(handler: () => void, timeout?: number): unknown;

declare var performance: { now(): number };
declare var crypto: { randomUUID(): string };

interface AbortSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}
interface AbortController { readonly signal: AbortSignal; abort(reason?: unknown): void }
declare var AbortController: { new (): AbortController };

interface DOMException extends Error { readonly name: string }
declare var DOMException: { new (message?: string, name?: string): DOMException };

declare class TextEncoder { encode(input?: string): Uint8Array }
declare class TextDecoder { constructor(label?: string, options?: { ignoreBOM?: boolean }); decode(input?: Uint8Array): string }
