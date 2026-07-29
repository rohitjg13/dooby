import type { Handle } from '@sveltejs/kit';
import { building } from '$app/environment';
import { eq, inArray } from 'drizzle-orm';
import { auth } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { user as userTable, pendingCr, crAssignment } from '$lib/server/db/schema';
import { svelteKitHandler } from 'better-auth/svelte-kit';

// An admin can grant CR access to an email before that person has ever signed in. The
// invitation sits in pending_cr until their first request, which is here: the rows become
// real assignments and the account is promoted. Only runs for 'pending' accounts, so it
// costs one extra query exactly once per invited user.
async function claimPendingCr(u: NonNullable<App.Locals['user']>): Promise<void> {
	const email = u.email.toLowerCase();
	const invites = await db.select().from(pendingCr).where(eq(pendingCr.email, email));
	if (invites.length === 0) return;

	const existing = await db
		.select({ batchId: crAssignment.batchId })
		.from(crAssignment)
		.where(eq(crAssignment.userId, u.id));
	const held = new Set(existing.map((r) => r.batchId));
	const toAdd = invites.filter((i) => !held.has(i.batchId));

	if (toAdd.length > 0) {
		await db.insert(crAssignment).values(
			toAdd.map((i) => ({ id: crypto.randomUUID(), userId: u.id, batchId: i.batchId }))
		);
	}
	await db.update(userTable).set({ role: 'cr' }).where(eq(userTable.id, u.id));
	await db.delete(pendingCr).where(inArray(pendingCr.id, invites.map((i) => i.id)));

	// Reflect it on this same request, so the page they land on is already the CR view
	u.role = 'cr';
}

const handleBetterAuth: Handle = async ({ event, resolve }) => {
	const session = await auth.api.getSession({ headers: event.request.headers });

	if (session) {
		// Better Auth minimal build may not pass through extra columns like `role`.
		// Fall back to a direct DB lookup to ensure we always have the full user row.
		const role = (session.user as Record<string, unknown>).role;
		if (role !== undefined) {
			event.locals.user = session.user as App.Locals['user'];
		} else {
			const [fullUser] = await db
				.select()
				.from(userTable)
				.where(eq(userTable.id, session.user.id))
				.limit(1);
			event.locals.user = fullUser as App.Locals['user'];
		}
		event.locals.session = session.session;

		if (event.locals.user?.role === 'pending') {
			await claimPendingCr(event.locals.user);
		}
	}

	return svelteKitHandler({ event, resolve, auth, building });
};

export const handle: Handle = handleBetterAuth;
