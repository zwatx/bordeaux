import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FieldStatus, isConfirmation, orderNotices } from '../src/renderer/components/FieldStatus';

const render = (notices) => renderToStaticMarkup(React.createElement(FieldStatus, { notices }));
const summary = (markup) => markup.match(/<summary>([\s\S]*?)<\/summary>/)?.[1];

const preparing = { id: 'loading', label: 'Preparing trajectory…', detail: 'Preview timing is provisional until planning finishes.' };
const exported = { id: 'bdx-export', label: 'BDX exported', detail: 'Saved paths/Path.bdx.', autoDismissMs: 5000, dismissKey: {}, action: { label: 'Dismiss', onClick() {} } };
const stale = { id: 'optimization', label: 'Optimization out of date', detail: 'The path changed after optimization.', action: { label: 'Optimize', onClick() {} } };

describe('compact field status', () => {
  it('does not leave a status surface on a healthy field', () => {
    expect(render([])).toBe('');
  });

  it('shows one summary while keeping concurrent messages in initially collapsed details', () => {
    const markup = render([preparing, stale]);
    expect(summary(markup)).toContain('Preparing trajectory…');
    expect(summary(markup)).toContain('Details (2)');
    expect(summary(markup)).not.toContain('Optimization out of date');
    expect(markup).toContain('<details>');
    expect(markup).not.toMatch(/<details[^>]*\bopen/);
    expect(markup.match(/role="status"/g)).toHaveLength(1);
    expect(markup).toContain(preparing.detail);
    expect(markup).toContain(stale.detail);
    // Planning stays automatic; a useful action on another notice remains reachable without expanding.
    expect(markup).toMatch(/<\/details><button[^>]*class="field-status-action"[^>]*>Optimize<\/button>/);
  });

  it('announces the primary failure once and retains full escaped diagnostics and secondary actions', () => {
    const detail = 'Cannot export <path>: speed > limit & trajectory unavailable. '.repeat(20);
    const markup = render([{ id: 'export', error: true, label: 'Export failed', detail,
      action: { label: 'Dismiss', onClick() {} } }, preparing, stale]);
    expect(summary(markup)).toContain('Export failed');
    expect(summary(markup)).not.toContain('Preparing trajectory');
    expect(markup.match(/role="alert"/g)).toHaveLength(1);
    expect(markup).not.toContain('role="status"');
    expect(markup).toContain('&lt;path&gt;');
    expect(markup).toContain('limit &amp; trajectory');
    expect(markup).not.toContain('<path>');
    expect(markup).toMatch(/<\/details><button[^>]*class="field-status-action"[^>]*>Dismiss<\/button>/);
    expect(markup).toContain('>Optimize</button>');
  });

  it('leads with a failure that arrives beside a success, with that failure’s own action', () => {
    // App lists an export success first; a planning failure that coexists with it must not hide under it.
    const planning = { id: 'planning', error: true, label: 'Couldn’t time this path', detail: 'Controlled planning failure.', action: { label: 'Try again', onClick() {} } };
    const markup = render([exported, planning]);
    expect(summary(markup)).toContain('Couldn’t time this path');
    expect(summary(markup)).toContain('role="alert"');
    expect(markup).not.toContain('role="status"');
    expect(markup).toMatch(/class="field-status error"/);
    expect(markup).toMatch(/<\/details><button[^>]*class="field-status-action"[^>]*>Try again<\/button>/);
    // The success is listed in the details without a Dismiss of its own (it still expires); Try again is not repeated.
    expect(markup.match(/>Try again<\/button>/g)).toHaveLength(1);
    expect(markup).toMatch(/<strong>BDX exported<\/strong><p>Saved paths\/Path.bdx.<\/p><\/div>/);
    expect(markup).not.toContain('Dismiss');
  });

  it('shows an ordinary success alone as one quiet line without details or buttons', () => {
    const markup = render([exported]);
    expect(markup).toMatch(/^<div class="field-status field-confirmation" title="Saved paths\/Path.bdx.">/);
    expect(markup).not.toContain('<details');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('Details');
    expect(markup).not.toContain('Dismiss');
    expect(markup.match(/role="status"/g)).toHaveLength(1);
    expect(markup).not.toContain('role="alert"');
    // Assistive technology hears the detail that sighted users get as the tooltip.
    expect(markup).toMatch(/role="status">BDX exported<span class="sr-only">\. Saved paths\/Path.bdx.<\/span><\/span>/);
  });

  it('keeps the full status when a success coexists with persistent information, offering only real actions', () => {
    const markup = render([exported, stale]);
    expect(summary(markup)).toContain('BDX exported');
    expect(summary(markup)).toContain('Details (2)');
    expect(markup).toMatch(/aria-label="Optimize: Optimization out of date"[^>]*>Optimize<\/button><\/div>$/);
    expect(markup).not.toContain('Dismiss');
    // Automatic work without an action does not lend its place to the confirmation's retirement.
    expect(render([preparing, exported])).not.toContain('<button');
  });

  it('treats only an expiring non-error notice with a retirement callback as a confirmation', () => {
    expect(isConfirmation(exported)).toBe(true);
    expect(isConfirmation({ ...exported, error: true })).toBe(false);
    expect(isConfirmation({ ...exported, autoDismissMs: 0 })).toBe(false);
    expect(isConfirmation({ ...exported, action: undefined })).toBe(false);
    expect(isConfirmation(stale)).toBe(false);
    // A persistent failure keeps its Dismiss.
    expect(render([{ id: 'export', error: true, label: 'Export failed', detail: 'x', action: { label: 'Dismiss', onClick() {} } }])).toMatch(/class="field-status-action"[^>]*>Dismiss<\/button>/);
  });

  it('orders errors before other notices without reordering within each group', () => {
    const notices = [{ id: 'a' }, { id: 'b', error: true }, { id: 'c' }, { id: 'd', error: true }];
    expect(orderNotices(notices).map((notice) => notice.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('names the notice an outside action belongs to when it is not the summarized one', () => {
    const markup = render([preparing, stale]);
    expect(markup).toMatch(/aria-label="Optimize: Optimization out of date"[^>]*>Optimize<\/button><\/div>$/);
    expect(markup.match(/>Optimize<\/button>/g)).toHaveLength(1);
  });

  it('distinguishes an unavailable trajectory from a usable interactive preview', () => {
    for (const [error, label, role] of [[true, 'Trajectory unavailable', 'alert'], [false, 'Interactive preview', 'status']]) {
      const markup = render([{ id: 'planning', error, label, detail: 'Planner diagnostic.' }]);
      expect(summary(markup)).toContain(label);
      expect(summary(markup)).toContain('role="' + role + '"');
      expect(markup).not.toContain('field-status-action');
    }
  });
});
