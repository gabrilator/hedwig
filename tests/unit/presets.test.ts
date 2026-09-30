import { describe, expect, it } from 'vitest';
import { PRESETS, presetForMx, smtpImplicitTls } from '../../src/lib/server/mail/imapSmtp';

describe('presetForMx', () => {
  it('maps the real MX hosts of the three domains', () => {
    expect(presetForMx(['mx1.titan.email', 'mx2.titan.email']).preset).toBe('titan');
    expect(presetForMx(['example-com.mail.protection.outlook.com']).preset).toBe('microsoft');
    expect(presetForMx(['aspmx.l.google.com']).preset).toBe('google');
    expect(presetForMx([]).preset).toBe('custom');
  });
  it('every preset except custom has both hosts', () => {
    for (const [k, p] of Object.entries(PRESETS)) if (k !== 'custom') { expect(p.imap.host).toMatch(/\./); expect(p.smtp.host).toMatch(/\./); }
    expect(PRESETS.titan.imap).toEqual({ host: 'imap.titan.email', port: 993, secure: true });
    expect(PRESETS.titan.smtp).toEqual({ host: 'smtp.titan.email', port: 587, secure: false });
  });
  it('every preset submits on 587 with STARTTLS: 465 is blocked outbound on many cloud servers', () => {
    for (const p of Object.values(PRESETS)) { expect(p.smtp.port).toBe(587); expect(p.smtp.secure).toBe(false); }
  });
});
describe('smtpImplicitTls', () => {
  it('lets the port decide on the standard ports and the box elsewhere', () => {
    expect(smtpImplicitTls(465, false)).toBe(true);
    expect(smtpImplicitTls(587, true)).toBe(false);
    expect(smtpImplicitTls(25, true)).toBe(false);
    expect(smtpImplicitTls(2525, true)).toBe(true);
    expect(smtpImplicitTls(2525, false)).toBe(false);
  });
});
