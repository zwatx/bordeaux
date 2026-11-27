import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FLIP_DIRECTIONS, PathFlipDialog, flipRequest } from '../src/renderer/components/PathFlipDialog';

const h = React.createElement;
const render = (props = {}) => renderToStaticMarkup(h(PathFlipDialog, {
  pathName: 'Amp to source', defaultCopyName: 'Amp to source (flipped)', canReplace: true,
  onCancel: () => undefined, onConfirm: async () => undefined, ...props,
}));
const radio = (markup, name, value) => markup.match(new RegExp('<input type="radio" name="' + name + '"[^>]*value="' + value + '"/>'))?.[0] || '';
const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('PathFlipDialog', () => {
  it('names the one path, offers three meaningful directions and defaults to a named copy', () => {
    const markup = render();
    expect(markup).toContain('>Flip path<');
    expect(markup).toContain('id="path-flip-path" class="pf-path" title="Amp to source">Amp to source<');
    for (const item of FLIP_DIRECTIONS) expect(markup).toContain('value="' + item.v + '"');
    expect(text(markup)).toContain('Flip horizontal Left ↔ right');
    expect(text(markup)).toContain('Flip vertical Top ↔ bottom');
    expect(text(markup)).toContain('Rotate 180° Half turn');
    // Horizontal is chosen first and its consequence is described once.
    expect(radio(markup, 'pf-direction', 'horizontal')).toContain('checked=""');
    expect(radio(markup, 'pf-direction', 'vertical')).not.toContain('checked');
    expect(text(markup)).toContain('other alliance’s end');
    expect(radio(markup, 'pf-target', 'copy')).toContain('checked=""');
    expect(radio(markup, 'pf-target', 'replace')).not.toContain('disabled');
    expect(markup).toMatch(/value="Amp to source \(flipped\)"/);
    expect(markup).toMatch(/<button type="submit" class="qbtn primary pf-commit">Create copy</);
    expect(markup.match(/class="qbtn primary/g)).toHaveLength(1);
    expect(markup).not.toContain('pf-optimization');
  });

  it('guides a linked path to a copy and leaves its replacement unavailable', () => {
    const markup = render({ canReplace: false });
    expect(radio(markup, 'pf-target', 'replace')).toContain('disabled=""');
    expect(markup).toContain('data-unavailable="true"');
    expect(text(markup)).toContain('shares points with other paths. Save a copy so they stay where they are.');
    expect(markup).toContain('>Create copy<');
  });

  it('keeps the inline error region empty until something fails', () => {
    expect(render()).toContain('<div class="pf-error" role="alert"></div>');
  });
});

describe('flipRequest', () => {
  it('sends a trimmed copy name, or null to change the path in place', () => {
    expect(flipRequest({ direction: 'vertical', target: 'copy', copyName: '  Mirror  ' })).toEqual({ direction: 'vertical', copyName: 'Mirror' });
    expect(flipRequest({ direction: 'rotate', target: 'replace', copyName: 'ignored' })).toEqual({ direction: 'rotate', copyName: null });
  });

  it('refuses a blank copy name instead of confirming', () => {
    expect(flipRequest({ direction: 'horizontal', target: 'copy', copyName: '   ' })).toBeNull();
    expect(flipRequest({ direction: 'horizontal', target: 'copy', copyName: undefined })).toBeNull();
  });
});
