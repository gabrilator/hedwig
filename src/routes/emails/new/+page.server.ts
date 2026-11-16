import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = ({ url }) => { redirect(308, `/mailboxes/new${url.search}`); };
