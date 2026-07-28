import { redirect } from '@sveltejs/kit';
import { eq, and, ne } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { crAssignment, batch, crCourse, scheduleBlock, notification } from '$lib/server/db/schema';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(302, '/login');

	const user = locals.user;
	const canManage = user.role === 'cr' || user.role === 'admin';

	// Users who signed in but haven't been made a CR yet see the waiting screen
	if (!canManage) {
		return { user, crBatches: [], myCourses: [], savedSchedule: [], notifications: [], watchCounts: [] };
	}

	const [batchResult, myCourses, scheduleResult, notifResult, othersWatching] = await Promise.all([
		db
			.select({
				id: crAssignment.id,
				assignedAt: crAssignment.assignedAt,
				batch: { id: batch.id, name: batch.name, description: batch.description }
			})
			.from(crAssignment)
			.innerJoin(batch, eq(crAssignment.batchId, batch.id))
			.where(eq(crAssignment.userId, user.id)),
		db
			.select({ courseCode: crCourse.courseCode, courseName: crCourse.courseName })
			.from(crCourse)
			.where(eq(crCourse.userId, user.id))
			.orderBy(crCourse.courseCode),
		db
			.select({
				courseCode: scheduleBlock.courseCode,
				component: scheduleBlock.component,
				originalDay: scheduleBlock.originalDay,
				day: scheduleBlock.day,
				startTime: scheduleBlock.startTime,
				endTime: scheduleBlock.endTime
			})
			.from(scheduleBlock),
		db
			.select({
				id: notification.id,
				fromUserName: notification.fromUserName,
				courseCode: notification.courseCode,
				message: notification.message,
				createdAt: notification.createdAt
			})
			.from(notification)
			.where(and(eq(notification.toUserId, user.id), eq(notification.dismissed, false)))
			.orderBy(notification.createdAt),
		// Which courses other CRs watch — drives the "heads up" modal before a move
		db.select({ courseCode: crCourse.courseCode }).from(crCourse).where(ne(crCourse.userId, user.id))
	]);

	const counts = new Map<string, number>();
	for (const row of othersWatching) counts.set(row.courseCode, (counts.get(row.courseCode) ?? 0) + 1);

	return {
		user,
		crBatches: batchResult,
		myCourses,
		savedSchedule: scheduleResult,
		notifications: notifResult.map((n) => ({ ...n, createdAt: n.createdAt.getTime() })),
		watchCounts: [...counts.entries()].map(([code, count]) => ({ code, count }))
	};
};
