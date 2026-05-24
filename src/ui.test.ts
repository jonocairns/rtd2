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

  it('repairs list markers split from their item text', () => {
    const rendered = renderMarkdown('1. \n**30 Rock** - added 2018\n2.\n**12 Monkeys** - added 2018');

    expect(rendered).toContain('1. ');
    expect(rendered).toContain('30 Rock');
    expect(rendered).toContain('2. ');
    expect(rendered).toContain('12 Monkeys');
    expect(rendered).not.toContain('1. \n');
    expect(rendered).not.toContain('2. \n');
    expect(rendered).not.toContain('**30 Rock**');
  });

  it('does not leak bold markdown markers', () => {
    expect(renderMarkdown('**thing**')).toBe('thing');
    expect(renderMarkdown('- **thing**')).toContain('* thing');
  });

  it('renders bold-led list items on a single line', () => {
    // Without the marked text-renderer override, marked-terminal v7 splits
    // these so the bullet/number and content land on different lines.
    expect(renderMarkdown('- **Brazil (1985)** body')).toBe('* Brazil (1985) body');

    const ordered = renderMarkdown('1. **Item A** - body\n2. **Item B** - body');
    expect(ordered).toBe('1. Item A - body\n2. Item B - body');
  });

  it('keeps ** literal inside code spans (no false bolding)', () => {
    // The previous regex-based cleanup would have bolded `**stars**` inside
    // the code span; the renderer-level fix preserves literal markers.
    expect(renderMarkdown('`code with **stars**`')).toBe('code with **stars**');
  });
});
