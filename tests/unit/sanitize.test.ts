import { describe, expect, it } from 'vitest';
import { sanitizeInboundHtml } from '../../src/lib/server/sanitize';

describe('sanitizeInboundHtml', () => {
  it('keeps text formatting and links, drops scripts, styles, images and forms', () => {
    const html = '<style>p{color:red}</style><p>Hola <b>Ana</b>,<br>gracias.</p><img src="https://x/pixel.gif"><script>alert(1)</script><a href="https://empresa.example" onclick="x()">web</a><form><input></form><table><tr><td colspan="2">t</td></tr></table>';
    const out = sanitizeInboundHtml(html);
    expect(out).toContain('<b>Ana</b>');
    expect(out).toContain('<br />');
    expect(out).toContain('<a href="https://empresa.example" target="_blank" rel="noopener noreferrer">web</a>');
    expect(out).toContain('<td colspan="2">t</td>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('script');
    expect(out).not.toContain('style');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('<form');
  });
  it('only allows web and mail links', () => {
    expect(sanitizeInboundHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript');
    expect(sanitizeInboundHtml('<a href="mailto:a@b.es">m</a>')).toContain('mailto:a@b.es');
  });
});
