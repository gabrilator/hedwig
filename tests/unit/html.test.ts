import { describe, expect, it } from 'vitest';
import { htmlToText, looksLikeHtml, textToEditorHtml } from '../../src/lib/server/render';
import { sanitizeBody } from '../../src/lib/server/sanitize';
import { buildStepMail } from '../../src/lib/server/sender';
import { buildLeadDocs, parseExcel } from '../../src/lib/server/csv';
import * as XLSX from 'xlsx';
import { ObjectId } from 'mongodb';

process.env.ORIGIN ||= 'http://localhost:5180';

describe('html bodies', () => {
  it('detects, converts and flattens', () => {
    expect(looksLikeHtml('<p>hola</p>')).toBe(true);
    expect(looksLikeHtml('hola\n\nadios')).toBe(false);
    expect(textToEditorHtml('a\nb\n\nc')).toBe('<p>a<br>b</p><p>c</p>');
    expect(htmlToText('<p>Hola <b>{{firstName}}</b></p><p>Mira <a href="https://x.es/v">el vídeo</a>.</p><ul><li>uno</li><li>dos</li></ul>'))
      .toBe('Hola {{firstName}}\n\nMira el vídeo (https://x.es/v).\n\n• uno\n• dos');
  });
  it('sanitizes to the email-safe subset', () => {
    const out = sanitizeBody('<p onclick="x()">hi <script>alert(1)</script><a href="javascript:evil()" target="_blank">l</a> <img src=x> <b>b</b></p>');
    expect(out).toBe('<p>hi <a>l</a>  <b>b</b></p>');
  });
  it('renders variables escaped in HTML and raw in text', () => {
    const campaign: any = { steps: [{ subject: 'Hola {{companyName}}', body: '<p>Hola <b>{{firstName|equipo}}</b> de {{companyName}}</p>', delayDays: 0 }], unsubscribeLine: 'Baja', openTracking: false };
    const b = buildStepMail(campaign, 0, { vars: { companyName: 'Empresa <A&B>' }, email: 'x@y.es' }, null);
    expect(b.html).toContain('Hola <b>equipo</b> de Empresa &lt;A&amp;B&gt;');
    expect(b.text).toContain('Hola equipo de Empresa <A&B>');
    expect(b.text).toContain('Baja: ');
    expect(b.missing).toEqual([]);
  });
});

describe('excel + column mapping', () => {
  it('reads the first sheet with a header row and keeps only chosen columns', () => {
    const ws = XLSX.utils.aoa_to_sheet([['Company', 'Contact Person', 'Email', 'Phone'], ['Empresa X', 'Dña. Ana Ruiz', 'a@x.es', '600'], ['Empresa Y', '', 'B@Y.ES', '601'], ['', '', 'not-an-email', '']]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Hoja1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const parsed = parseExcel(buf);
    expect(parsed.headers).toEqual(['Company', 'Contact Person', 'Email', 'Phone']);
    expect(parsed.rows).toHaveLength(3);
    const campaign: any = { _id: new ObjectId(), space: 'user:x' };
    const { docs, stats } = buildLeadDocs(campaign, parsed.rows, { emailColumn: 'Email', columns: [{ header: 'Company', variable: 'org' }, { header: 'Contact Person', variable: 'contactPerson' }] }, new Set());
    expect(stats.invalid).toBe(1);
    expect(docs).toHaveLength(2);
    expect(docs[0].email).toBe('a@x.es');
    expect(docs[0].vars).toEqual({ org: 'Empresa X', contactPerson: 'Dña. Ana Ruiz', email: 'a@x.es', firstName: 'Ana' });
    expect(docs[1].vars.phone).toBeUndefined();
    expect(docs[1].email).toBe('b@y.es');
  });
});

describe('unsubscribe', async () => {
  const { unsubscribeHeaders } = await import('../../src/lib/server/sender');
  it('puts nothing visible in the email when the line is empty, and always sets the List-Unsubscribe headers on a real send', () => {
    const campaign: any = { steps: [{ subject: 'Hi', body: 'Hello', delayDays: 0 }], unsubscribeLine: '', openTracking: false };
    const b = buildStepMail(campaign, 0, { vars: {}, email: 'x@y.es' }, { tokens: { open: 'o', unsub: 'tok123' } });
    expect(b.text).toBe('Hello');
    expect(b.html).not.toContain('/u/');
    expect(b.headers).toEqual(unsubscribeHeaders('tok123'));
    expect(b.headers!['List-Unsubscribe']).toMatch(/^<https?:\/\/.+\/u\/tok123>$/);
    expect(b.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(buildStepMail(campaign, 0, { vars: {}, email: 'x@y.es' }, null).headers).toBeUndefined();
  });
});
