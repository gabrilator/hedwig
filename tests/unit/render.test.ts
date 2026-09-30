import { describe, expect, it } from 'vitest';
import { camelKey, firstNameFrom, renderTemplate, textToHtml, variablesIn } from '../../src/lib/server/render';

describe('renderTemplate', () => {
  it('fills variables case-insensitively and applies fallbacks', () => {
    const r = renderTemplate('Hola {{firstName|there}}, sobre {{ companyName }} y {{City}}', { firstname: 'Ana', companyName: 'Empresa X' });
    expect(r.text).toBe('Hola Ana, sobre Empresa X y ');
    expect(r.missing).toEqual(['City']);
  });
  it('uses the fallback when the value is empty', () => {
    expect(renderTemplate('{{firstName|there}}', { firstName: '' }).text).toBe('there');
  });
  it('lists variables', () => {
    expect(variablesIn('{{a}} {{b|x}} {{a}}')).toEqual(['a', 'b']);
  });
});
describe('camelKey', () => {
  it('turns headers into variable names', () => {
    expect(camelKey('Contact Person')).toBe('contactPerson');
    expect(camelKey('Postal_City')).toBe('postalCity');
    expect(camelKey('EMAIL')).toBe('email');
    expect(camelKey('Size Estimate')).toBe('sizeEstimate');
  });
});
describe('firstNameFrom', () => {
  it('drops honorifics', () => { expect(firstNameFrom('Dña. María García')).toBe('María'); expect(firstNameFrom('')).toBe(''); });
});
describe('textToHtml', () => {
  it('escapes, links and keeps paragraphs', () => {
    const h = textToHtml('Hola <b>\n\nhttps://x.es/a.');
    expect(h).toContain('&lt;b&gt;');
    expect(h).toContain('<a href="https://x.es/a">https://x.es/a</a>.');
    expect(h.match(/<p /g)?.length).toBe(2);
  });
});
