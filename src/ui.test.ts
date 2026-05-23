import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './ui.js';

describe('renderMarkdown', () => {
  it('does not indent top-level bullets like code blocks', () => {
    const rendered = renderMarkdown('- one\n- two');

    expect(rendered.split('\n')).toEqual([
      expect.stringMatching(/^\* one$/),
      expect.stringMatching(/^\* two$/),
    ]);
  });

  it('keeps section headings compact', () => {
    const rendered = renderMarkdown('### Needs attention\n\n- #4120 Dick Tracy');

    expect(rendered).toContain('Needs attention');
    expect(rendered).toContain('* #4120 Dick Tracy');
    expect(rendered).not.toContain('    * #4120');
  });
});
