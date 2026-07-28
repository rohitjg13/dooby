# dooby

A stripped-down timetable planner for class representatives. No student accounts, no
preference collection — CRs pick the courses they care about themselves and rearrange the
weekly schedule around them.

It's a subsidised fork of noodle: same timetable engine, half the moving parts.

---

## What it does

**Class Representatives** get:

- **Courses** — search the master timetable by course code or name and add any course to a
  personal watch list. Each tracked course shows how badly it clashes with their own batch's
  schedule (red = lecture conflict, yellow = tutorial overlap).
- **Timetable** — a drag-and-drop weekly grid of their batch's classes, with tracked courses
  overlaid on top. Moves are saved server-side, shared live between CRs (5s polling), and
  undoable (last 3). "Show original" ghosts the pre-move positions.
- **Constraints** — mark a professor unavailable on a day or time range; the grid refuses
  drops into blocked slots.
- **Browse batch** — read-only view of any batch's weekly schedule.
- **Notifications** — when another CR moves a class that's in your batch or on your watch
  list, you get told.

**Admins** do everything a CR does, plus assign CR access at `/admin`.

Anyone else who signs in lands on a "waiting for access" screen until an admin assigns them
a batch.

---

## Differences from noodle

| noodle | dooby |
|---|---|
| student / cr / super_admin | pending / cr / admin |
| students submit minor + 3 ranked UWE preferences | no students at all |
| CR sees aggregated student demand | CR adds the courses they want to track, manually |
| demand ranking drives the timetable overlay | the CR's own list drives the overlay |
| "N students ranked this" move warning | "N other CRs are tracking this" move warning |
| lock/unlock student preferences | — |

Everything else — the timetable grid, conflict maths, overrides, constraints, live sync,
notifications — is carried over unchanged.

---

## Tech stack

- **SvelteKit** (Svelte 5, runes) + **Tailwind CSS v4**
- **PostgreSQL** via **Drizzle ORM**
- **Better Auth** with Google OAuth
- **TypeScript**

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Environment variables

Create a `.env` file:

```env
DATABASE_URL="postgres://user:password@host:port/db-name"
ORIGIN=""                # Base URL, e.g. http://localhost:5173
BETTER_AUTH_SECRET=""    # Random 32+ character string
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
```

Use a **separate database from noodle** — the schemas differ.

### 3. Push the database schema

```bash
npm run db:push
```

### 4. Add the timetable

Drop your timetable XLSX file into `src/lib/data/`. Batches are synced from it automatically
whenever the admin page loads.

### 5. Make yourself an admin

New accounts are created with role `pending`. After signing in once, promote yourself:

```sql
UPDATE "user" SET role = 'admin' WHERE email = 'you@example.com';
```

Then assign CRs from `/admin` — assigning a batch sets that account's role to `cr`.

### 6. Run

```bash
npm run dev
```

---

## Database commands

| Command | Description |
|---|---|
| `npm run db:push` | Push schema changes to the database |
| `npm run db:generate` | Generate migration files |
| `npm run db:studio` | Open Drizzle Studio (visual DB editor) |
| `npm run auth:schema` | Regenerate Better Auth tables |

---

## Roles

| Role | Access |
|---|---|
| `pending` | Signed in, waiting for an admin to assign a batch |
| `cr` | Track courses, edit the timetable, set constraints for assigned batches |
| `admin` | Everything above + assign/remove CRs |
