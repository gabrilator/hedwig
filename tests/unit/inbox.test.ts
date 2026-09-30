import { describe, expect, it } from 'vitest';
import { isAutoReply, looksLikeBounce } from '../../src/lib/server/inbox';

describe('looksLikeBounce', () => {
  it('spots NDRs by sender or subject', () => {
    expect(looksLikeBounce({ from: 'postmaster@outlook.com', subject: 'Undeliverable: Una pregunta' })).toBe(true);
    expect(looksLikeBounce({ from: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)' })).toBe(true);
    expect(looksLikeBounce({ from: 'direccion@empresa.example', subject: 'RE: Una pregunta' })).toBe(false);
  });
});
describe('isAutoReply', () => {
  it('uses headers first, subject second', () => {
    expect(isAutoReply({ autoSubmitted: 'auto-replied', headers: {}, subject: 'RE: hola' })).toBe(true);
    expect(isAutoReply({ autoSubmitted: undefined, headers: { 'x-auto-response-suppress': 'All' }, subject: 'hola' })).toBe(true);
    expect(isAutoReply({ autoSubmitted: undefined, headers: {}, subject: 'Respuesta automática: Fuera de la oficina' })).toBe(true);
    expect(isAutoReply({ autoSubmitted: 'no', headers: {}, subject: 'RE: Una pregunta' })).toBe(false);
  });
});
