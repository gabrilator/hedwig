import type { ObjectId } from 'mongodb';
import type { OrgDoc, SpaceKey, UserDoc } from './types';

export interface SpaceInfo { key: SpaceKey; name: string; kind: 'personal' | 'org'; orgId?: ObjectId; role?: 'owner' | 'member' }

export const personalSpace = (userId: ObjectId): SpaceKey => `user:${userId.toHexString()}`;
export const orgSpace = (orgId: ObjectId): SpaceKey => `org:${orgId.toHexString()}`;

export function spacesFor(user: UserDoc, orgs: OrgDoc[]): SpaceInfo[] {
  const out: SpaceInfo[] = [];
  for (const o of orgs) {
    const m = o.members.find((x) => x.userId.equals(user._id));
    if (m) out.push({ key: orgSpace(o._id), name: o.name, kind: 'org', orgId: o._id, role: m.role });
  }
  out.push({ key: personalSpace(user._id), name: 'Personal', kind: 'personal' });
  return out;
}

export function pickSpace(spaces: SpaceInfo[], cookieValue: string | undefined): SpaceInfo {
  const found = cookieValue ? spaces.find((s) => s.key === cookieValue) : undefined;
  return found ?? spaces[0];
}

export function assertSpaceAccess(spaces: SpaceInfo[], key: SpaceKey): SpaceInfo {
  const s = spaces.find((x) => x.key === key);
  if (!s) throw new Error('No access to this space');
  return s;
}
