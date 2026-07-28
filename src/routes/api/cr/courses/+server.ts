import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { crCourse } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';

function canManage(user: App.Locals['user']) {
	return user?.role === 'cr' || user?.role === 'admin';
}

// GET /api/cr/courses — the signed-in CR's watched courses
export const GET: RequestHandler = async ({ locals }) => {
	if (!canManage(locals.user)) return json({ error: 'Forbidden' }, { status: 403 });
	const courses = await db
		.select()
		.from(crCourse)
		.where(eq(crCourse.userId, locals.user!.id))
		.orderBy(crCourse.courseCode);
	return json({ courses });
};

// POST /api/cr/courses — add one course by base code
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!canManage(locals.user)) return json({ error: 'Forbidden' }, { status: 403 });

	const { courseCode, courseName } = await request.json();
	const code = String(courseCode ?? '').trim().toUpperCase();
	if (!code) return json({ error: 'courseCode required' }, { status: 400 });

	const [row] = await db
		.insert(crCourse)
		.values({ userId: locals.user!.id, courseCode: code, courseName: courseName ?? null })
		.onConflictDoNothing()
		.returning();

	// onConflictDoNothing returns nothing when the CR already had it — that's still success
	return json({ course: row ?? { courseCode: code, courseName: courseName ?? null } });
};

// DELETE /api/cr/courses — remove one course by base code
export const DELETE: RequestHandler = async ({ locals, request }) => {
	if (!canManage(locals.user)) return json({ error: 'Forbidden' }, { status: 403 });

	const { courseCode } = await request.json();
	const code = String(courseCode ?? '').trim().toUpperCase();
	if (!code) return json({ error: 'courseCode required' }, { status: 400 });

	await db.delete(crCourse).where(and(eq(crCourse.userId, locals.user!.id), eq(crCourse.courseCode, code)));
	return json({ success: true });
};
