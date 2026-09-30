import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { buildLeadDocs, columnStats, detectEmailColumn, parseCsv } from '../../src/lib/server/csv';
import type { CampaignDoc } from '../../src/lib/server/types';

const campaign = { _id: new ObjectId(), space: 'org:x' } as CampaignDoc;

const file = parseCsv([
  'Centro,Correo del director,Teléfono,Notas',
  'Company A,ana@company-a.es,600,first',
  'Company B,no address here,601,',
  'Company C,ANA@company-a.es,602,duplicate of A',
  'Company D,dani@company-d.es,,',
  'Company E,,604,no email at all',
  'Company F,fer@company-f.es,605,suppressed'
].join('\n'));

describe('detectEmailColumn', () => {
  it('prefers a header that says email or correo and holds addresses', () => {
    expect(detectEmailColumn(file.headers, file.rows)).toBe('Correo del director');
  });
  it('ignores an email-named column with no addresses and falls back to the one that has them', () => {
    const f = parseCsv('Email verified,To\nyes,a@b.es\nno,c@d.es');
    expect(detectEmailColumn(f.headers, f.rows)).toBe('To');
  });
  it('returns null when no column has an address', () => {
    const f = parseCsv('Name,Phone\nAna,600');
    expect(detectEmailColumn(f.headers, f.rows)).toBeNull();
  });
});

describe('columnStats', () => {
  it('counts what survives per column: valid, once per address, not already in, not suppressed', () => {
    const st = columnStats(file.headers, file.rows, new Set(['dani@company-d.es']), new Set(['fer@company-f.es']));
    expect(st['Correo del director']).toEqual({ filled: 5, emails: 4, unique: 3, alreadyIn: 1, suppressed: 1, willImport: 1 });
    expect(st['Teléfono'].emails).toBe(0);
    expect(st['Notas'].filled).toBe(4);
  });
  it('agrees with buildLeadDocs on the number of leads', () => {
    const suppressed = new Set(['fer@company-f.es']);
    const st = columnStats(file.headers, file.rows, new Set(), suppressed)['Correo del director'];
    const { docs, stats } = buildLeadDocs(campaign, file.rows, { emailColumn: 'Correo del director', columns: [] }, suppressed);
    expect(docs.length).toBe(st.willImport);
    expect(stats).toMatchObject({ total: 6, invalid: 2, duplicatesInFile: 1, suppressed: 1 });
  });
});

describe('buildLeadDocs', () => {
  it('needs only the email column; every other column is optional and keeps whatever name it is given', () => {
    const { docs } = buildLeadDocs(campaign, file.rows, { emailColumn: 'Correo del director', columns: [{ header: 'Centro', variable: 'Nombre del centro' }, { header: 'Notas', variable: 'notas' }] }, new Set());
    expect(docs.map((d) => d.email)).toEqual(['ana@company-a.es', 'dani@company-d.es', 'fer@company-f.es']);
    expect(docs[0].vars).toMatchObject({ email: 'ana@company-a.es', nombreDelCentro: 'Company A', notas: 'first' });
    expect(docs[0].vars.telefono).toBeUndefined();
    expect(docs[1].vars.notas).toBeUndefined();
  });
});
