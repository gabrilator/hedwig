import { describe, expect, it } from 'vitest';
import { toCsv } from '../../src/lib/server/feed';

describe('toCsv', () => {
  it('writes a header row, CRLF line ends and RFC 4180 quoting', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b\r\n');
    expect(toCsv(['name', 'n', 'ok'], [['Montréal, été "B"', 3, true], ['two\nlines', 0, false]])).toBe('name,n,ok\r\n"Montréal, été ""B""",3,true\r\n"two\nlines",0,false\r\n');
  });
  it('keeps a cell that starts like a formula as text, and leaves numbers alone', () => {
    expect(toCsv(['x'], [['=IMPORTXML("http://x.example")'], ['+1'], ['-a'], ['@b'], [-1]])).toBe(`x\r\n"'=IMPORTXML(""http://x.example"")"\r\n"'+1"\r\n"'-a"\r\n"'@b"\r\n-1\r\n`);
  });
});
