import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProjectChip, firstFact, parentLocation, shortFact } from '../src/renderer/components/ProjectChip';

const chip = (props) => renderToStaticMarkup(React.createElement(ProjectChip, { name: 'Week 3 autos', folderPath: '/team/Week 3 autos', status: 'saved', robotCode: { status: 'unlinked' }, actions: {}, ...props }));

describe('project chip', () => {
  it('shows the saved project name alone, with words reserved for failures and recovery', () => {
    expect(chip({})).not.toContain('project-chip-meta');
    expect(chip({})).not.toContain('>Saved<');
    expect(chip({ status: 'failed', saveError: 'The project folder is read-only.' })).toContain('data-status="failed"');
    expect(chip({ status: 'failed' })).toContain('>Not saved<');
    expect(chip({ folderPath: null, status: 'unsaved' })).not.toContain('>Not saved<');
    expect(chip({ status: 'recovered' })).toContain('>Recovered<');
  });

  it('keeps a BDX failure separate from the saved project', () => {
    const markup = chip({ bdxError: 'Project saved; BDX saving did not complete.' });
    expect(markup).not.toContain('>Saved<');
    expect(markup).toContain('<span class="project-chip-bdx">BDX failed</span>');
    expect(markup).not.toContain('Not saved');
  });

  it('shows an immediate text asterisk beside the name during debounce and keeps saved projects unmarked', () => {
    expect(chip({ status: 'saving', writing: false })).toContain('<span class="project-chip-unsaved" aria-hidden="true">*</span>');
    expect(chip({ status: 'saving', writing: false })).toContain('aria-label="Week 3 autos, Unsaved changes"');
    expect(chip({})).not.toContain('project-chip-unsaved');
  });

  it('shortens desktop errors to their first fact', () => {
    expect(shortFact(new Error("Error invoking remote method 'project:createNamed': Error: That project folder already exists. Choose another name."))).toBe('That project folder already exists');
    expect(shortFact('Folder is read-only')).toBe('Folder is read-only');
    expect(shortFact('x'.repeat(90))).toHaveLength(58);
  });

  it('turns a raw errno message into its fact, keeping plain messages', () => {
    expect(shortFact(new Error("Error invoking remote method 'project:save': Error: EACCES: permission denied, open '/Users/team/Bordeaux/Week 3 autos/Paths/Left.path'"))).toBe('Folder is read-only');
    expect(shortFact("Folder is read-only. EACCES: permission denied, open '/x'")).toBe('Folder is read-only');
    expect(firstFact('ENOSPC: no space left on device, write')).toBe('Disk is full');
    expect(firstFact('Opening move has an invalid command. Correct the command and save again.')).toBe('Opening move has an invalid command');
  });

  it('shows where a project lives rather than its name again', () => {
    expect(parentLocation('/Users/team/Bordeaux/Week 3 autos')).toBe('~/Bordeaux');
    expect(parentLocation('/Volumes/Old laptop/Desktop/Practice field tests/')).toBe('/Volumes/Old laptop/Desktop');
    expect(parentLocation('C:\\Users\\team\\Documents\\Bordeaux\\Week 2')).toBe('~\\Documents\\Bordeaux');
  });

  it('announces a failure through a live region and tints the failed chip', () => {
    const failed = chip({ status: 'failed', saveError: "Folder is read-only. EACCES: permission denied, open '/x'" });
    expect(failed).toContain('<span class="sr-only" role="status">Week 3 autos isn’t saved: Folder is read-only</span>');
    expect(chip({ bdxError: 'Project saved; BDX saving did not complete.', bdxDetails: { cause: 'Opening move has an invalid command. Fix it.', partial: true } }))
      .toContain('Week 3 autos saved; BDX files failed: Some BDX files may be out of date · Opening move has an invalid command');
    expect(chip({})).toContain('<span class="sr-only" role="status"></span>');
  });

  it('keeps pending changes marked without a routine status line during writes', () => {
    expect(chip({ status: 'saving', writing: false })).toContain('data-status="saving"');
    expect(chip({ status: 'saving', writing: true })).toContain('aria-busy="true"');
    expect(chip({ status: 'saving', writing: true })).not.toContain('project-chip-meta');
    expect(chip({ status: 'saving', writing: true })).not.toContain('>Saving<');
  });
});
