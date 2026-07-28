import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { notification, crAssignment, batch, crCourse } from '$lib/server/db/schema';
import { eq, and, ne, inArray } from 'drizzle-orm';

// POST /api/cr/notify — notify other CRs about a moved class.
// Body: { courseCode, major }
// - Co-managing CRs (assigned to one of the moved course's batches) are notified.
// - CRs who added this course to their watch list are notified.
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.user.role !== 'cr' && locals.user.role !== 'admin') {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const { courseCode, major } = await request.json();
	if (!courseCode) return json({ error: 'Missing courseCode' }, { status: 400 });

	// All CR assignments excluding the mover
	const allAssignments = await db
		.select({ userId: crAssignment.userId, batchName: batch.name })
		.from(crAssignment)
		.innerJoin(batch, eq(crAssignment.batchId, batch.id))
		.where(ne(crAssignment.userId, locals.user.id));

	// Co-managers: exact-token match between the course's batch list and CR batch names
	const majorTokens = new Set(
		(major ?? '').toUpperCase().split(/[\s,]+/).filter(Boolean)
	);
	const coManagers = new Set<string>();
	for (const a of allAssignments) {
		if (majorTokens.has(a.batchName.toUpperCase())) coManagers.add(a.userId);
	}

	// Watchers: CRs who manually added this course to their list
	const watcherRows = await db
		.select({ userId: crCourse.userId })
		.from(crCourse)
		.where(
			and(
				eq(crCourse.courseCode, String(courseCode).toUpperCase()),
				ne(crCourse.userId, locals.user.id)
			)
		);
	const watchers = new Set(watcherRows.map((w) => w.userId));

	const targets = new Set([...coManagers, ...watchers]);
	if (targets.size === 0) return json({ success: true, notified: 0 });

	// Skip CRs who already have an undismissed notification for this course
	const existing = await db
		.select({ toUserId: notification.toUserId })
		.from(notification)
		.where(
			and(
				eq(notification.courseCode, courseCode),
				eq(notification.dismissed, false),
				inArray(notification.toUserId, [...targets])
			)
		);
	const alreadyNotified = new Set(existing.map((e) => e.toUserId));

	const rows = [...targets]
		.filter((toUserId) => !alreadyNotified.has(toUserId))
		.map((toUserId) => ({
			id: crypto.randomUUID(),
			toUserId,
			fromUserName: locals.user!.name,
			courseCode,
			message: coManagers.has(toUserId)
				? `${courseCode} was moved in the timetable by ${locals.user!.name} — this class is in your batch's timetable`
				: `${courseCode} was moved in the timetable by ${locals.user!.name} — this course is on your watch list`
		}));

	if (rows.length > 0) await db.insert(notification).values(rows);

	return json({ success: true, notified: rows.length });
};
