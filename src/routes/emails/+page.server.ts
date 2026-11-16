import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
/** The screen is called Mailboxes now; old links and bookmarks land there. (Microsoft's sign-in still returns to /emails/microsoft/callback, the address registered with Microsoft.) */
export const load: PageServerLoad = ({ url }) => { redirect(308, `/mailboxes${url.search}`); };
