import type { UserDoc } from '$lib/server/types';
import type { SpaceInfo } from '$lib/server/scope';

declare global {
  namespace App {
    interface Locals {
      user: UserDoc | null;
      spaces: SpaceInfo[];
      space: SpaceInfo | null;
    }
    interface PageData {
      user?: { id: string; email: string; name: string } | null;
      space?: SpaceInfo | null;
      spaces?: SpaceInfo[];
    }
  }
}
export {};
