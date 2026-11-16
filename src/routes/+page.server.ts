import { redirect } from '@sveltejs/kit';
import { eq, and, ne, count } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { crAssignment, batch, crCourse, scheduleBlock, notification, professorConstraint } from '$lib/server/db/schema';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(302, '/login');

	// Only what the page renders — the session row's timestamps and flags stay server-side
	const { id, name, email, role } = locals.user;
	const user = { id, name, email, role };
	const canManage = user.role === 'cr' || user.role === 'admin';

	// Users who signed in but haven't been made a CR yet see the waiting screen
	if (!canManage) {
		return { user, crBatches: [], myCourses: [], savedSchedule: [], constraints: [], notifications: [], watchCounts: [] };
	}

	const [batchResult, myCourses, scheduleResult, notifResult, watchCounts, constraints] = await Promise.all([
		db
			.select({
				batch: { id: batch.id, name: batch.name }
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
		// How many other CRs watch each course — drives the "heads up" modal before a move
		db
			.select({ code: crCourse.courseCode, count: count() })
			.from(crCourse)
			.where(ne(crCourse.userId, user.id))
			.groupBy(crCourse.courseCode),
		db
			.select({
				id: professorConstraint.id,
				professorName: professorConstraint.professorName,
				day: professorConstraint.day,
				startTime: professorConstraint.startTime,
				endTime: professorConstraint.endTime,
				allDay: professorConstraint.allDay,
				reason: professorConstraint.reason
			})
			.from(professorConstraint)
			.orderBy(professorConstraint.id)
	]);

	return {
		user,
		crBatches: batchResult,
		myCourses,
		savedSchedule: scheduleResult,
		notifications: notifResult.map((n) => ({ ...n, createdAt: n.createdAt.getTime() })),
		constraints,
		watchCounts
	};
};
