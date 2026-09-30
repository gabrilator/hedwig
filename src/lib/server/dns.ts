import { promises as dns } from 'node:dns';
import type { DnsResult, Provider } from './types';

// one selector per provider the Emails screen offers, plus the usual generic ones: titan1/2 (Titan), hostingermail-a/b/c,
// s1-ionos/s2-ionos, sig1 (iCloud), selector1/2 (Microsoft), google, zoho/zmail
const DKIM_SELECTORS = ['titan1', 'titan2', 'selector1', 'selector2', 'google', 'default', 'zoho', 'zmail', 'hostingermail-a', 'hostingermail-b', 'hostingermail-c', 's1-ionos', 's2-ionos', 'sig1', 'k1', 'k2', 's1', 's2', 'dkim', 'mail', 'mx', 'smtp', 'protonmail', 'fm1', 'fm2', 'mailo'];

async function txt(name: string): Promise<string[]> {
  try {
    const rows = await dns.resolveTxt(name);
    return rows.map((parts) => parts.join(''));
  } catch { return []; }
}
async function cnameExists(name: string): Promise<boolean> {
  try { const r = await dns.resolveCname(name); return r.length > 0; } catch { return false; }
}

export async function checkDomainDns(domain: string, kindHint?: 'microsoft' | 'google' | 'other'): Promise<DnsResult> {
  const d = domain.toLowerCase();
  const spfRecords = (await txt(d)).filter((r) => /^v=spf1\b/i.test(r));
  const spf = { ok: spfRecords.length > 0, record: spfRecords[0] };

  let dkim: DnsResult['dkim'] = { ok: false };
  for (const sel of DKIM_SELECTORS) {
    const name = `${sel}._domainkey.${d}`;
    const records = await txt(name);
    if (records.some((r) => /v=DKIM1|k=rsa|p=/i.test(r)) || (await cnameExists(name))) { dkim = { ok: true, selector: sel }; break; }
  }

  const dmarcRecords = (await txt(`_dmarc.${d}`)).filter((r) => /^v=DMARC1\b/i.test(r));
  const policy = dmarcRecords[0]?.match(/\bp=(none|quarantine|reject)/i)?.[1]?.toLowerCase();
  const dmarc = { ok: dmarcRecords.length > 0, record: dmarcRecords[0], policy };

  const fixes: string[] = [];
  if (!spf.ok) {
    const include = kindHint === 'microsoft' ? 'include:spf.protection.outlook.com' : kindHint === 'google' ? 'include:_spf.google.com' : 'include:<your provider>';
    fixes.push(`Add a TXT record on ${d}: v=spf1 ${include} -all`);
  }
  if (!dkim.ok) {
    fixes.push(kindHint === 'microsoft'
      ? `Enable DKIM for ${d} in Microsoft 365 Defender → Email authentication settings → DKIM, then add the two CNAME records it shows (selector1/selector2._domainkey).`
      : `Enable DKIM signing at your email provider and publish its selector record under _domainkey.${d} (Titan: titan1._domainkey, from Titan's control panel → Domain → DNS records).`);
  }
  if (!dmarc.ok) fixes.push(`Add a TXT record on _dmarc.${d}: v=DMARC1; p=none; rua=mailto:dmarc@${d}`);
  return { domain: d, spf, dkim, dmarc, fixes, checkedAt: new Date() };
}

export async function detectProvider(domain: string): Promise<{ provider: Provider; mx: string[] }> {
  try {
    const mx = (await dns.resolveMx(domain.toLowerCase())).sort((a, b) => a.priority - b.priority).map((m) => m.exchange.toLowerCase());
    if (mx.length === 0) return { provider: 'unknown', mx };
    if (mx.some((h) => /google(mail)?\.com$/.test(h))) return { provider: 'google', mx };
    if (mx.some((h) => /outlook\.com$|protection\.outlook\.com$|office365\.com$|hotmail\.com$/.test(h))) return { provider: 'microsoft', mx };
    return { provider: 'other', mx };
  } catch {
    return { provider: 'unknown', mx: [] };
  }
}
