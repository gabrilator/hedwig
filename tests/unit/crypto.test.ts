import { beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { hashPassword, open, seal, verifyPassword } from '../../src/lib/server/crypto';

beforeAll(() => { process.env.HEDWIG_MASTER_KEY ||= randomBytes(32).toString('base64'); });

describe('seal/open', () => {
  it('round-trips and never stores plaintext', () => {
    const s = seal({ imapPass: 'hunter2' });
    expect(s).not.toContain('hunter2');
    expect(open(s)).toEqual({ imapPass: 'hunter2' });
  });
});
describe('passwords', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const h = await hashPassword('jijijaja');
    expect(await verifyPassword('jijijaja', h)).toBe(true);
    expect(await verifyPassword('jajajiji', h)).toBe(false);
  });
});
