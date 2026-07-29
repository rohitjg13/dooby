export * from './auth.schema';
export * from './app.schema';

import { pgTable, text, boolean, timestamp, index, serial, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { user } from './auth.schema';
import { batch } from './app.schema';

// CR access granted to an email that hasn't signed in yet. Claimed on that account's
// first request (see hooks.server.ts), which turns these into real cr_assignment rows.
export const pendingCr = pgTable('pending_cr', {
	id: serial('id').primaryKey(),
	email: text('email').notNull(),
	batchId: text('batch_id')
		.notNull()
		.references(() => batch.id, { onDelete: 'cascade' }),
	invitedBy: text('invited_by').references(() => user.id),
	createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => [
	index('pending_cr_email_idx').on(table.email),
	unique('pending_cr_email_batch_uniq').on(table.email, table.batchId)
]);

// Courses a CR has manually added to watch (searched from the timetable file).
// courseCode is the base code, e.g. "ECE204" — components are matched by prefix.
export const crCourse = pgTable('cr_course', {
	id: serial('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	courseCode: text('course_code').notNull(),
	courseName: text('course_name'),
	addedAt: timestamp('added_at').defaultNow().notNull()
}, (table) => [
	index('cr_course_userId_idx').on(table.userId),
	unique('cr_course_user_code_uniq').on(table.userId, table.courseCode)
]);

// Schedule blocks (timetable positions, modifiable by CR)
export const scheduleBlock = pgTable('schedule_block', {
	id: serial('id').primaryKey(),
	courseCode: text('course_code').notNull(),
	courseName: text('course_name').notNull(),
	component: text('component'),
	faculty: text('faculty'),
	room: text('room'),
	originalDay: text('original_day'),
	day: text('day').notNull(),
	startTime: text('start_time').notNull(),
	endTime: text('end_time').notNull(),
	batch: text('batch'),
	createdBy: text('created_by').references(() => user.id),
	updatedAt: timestamp('updated_at')
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull()
});

// Professor constraints (unavailability windows)
export const professorConstraint = pgTable('professor_constraint', {
	id: serial('id').primaryKey(),
	professorName: text('professor_name').notNull(),
	day: text('day').notNull(),
	startTime: text('start_time'),
	endTime: text('end_time'),
	allDay: boolean('all_day').default(false).notNull(),
	reason: text('reason'),
	createdBy: text('created_by').references(() => user.id),
	createdAt: timestamp('created_at').defaultNow().notNull()
});

// Relations
export const crCourseRelations = relations(crCourse, ({ one }) => ({
	user: one(user, { fields: [crCourse.userId], references: [user.id] })
}));
