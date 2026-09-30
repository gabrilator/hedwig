import { describe, expect, it } from 'vitest';
import { canonicalRedirect, csrfBlocked } from '../../src/lib/server/host';

const ORIGIN = 'https://app.example.com';

describe('canonicalRedirect', () => {
  it('leaves requests on the ORIGIN host alone', () => {
    expect(canonicalRedirect('app.example.com', '/team', '', ORIGIN)).toBeNull();
    expect(canonicalRedirect('APP.example.com:443', '/campaigns', '?x=1', ORIGIN)).toBeNull();
  });
  it('sends the app on any other of our hosts to ORIGIN, path and query kept', () => {
    expect(canonicalRedirect('track.example.com', '/team', '?a=1', ORIGIN)).toBe('https://app.example.com/team?a=1');
    expect(canonicalRedirect('a1b2.203.0.113.7.sslip.io', '/login', '', ORIGIN + '/')).toBe('https://app.example.com/login');
    expect(canonicalRedirect('track.example.com, proxy', '/', '', ORIGIN)).toBe('https://app.example.com/');
  });
  it('keeps tracking, unsubscribe and health where they are, and never touches local runs', () => {
    expect(canonicalRedirect('track.example.com', '/t/o/abc.gif', '', ORIGIN)).toBeNull();
    expect(canonicalRedirect('track.example.com', '/u/token', '', ORIGIN)).toBeNull();
    expect(canonicalRedirect('10.0.0.5:3000', '/health', '', ORIGIN)).toBeNull();
    expect(canonicalRedirect('localhost:3000', '/team', '', ORIGIN)).toBeNull();
    expect(canonicalRedirect('127.0.0.1:5180', '/team', '', ORIGIN)).toBeNull();
    expect(canonicalRedirect('[::1]:3000', '/team', '', ORIGIN)).toBeNull();
  });
  it('does nothing without ORIGIN, without a host header, or with a broken ORIGIN', () => {
    expect(canonicalRedirect('track.example.com', '/team', '', undefined)).toBeNull();
    expect(canonicalRedirect(null, '/team', '', ORIGIN)).toBeNull();
    expect(canonicalRedirect('track.example.com', '/team', '', 'not a url')).toBeNull();
  });
});

describe('csrfBlocked', () => {
  const O = 'https://app.example.com';
  it('blocks form posts from another origin or with no origin, like SvelteKit does', () => {
    expect(csrfBlocked('POST', 'application/x-www-form-urlencoded', 'https://evil.example', '/team', O)).toBe(true);
    expect(csrfBlocked('POST', 'multipart/form-data; boundary=x', null, '/team', O)).toBe(true);
    expect(csrfBlocked('POST', 'text/plain', 'https://track.example.com', '/campaigns/abc/leads', O)).toBe(true);
    expect(csrfBlocked('DELETE', 'application/x-www-form-urlencoded', undefined, '/x', O)).toBe(true);
  });
  it('lets same-origin forms, JSON and reads through', () => {
    expect(csrfBlocked('POST', 'application/x-www-form-urlencoded', O, '/team', O)).toBe(false);
    expect(csrfBlocked('POST', 'application/json', null, '/api', O)).toBe(false);
    expect(csrfBlocked('GET', 'application/x-www-form-urlencoded', null, '/team', O)).toBe(false);
    expect(csrfBlocked('POST', null, null, '/team', O)).toBe(false);
  });
  it('lets the unsubscribe page take posts from anywhere: one-click from mail clients has no Origin, people click on the tracking host', () => {
    expect(csrfBlocked('POST', 'application/x-www-form-urlencoded', null, '/u/token123', O)).toBe(false);
    expect(csrfBlocked('POST', 'application/x-www-form-urlencoded', 'https://track.example.com', '/u/token123', O)).toBe(false);
    expect(csrfBlocked('POST', 'application/x-www-form-urlencoded', null, '/unsubscribe-ish', O)).toBe(true);
  });
});
