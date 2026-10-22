import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppUpdateDialog, releaseNoteBlocks } from '../src/renderer/components/AppUpdateDialog';
const render = (patch) => renderToStaticMarkup(React.createElement(AppUpdateDialog, { state: { phase: 'available', currentVersion: '0.2.0-beta.10', version: '0.2.0-beta.11', channel: 'beta', ...patch } }));
describe('app update dialog', () => {
  it('renders safe headings, lists and code without activating release links or HTML', () => {
    const notes = '# Fixes\n- **Faster** playback\n[Download](https://bad.example)\n<script>alert(1)</script>\n```js\nconst value = 1;\n```';
    expect(releaseNoteBlocks(notes).map(b => b.kind)).toEqual(['heading', 'item', 'paragraph', 'paragraph', 'code']);
    const html = render({ releaseNotes: notes });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('bad.example');
  });
  it('allows restart and retry with unsaved work without redundant header or restart copy', () => {
    const html = render({ phase: 'downloaded', projectDirty: true });
    expect(html).not.toContain('Save your project before restarting');
    expect(html).not.toContain('Beta channel');
    expect(html).not.toContain('disabled');
    expect(render({ phase: 'error', errorStage: 'install', projectDirty: true })).not.toContain('disabled');
    const saved = render({ phase: 'downloaded', projectDirty: false });
    expect(saved).not.toContain('disabled');
    expect(saved).not.toContain('Restart Bordeaux to finish installing');
  });
  it('shows determinate progress, transfer totals and explicit cancellation', () => {
    const html = render({ phase: 'downloading', progress: { percent: 43, transferred: 45 * 1048576, total: 100 * 1048576, bytesPerSecond: 2 * 1048576 } });
    expect(html).toContain('value="43"');
    expect(html).toContain('45.0 MB of 100.0 MB');
    expect(html).toContain('2.0 MB/s');
    expect(html).toContain('Cancel download');
  });
  it('chooses retry for the failed operation rather than the presence of a version', () => {
    expect(render({ phase: 'error', errorStage: 'check' })).toContain('Try again');
    expect(render({ phase: 'error', errorStage: 'download' })).toContain('Retry download');
    expect(render({ phase: 'error', errorStage: 'install' })).toContain('Retry install');
  });
  it('offers a dismissible manual recovery state without repeating a pending install', () => {
    const html = render({ phase: 'installing', installStalled: true });
    expect(html).toContain('Restart delayed');
    expect(html).toContain('All releases');
    expect(html).toContain('>Close</button>');
    expect(html).not.toContain('Retry install');
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('<progress');
  });
  it('renders readable lists and inline code, with a Done action when current', () => {
    const html = render({ phase: 'upToDate', version: null, releaseNotes: '## Path uploads\n- **Save** the address.\n- Use `/home/lvuser/natinst/bin/Paths`.\n`Unclosed literal' });
    expect(html).toContain('<ul><li><strong>Save</strong>');
    expect(html).toContain('<code>/home/lvuser/natinst/bin/Paths</code>');
    expect(html).toContain('`Unclosed literal');
    expect(html).toContain('>Done</button>');
    expect(html).toContain('>Check again</button>');
    expect(html).not.toContain('class="primary"');
  });
});
