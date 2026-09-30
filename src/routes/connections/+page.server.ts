import { redirect } from '@sveltejs/kit';
export const load = ({ params, url }: any) => redirect(303, `/setup#connections${url.search}`);
