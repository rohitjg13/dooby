<script lang="ts">
	import { browser } from '$app/environment';
	import type { Course, ConflictLevel } from '$lib/types';
	import { parseDays, timeToMinutes, minutesToTime, getConflictLevel, countConflicts } from '$lib/types';

	let { data } = $props();

	const isAdmin = data.user.role === 'admin';
	const canManage = data.user.role === 'cr' || isAdmin;
	// Courses other CRs track — drives the heads-up modal before moving a class
	const watchCounts: { code: string; count: number }[] = data.watchCounts ?? [];

	let activeTab = $state<'courses' | 'timetable' | 'settings' | 'browse'>('courses');

	// Course catalogue from the timetable file
	let courses = $state<Course[]>([]);
	let loadingCourses = $state(true);

	// This CR's manually added courses
	let myCourses = $state<{ courseCode: string; courseName: string | null }[]>(data.myCourses ?? []);
	let search = $state('');
	let addingCode = $state('');

	// Constraints
	let constraints = $state<{ id: number; professorName: string; day: string; startTime: string | null; endTime: string | null; allDay: boolean; reason?: string | null }[]>([]);
	let loadingCR = $state(true);

	// Notifications
	let notifications = $state<{ id: string; fromUserName: string; courseCode: string; message: string; createdAt: number }[]>(data.notifications ?? []);

	// Timetable state
	let dragCourse = $state<Course | null>(null);
	let dragOriginalDay = $state('');
	let dragIsOverlay = $state(false);
	let dragOffsetY = $state(0);
	let dragOverSlot = $state<{ day: string; startMin: number } | null>(null);

	// Touch drag state (mobile)
	let touchDragCourse = $state<Course | null>(null);
	let touchDragOriginalDay = $state('');
	let touchDragIsOverlay = $state(false);
	let touchDragOffsetX = $state(0);
	let touchDragOffsetY = $state(0);
	let touchX = $state(0);
	let touchY = $state(0);
	let touchGhostW = $state(0);
	let touchGhostH = $state(0);
	type PendingDrop = { course: Course; origDay: string; day: string; newStart: string; newEnd: string };
	let moveWarnModal = $state<{ courseCode: string; count: number; pending: PendingDrop } | null>(null);
	// Override key: `courseCode|component|originalDay` — each day-slot independently overridable
	// Initialize from server-loaded data so overrides are available on first render
	function buildOverrideMapFromArray(blocks: { courseCode: string; component?: string | null; originalDay?: string | null; day: string; startTime: string; endTime: string }[]) {
		const map = new Map<string, { day: string; startTime: string; endTime: string }>();
		for (const b of blocks) {
			const origDay = b.originalDay ?? b.day;
			map.set(`${b.courseCode}|${b.component ?? ''}|${origDay}`, { day: b.day, startTime: b.startTime, endTime: b.endTime });
		}
		return map;
	}
	let scheduleOverrides = $state(buildOverrideMapFromArray(data.savedSchedule ?? []));
	// XLSX original positions before any overrides
	let xlsxOriginals = $state<Map<string, { day: string; startTime: string; endTime: string }>>(new Map());
	let showOriginals = $state(true); // ghosts of pre-move positions are on unless toggled off
	let syncStatus = $state<'idle' | 'saving' | 'saved' | 'error' | 'polling'>('idle');
	let lastSyncedAt = $state(0);
	// Undo/redo history for moves — session-only, max 3 entries. Entries store absolute
	// positions (not map refs) so they survive the polling rebuild of scheduleOverrides.
	type MovePos = { day: string; startTime: string; endTime: string };
	type MoveEntry = { key: string; course: Course; origDay: string; before: MovePos | null; after: MovePos };
	let undoStack = $state<MoveEntry[]>([]);
	let redoStack = $state<MoveEntry[]>([]);
	// Time range extension (in whole hours, relative to auto-detected range)
	let extraHoursBefore = $state(0);
	let extraHoursAfter = $state(1); // start with 1hr extra at the end
	let toast = $state('');
	let toastTimeout: ReturnType<typeof setTimeout>;

	// Theme (dark default, persisted in localStorage; initial attribute is set in app.html)
	let theme = $state<'dark' | 'light'>('dark');
	$effect(() => {
		theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
	});
	function toggleTheme() {
		theme = theme === 'light' ? 'dark' : 'light';
		document.documentElement.setAttribute('data-theme', theme);
		try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
	}

	// Constraint form
	let profName = $state('');
	let profSuggestOpen = $state(false);
	let constraintDay = $state('Monday');
	let allDay = $state(false);
	let cStartTime = $state('09:00');
	let cEndTime = $state('17:00');
	let cReason = $state('');
	let savingConstraint = $state(false);

	// Professor picker — names + their course codes from the XLSX faculty column.
	// Faculty cells can hold "Name[1234567]" id suffixes and comma-separated multiple profs.
	function normalizeFaculty(raw: string): string[] {
		return raw.split(',').map((p) => p.replace(/\[[^\]]*\]/g, '').trim()).filter(Boolean);
	}
	let professorOptions = $derived(() => {
		const map = new Map<string, { name: string; codes: Set<string> }>();
		for (const c of courses) {
			if (!c.faculty) continue;
			const base = c.courseCode.split('-')[0];
			for (const name of normalizeFaculty(c.faculty)) {
				const key = name.toUpperCase();
				const entry = map.get(key) ?? { name, codes: new Set<string>() };
				entry.codes.add(base);
				map.set(key, entry);
			}
		}
		return [...map.values()]
			.map((e) => ({ name: e.name, codes: [...e.codes].sort() }))
			.sort((a, b) => a.name.localeCompare(b.name));
	});
	let profSuggestions = $derived(() => {
		if (!profSuggestOpen) return [];
		const q = profName.trim().toUpperCase();
		const opts = professorOptions();
		const matches = q
			? opts.filter((p) => p.name.toUpperCase().includes(q) || p.codes.some((c) => c.toUpperCase().includes(q)))
			: opts;
		return matches.slice(0, 12);
	});

	function showToast(msg: string) {
		toast = msg;
		clearTimeout(toastTimeout);
		toastTimeout = setTimeout(() => (toast = ''), 3000);
	}

	// ---------- Browse tab: any batch's timetable, read-only ----------
	let batchInputs = $state<string[]>(['']);
	let batchSuggestions = $state<string[][]>([[]]);
	let selectedBatches = $state<string[]>([]);

	let allBatches = $derived(() => {
		const set = new Set<string>();
		courses.forEach((c) => {
			if (c.major) c.major.split(/[\s,]+/).forEach((b) => { if (b.trim()) set.add(b.trim().toUpperCase()); });
		});
		return [...set].sort();
	});

	function getSuggestions(input: string): string[] {
		if (!input || input.length < 1) return [];
		const q = input.toUpperCase();
		return allBatches().filter((b) => b.includes(q) && b !== q).slice(0, 12);
	}

	function onBatchInput(i: number) {
		batchSuggestions[i] = getSuggestions(batchInputs[i]);
		batchSuggestions = [...batchSuggestions];
	}

	function selectBatchSuggestion(i: number, val: string) {
		batchInputs[i] = val;
		batchSuggestions[i] = [];
		batchInputs = [...batchInputs];
		batchSuggestions = [...batchSuggestions];
	}

	function addBatchInput() {
		if (batchInputs.length >= 4) return;
		batchInputs = [...batchInputs, ''];
		batchSuggestions = [...batchSuggestions, []];
	}

	function removeBatchInput(i: number) {
		batchInputs = batchInputs.filter((_, idx) => idx !== i);
		batchSuggestions = batchSuggestions.filter((_, idx) => idx !== i);
	}

	function loadBatches() {
		const valid = batchInputs.map((b) => b.trim().toUpperCase()).filter(Boolean);
		if (!valid.length) return;
		selectedBatches = valid;
	}

	let browseCourses = $derived(
		courses.filter((c) => {
			if (!c.major || !selectedBatches.length) return false;
			const majors = c.major.toUpperCase().split(/[\s,]+/);
			return selectedBatches.some((ub) => majors.some((m) => m.includes(ub) || ub.includes(m)));
		})
	);
	let browseBlocks = $derived(() => {
		const blocks: { course: Course; day: string; startMin: number; endMin: number }[] = [];
		for (const c of browseCourses) {
			if (!c.day || !c.startTime || !c.endTime) continue;
			const days = parseDays(c.day);
			const s = timeToMinutes(c.startTime);
			const e = timeToMinutes(c.endTime);
			if (s >= e) continue;
			for (const d of days) blocks.push({ course: c, day: d, startMin: s, endMin: e });
		}
		return blocks;
	});
	let sMinT = $derived(Math.min(...(browseBlocks().map((b) => b.startMin).length ? browseBlocks().map((b) => b.startMin) : [480])));
	let sMaxT = $derived(Math.max(...(browseBlocks().map((b) => b.endMin).length ? browseBlocks().map((b) => b.endMin) : [1080])));
	let sRMin = $derived(Math.floor(sMinT / 60) * 60);
	let sRMax = $derived(Math.ceil(sMaxT / 60) * 60);
	let sTotalMin = $derived(sRMax - sRMin);
	let sTimeLabels = $derived(Array.from({ length: Math.floor(sTotalMin / 60) + 1 }, (_, i) => ({ mins: sRMin + i * 60, label: minutesToTime(sRMin + i * 60) })));

	// ---------- Course watch list ----------
	// Every course row that actually has a scheduled slot
	let scheduledCourses = $derived(courses.filter((c) => c.day && c.startTime && c.endTime));

	// Search the timetable file — one hit per base course code
	let searchResults = $derived(() => {
		const q = search.trim().toUpperCase();
		if (q.length < 2) return [];
		const watched = new Set(myCourses.map((c) => c.courseCode));
		const seen = new Set<string>();
		const out: { code: string; name: string; watched: boolean }[] = [];
		for (const c of courses) {
			const base = c.courseCode.split('-')[0].toUpperCase();
			if (seen.has(base)) continue;
			if (!base.includes(q) && !(c.courseName ?? '').toUpperCase().includes(q)) continue;
			seen.add(base);
			out.push({ code: base, name: c.courseName, watched: watched.has(base) });
			if (out.length >= 20) break;
		}
		return out;
	});

	async function addCourse(code: string, name: string) {
		if (myCourses.some((c) => c.courseCode === code)) return;
		addingCode = code;
		const res = await fetch('/api/cr/courses', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ courseCode: code, courseName: name })
		});
		addingCode = '';
		if (!res.ok) { showToast('could not add course'); return; }
		myCourses = [...myCourses, { courseCode: code, courseName: name }];
		enabledCourses = new Set([...enabledCourses, code]);
		showToast(`${code} added`);
	}

	async function removeCourse(code: string) {
		const prev = myCourses;
		myCourses = myCourses.filter((c) => c.courseCode !== code);
		const next = new Set(enabledCourses);
		next.delete(code);
		enabledCourses = next;
		const res = await fetch('/api/cr/courses', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ courseCode: code })
		});
		if (!res.ok) { myCourses = prev; showToast('could not remove course'); }
	}

	// All scheduled rows of a course (its LEC + TUT + PRAC components, and every day each
	// meets), matched by base code and deduped by component+day+time. A student attends ALL
	// of these, so the course's conflict is the WORST across every row — never the best.
	// (The component is part of the full courseCode, e.g. "ART210/AMP1001-LEC1".)
	function courseBaseRows(baseCode: string): Course[] {
		const rows: Course[] = [];
		const seen = new Set<string>();
		for (const c of scheduledCourses) {
			if (c.courseCode.split('-')[0].toUpperCase() !== baseCode.toUpperCase()) continue;
			const sig = `${c.component ?? ''}|${c.day}|${c.startTime}`;
			if (seen.has(sig)) continue;
			seen.add(sig);
			rows.push(c);
		}
		return rows;
	}

	function getTrafficLight(courseCode: string): ConflictLevel {
		const rows = courseBaseRows(courseCode);
		if (!rows.length) return 'green';
		// Worst conflict across every component/row of the course (don't clash with self)
		const relevant = crBatchCourses().filter((k) => k.courseCode.split('-')[0].toUpperCase() !== courseCode.toUpperCase());
		let level: ConflictLevel = 'green';
		for (const v of rows) {
			const l = getConflictLevel(v, relevant);
			if (l === 'red') return 'red';
			if (l === 'yellow') level = 'yellow';
		}
		return level;
	}

	// Adjusted traffic light map — recomputes reactively when scheduleOverrides changes.
	// Uses overridden positions for both the tracked course and the batch courses, so a
	// conflict the CR has already dragged away shows as cleared.
	let adjustedConflictMap = $derived(() => {
		const map = new Map<string, ConflictLevel>();
		if (scheduleOverrides.size === 0) return map;

		const adjustedCores = adjustedCrCores();

		for (const item of myCourses) {
			const orig = getTrafficLight(item.courseCode);
			if (orig === 'green') continue; // already fine, skip
			const relevant = adjustedCores.filter((k) => k.courseCode.split('-')[0].toUpperCase() !== item.courseCode.toUpperCase());
			let level: ConflictLevel = 'green';
			outer: for (const v of courseBaseRows(item.courseCode)) {
				for (const slot of adjustedSlotsOf(v)) {
					const slotLevel = getConflictLevel(slot, relevant);
					if (slotLevel === 'red') { level = 'red'; break outer; }
					if (slotLevel === 'yellow') level = 'yellow';
				}
			}
			map.set(item.courseCode, level);
		}
		return map;
	});

	// Expand a course into one entry per day, with schedule overrides applied
	function adjustedSlotsOf(c: Course): Course[] {
		const slots: Course[] = [];
		for (const origDay of parseDays(c.day || '')) {
			const override = scheduleOverrides.get(`${c.courseCode}|${c.component ?? ''}|${origDay}`);
			slots.push(override ? { ...c, day: override.day, startTime: override.startTime, endTime: override.endTime } : { ...c, day: origDay });
		}
		return slots;
	}

	// All CR-batch courses (across every assigned batch, deduped) with overrides applied,
	// expanded one entry per day-slot. Spanning all batches is how multiple batches are
	// taken into consideration; dedup avoids counting a class shared by two batches twice.
	let adjustedCrCores = $derived(() => {
		const out: Course[] = [];
		for (const c of crBatchCourses()) out.push(...adjustedSlotsOf(c));
		return out;
	});

	// Conflict counts per tracked course: red/yellow overlaps summed over EVERY component,
	// row and day-slot of the course against the CR's (override-adjusted) batch timetable.
	// A student attends all components, so every overlap counts — none are masked.
	let courseConflicts = $derived(() => {
		const map = new Map<string, { red: number; yellow: number; score: number }>();
		const cores = adjustedCrCores();
		for (const item of myCourses) {
			const relevant = cores.filter((k) => k.courseCode.split('-')[0].toUpperCase() !== item.courseCode.toUpperCase());
			let red = 0, yellow = 0;
			for (const v of courseBaseRows(item.courseCode)) {
				for (const slot of adjustedSlotsOf(v)) {
					const counts = countConflicts(slot, relevant);
					red += counts.red;
					yellow += counts.yellow;
				}
			}
			map.set(item.courseCode, { red, yellow, score: red * 2 + yellow });
		}
		return map;
	});

	// CR batch names (all assigned batches)
	let crBatchNames = $derived(
		(data.crBatches ?? []).map((b: { batch: { name: string } }) => b.batch.name.toUpperCase())
	);

	// Which of the CR's batches the grid is showing — any combination of them.
	// Empty set means all assigned batches. Lectures are tagged with the year batch
	// (BIO1YR) while their tutorials and practicals are tagged with the sub-batch
	// (BIO11 / BIO12), so this is also how you switch which TUT/PRAC sections show.
	let batchViews = $state<Set<string>>(new Set());
	let viewedBatchNames = $derived(batchViews.size ? [...batchViews] : crBatchNames);

	function toggleBatchView(bn: string) {
		const next = new Set(batchViews);
		if (next.has(bn)) next.delete(bn);
		else next.add(bn);
		batchViews = next;
	}

	// CR timetable: all courses matching ANY viewed batch, deduped
	function matchesCRBatch(major: string): boolean {
		if (!major || !viewedBatchNames.length) return false;
		const majors = major.toUpperCase().split(/[\s,]+/);
		return viewedBatchNames.some((bn: string) => majors.some((m: string) => m === bn));
	}

	// TUT/PRAC rows belong to a specific sub-batch — label the block with it so two
	// practicals of the same course are tellable apart when viewing all batches.
	function sectionBatch(c: Course): string {
		const comp = (c.component ?? '').toUpperCase();
		if (!comp.startsWith('TUT') && !comp.startsWith('PRAC')) return '';
		return (c.major || '').trim().toUpperCase();
	}

	// Short classes get a block too small for their own name, so the full details go in a
	// hover tooltip and — since hover doesn't exist on touch — in a toast when tapped.
	function blockDetails(c: Course): string {
		return [
			`${c.courseCode.split('-')[0]} — ${c.courseName}`,
			c.component,
			sectionBatch(c),
			c.room,
			normalizeFaculty(c.faculty || '').join(', ')
		].filter(Boolean).join(' · ');
	}

	// Hover card for timetable blocks. One shared element positioned at the cursor rather
	// than a child of the block, which would be clipped by the block's own overflow:hidden.
	let hoverInfo = $state<{ text: string; warn: string | null; x: number; y: number } | null>(null);

	function hoverAt(e: MouseEvent, c: Course, warn: string | null) {
		// Flip the card to the other side of the cursor near the viewport edge
		const x = e.clientX + 360 > window.innerWidth ? e.clientX - 350 : e.clientX + 14;
		const y = e.clientY + 110 > window.innerHeight ? e.clientY - 100 : e.clientY + 16;
		hoverInfo = { text: blockDetails(c), warn, x: Math.max(8, x), y: Math.max(8, y) };
	}

	// Deduplicated batch courses (overrides applied per day-slot in calendarBlocks)
	let crBatchCourses = $derived(() => {
		const seen = new Set<string>();
		const result: Course[] = [];
		for (const c of scheduledCourses) {
			if (!matchesCRBatch(c.major)) continue;
			const dedupKey = `${c.courseCode}|${c.component ?? ''}`;
			if (seen.has(dedupKey)) continue;
			seen.add(dedupKey);
			result.push(c);
		}
		return result;
	});

	// Capture XLSX original positions once courses load (keyed per day-slot)
	$effect(() => {
		if (courses.length > 0 && xlsxOriginals.size === 0) {
			const map = new Map<string, { day: string; startTime: string; endTime: string }>();
			for (const c of courses) {
				if (!c.day || !c.startTime || !c.endTime) continue;
				for (const d of parseDays(c.day)) {
					const key = `${c.courseCode}|${c.component ?? ''}|${d}`;
					if (!map.has(key)) map.set(key, { day: d, startTime: c.startTime, endTime: c.endTime });
				}
			}
			xlsxOriginals = map;
		}
	});

	// Ghost blocks: original positions of moved courses (key = courseCode|component|originalDay)
	type GhostBlock = { courseCode: string; courseName: string; day: string; startMin: number; endMin: number };
	let ghostBlocks = $derived(() => {
		if (!showOriginals) return [] as GhostBlock[];
		const blocks: GhostBlock[] = [];
		for (const [key, override] of scheduleOverrides) {
			const orig = xlsxOriginals.get(key);
			if (!orig) continue;
			if (orig.day === override.day && orig.startTime === override.startTime) continue; // not moved
			const s = timeToMinutes(orig.startTime);
			const e = timeToMinutes(orig.endTime);
			if (s >= e) continue;
			const courseCode = key.split('|')[0];
			const matchCourse = courses.find((c) => c.courseCode === courseCode);
			// orig.day is already a single day (key includes originalDay)
			blocks.push({ courseCode, courseName: matchCourse?.courseName ?? courseCode, day: orig.day, startMin: s, endMin: e });
		}
		return blocks;
	});

	// Tracked-course overlay on the CR timetable — everything added starts visible
	let enabledCourses = $state<Set<string>>(new Set((data.myCourses ?? []).map((c: { courseCode: string }) => c.courseCode)));

	// Extract dept prefix: letters before any digit/dash/space, e.g. "ECE204" → "ECE", "PHL" → "PHL"
	function deptPrefix(code: string) { return code.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? code; }

	function relativeTime(epoch: number): string {
		const diff = Date.now() - epoch;
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		return `${Math.floor(hours / 24)}d ago`;
	}

	// Watch-list ordering, shared by the courses table and the overlay chips
	let listSort = $state<'course' | 'conflict'>('course');
	let sortedMyCourses = $derived(() => {
		const list = [...myCourses];
		if (listSort === 'conflict') {
			return list.sort((a, b) => {
				const ca = courseConflicts().get(a.courseCode)?.score ?? 0;
				const cb = courseConflicts().get(b.courseCode)?.score ?? 0;
				if (ca !== cb) return ca - cb;
				return a.courseCode.localeCompare(b.courseCode);
			});
		}
		return list.sort((a, b) => a.courseCode.localeCompare(b.courseCode));
	});

	function toggleCourseOverlay(code: string) {
		const next = new Set(enabledCourses);
		if (next.has(code)) next.delete(code);
		else next.add(code);
		enabledCourses = next;
	}

	// Overlay course rows — one entry per row (multi-day applied in calendarBlocks)
	let overlayCourses = $derived(() => {
		if (!enabledCourses.size) return [];
		const seen = new Set<string>();
		const result: Course[] = [];
		for (const c of scheduledCourses) {
			const base = c.courseCode.split('-')[0].toUpperCase();
			if (!enabledCourses.has(base)) continue;
			const dedupKey = `${c.courseCode}|${c.component ?? ''}`;
			if (seen.has(dedupKey)) continue;
			seen.add(dedupKey);
			result.push(c);
		}
		return result;
	});

	// Calendar — combined batch courses + tracked-course overlays
	const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
	// originalDay = XLSX source day (used as override key); day = current rendered day (after override)
	type CalBlock = { course: Course; day: string; originalDay: string; startMin: number; endMin: number; isUWE: boolean };

	let calendarBlocks = $derived(() => {
		const blocks: CalBlock[] = [];
		const seen = new Set<string>();

		function addCourse(c: Course, isUWE: boolean) {
			const origDays = parseDays(c.day || '');
			const baseS = timeToMinutes(c.startTime || '');
			const baseE = timeToMinutes(c.endTime || '');
			if (baseS >= baseE) return;
			for (const origDay of origDays) {
				const overrideKey = `${c.courseCode}|${c.component ?? ''}|${origDay}`;
				const override = scheduleOverrides.get(overrideKey);
				const day = override?.day ?? origDay;
				const startMin = override ? timeToMinutes(override.startTime) : baseS;
				const endMin = override ? timeToMinutes(override.endTime) : baseE;
				const blockKey = `${c.courseCode}|${day}|${startMin}|${endMin}`;
				if (seen.has(blockKey)) continue;
				seen.add(blockKey);
				const course = override ? { ...c, day, startTime: override.startTime, endTime: override.endTime } : c;
				blocks.push({ course, day, originalDay: origDay, startMin, endMin, isUWE });
			}
		}

		for (const c of crBatchCourses()) addCourse(c, false);
		for (const c of overlayCourses()) addCourse(c, true);
		return blocks;
	});

	// Dept filter for the CR timetable grid
	let ttDeptFilter = $state('');
	let ttDepts = $derived([...new Set(crBatchCourses().map((c) => deptPrefix(c.courseCode)))].sort());
	let filteredCalendarBlocks = $derived(() =>
		ttDeptFilter ? calendarBlocks().filter((b) => deptPrefix(b.course.courseCode) === ttDeptFilter) : calendarBlocks()
	);

	// Time range stays based on unfiltered blocks so the axis doesn't jump when filtering
	let minT = $derived(Math.min(...(calendarBlocks().map((b) => b.startMin).length ? calendarBlocks().map((b) => b.startMin) : [480])));
	let maxT = $derived(Math.max(...(calendarBlocks().map((b) => b.endMin).length ? calendarBlocks().map((b) => b.endMin) : [1080])));
	let rMin = $derived(Math.floor(minT / 60) * 60);
	let rMax = $derived(Math.ceil(maxT / 60) * 60);
	// Displayed range with user-controlled extension
	let tDispMin = $derived(Math.max(0, rMin - extraHoursBefore * 60));
	let tDispMax = $derived(Math.min(1440, rMax + extraHoursAfter * 60));
	let totalMin = $derived(tDispMax - tDispMin);
	let timeLabels = $derived(Array.from({ length: Math.floor(totalMin / 60) + 1 }, (_, i) => ({ mins: tDispMin + i * 60, label: minutesToTime(tDispMin + i * 60) })));

	// A block violates a constraint when its own professor is flagged unavailable on the same
	// day and time. Faculty cells may list multiple profs with bracketed IDs, so normalize first.
	function blockConstraintViolation(course: Course, day: string, startMin: number, endMin: number): string | null {
		const profs = normalizeFaculty(course.faculty || '').map((p) => p.toUpperCase());
		if (!profs.length) return null;
		for (const c of constraints) {
			if (c.day !== day) continue;
			if (!profs.includes(c.professorName.toUpperCase())) continue;
			if (c.allDay) return c.professorName;
			if (c.startTime && c.endTime) {
				const cs = timeToMinutes(c.startTime), ce = timeToMinutes(c.endTime);
				if (startMin < ce && cs < endMin) return c.professorName;
			}
		}
		return null;
	}

	// Fetch data
	$effect(() => {
		if (!canManage) return;
		fetch('/api/timetable').then((r) => r.json()).then((d) => { courses = d.courses ?? []; }).catch(() => {}).finally(() => (loadingCourses = false));
		fetch('/api/cr/constraints')
			.then((r) => r.json())
			.then((c) => { constraints = c.constraints ?? []; })
			.catch(() => {})
			.finally(() => (loadingCR = false));

		// Load saved schedule overrides (key: courseCode|component|originalDay)
		fetchOverrides();
	});

	async function fetchOverrides() {
		try {
			const r = await fetch('/api/cr/schedule');
			if (!r.ok) return;
			const d = await r.json();
			// Don't overwrite an in-flight optimistic update — the save will either
			// commit (and re-poll will pick it up) or roll back on its own.
			if (syncStatus === 'saving') return;
			scheduleOverrides = buildOverrideMapFromArray(d.blocks ?? []);
			lastSyncedAt = Date.now();
		} catch { /* ignore */ }
	}

	// Poll for live sync when timetable tab is open
	$effect(() => {
		if (activeTab !== 'timetable' || !canManage) return;
		const interval = setInterval(async () => {
			if (syncStatus === 'saving') return; // don't poll while saving
			await fetchOverrides();
		}, 5000);
		return () => clearInterval(interval);
	});

	// Overlay overlap cycling: key = "day|startMin|endMin"
	let uweGroupActive = $state(new Map<string, number>());
	function cycleUwe(key: string, total: number, e: MouseEvent) {
		e.stopPropagation();
		const cur = uweGroupActive.get(key) ?? 0;
		uweGroupActive = new Map(uweGroupActive).set(key, (cur + 1) % total);
	}

	// Constraint management
	async function addConstraint() {
		if (!profName.trim()) return;
		savingConstraint = true;
		const res = await fetch('/api/cr/constraints', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ professorName: profName.trim(), day: constraintDay, allDay, startTime: allDay ? null : cStartTime, endTime: allDay ? null : cEndTime, reason: cReason.trim() || null })
		});
		if (res.ok) { const d = await res.json(); constraints = [...constraints, d.constraint]; profName = ''; cReason = ''; }
		savingConstraint = false;
	}

	async function removeConstraint(id: number) {
		await fetch('/api/cr/constraints', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
		constraints = constraints.filter((c) => c.id !== id);
	}

	// Drag and drop (5-minute snap, top-of-block anchor)
	const CELL_H = 56;
	const SNAP = 5;
	let lastDragUpdate = 0;

	function snapMin(rawMin: number): number {
		return Math.round(rawMin / SNAP) * SNAP;
	}

	function onDragStart(e: DragEvent, course: Course, originalDay: string, isUWE: boolean) {
		dragCourse = course;
		dragOriginalDay = originalDay;
		dragIsOverlay = isUWE;
		dragOffsetY = e.offsetY;
	}

	function onTouchStart(e: TouchEvent, course: Course, originalDay: string, isUWE: boolean) {
		if (isUWE) return;
		const touch = e.touches[0];
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		touchDragCourse = course;
		touchDragOriginalDay = originalDay;
		touchDragIsOverlay = isUWE;
		touchDragOffsetX = touch.clientX - rect.left;
		touchDragOffsetY = touch.clientY - rect.top;
		touchX = touch.clientX;
		touchY = touch.clientY;
		touchGhostW = rect.width;
		touchGhostH = rect.height;
	}

	function handleTouchMove(e: TouchEvent) {
		if (!touchDragCourse) return;
		e.preventDefault();
		const touch = e.touches[0];
		touchX = touch.clientX;
		touchY = touch.clientY;

		const el = document.elementFromPoint(touch.clientX, touch.clientY);
		const cell = el?.closest('[data-day][data-hstart]') as HTMLElement | null;
		if (cell) {
			const day = cell.dataset.day!;
			const hStart = parseInt(cell.dataset.hstart!);
			const rect = cell.getBoundingClientRect();
			const topY = (touch.clientY - rect.top) - touchDragOffsetY;
			const newMin = snapMin(hStart + (topY / CELL_H) * 60);
			if (dragOverSlot?.day !== day || dragOverSlot?.startMin !== newMin) {
				dragOverSlot = { day, startMin: newMin };
			}
		} else {
			dragOverSlot = null;
		}
	}

	function handleTouchEnd(e: TouchEvent) {
		if (!touchDragCourse) return;
		const touch = e.changedTouches[0];
		const el = document.elementFromPoint(touch.clientX, touch.clientY);
		const cell = el?.closest('[data-day][data-hstart]') as HTMLElement | null;

		const course = touchDragCourse;
		const origDay = touchDragOriginalDay;
		const isUWE = touchDragIsOverlay;
		touchDragCourse = null;
		touchDragOriginalDay = '';
		touchDragIsOverlay = false;
		dragOverSlot = null;

		if (!cell) return;
		const day = cell.dataset.day!;
		const hStart = parseInt(cell.dataset.hstart!);
		const rect = cell.getBoundingClientRect();
		const topY = (touch.clientY - rect.top) - touchDragOffsetY;
		const dropMin = snapMin(hStart + (topY / CELL_H) * 60);

		const dur = timeToMinutes(course.endTime || '') - timeToMinutes(course.startTime || '');
		const blockedBy = blockConstraintViolation(course, day, dropMin, dropMin + dur);
		if (blockedBy) { showToast(`Prof. ${blockedBy} is unavailable then`); return; }

		const newStart = minutesToTime(dropMin);
		const newEnd = minutesToTime(dropMin + dur);

		if (!isUWE) {
			const baseCode = course.courseCode.split('-')[0].toUpperCase();
			const hit = watchCounts.find((c) => c.code.toUpperCase() === baseCode);
			if (hit) {
				moveWarnModal = { courseCode: hit.code, count: hit.count, pending: { course, origDay, day, newStart, newEnd } };
				return;
			}
		}
		applyDrop(course, origDay, day, newStart, newEnd);
	}

	$effect(() => {
		if (!browser) return;
		window.addEventListener('touchmove', handleTouchMove, { passive: false });
		window.addEventListener('touchend', handleTouchEnd);
		return () => {
			window.removeEventListener('touchmove', handleTouchMove);
			window.removeEventListener('touchend', handleTouchEnd);
		};
	});

	function onDragOver(e: DragEvent, day: string, hStart: number) {
		e.preventDefault();
		// Throttle state updates to ~30fps to prevent lag
		const now = performance.now();
		if (now - lastDragUpdate < 33) return;
		lastDragUpdate = now;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const topY = (e.clientY - rect.top) - dragOffsetY;
		const newMin = snapMin(hStart + (topY / CELL_H) * 60);
		// Only update state if the snap position actually changed
		if (dragOverSlot?.day === day && dragOverSlot?.startMin === newMin) return;
		dragOverSlot = { day, startMin: newMin };
	}

	async function onDrop(e: DragEvent, day: string, hStart: number) {
		e.preventDefault();
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const topY = (e.clientY - rect.top) - dragOffsetY;
		const rawMin = hStart + (topY / CELL_H) * 60;
		const dropMin = snapMin(rawMin);
		dragOverSlot = null;
		if (!dragCourse) return;
		const dur = timeToMinutes(dragCourse.endTime || '') - timeToMinutes(dragCourse.startTime || '');
		const blockedBy = blockConstraintViolation(dragCourse, day, dropMin, dropMin + dur);
		if (blockedBy) { showToast(`Prof. ${blockedBy} is unavailable then`); dragCourse = null; return; }

		const newStart = minutesToTime(dropMin);
		const newEnd = minutesToTime(dropMin + dur);

		const course = dragCourse;
		const origDay = dragOriginalDay;
		const isUWE = dragIsOverlay;
		dragCourse = null;
		dragOriginalDay = '';
		dragIsOverlay = false;

		// If moving a class another CR is tracking, warn first
		if (!isUWE) {
			const baseCode = course.courseCode.split('-')[0].toUpperCase();
			const hit = watchCounts.find((c) => c.code.toUpperCase() === baseCode);
			if (hit) {
				moveWarnModal = { courseCode: hit.code, count: hit.count, pending: { course, origDay, day, newStart, newEnd } };
				return; // wait for confirm/cancel
			}
		}

		await applyDrop(course, origDay, day, newStart, newEnd);
	}

	function cancelDrop() { moveWarnModal = null; }

	async function confirmDrop() {
		if (!moveWarnModal) return;
		const { course, origDay, day, newStart, newEnd } = moveWarnModal.pending;
		moveWarnModal = null;
		await applyDrop(course, origDay, day, newStart, newEnd);
	}

	async function dismissNotification(id: string) {
		notifications = notifications.filter((n) => n.id !== id);
		fetch('/api/notifications', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id })
		});
	}

	function scheduleBody(course: Course, origDay: string, pos: MovePos) {
		return {
			courseCode: course.courseCode,
			component: course.component ?? '',
			originalDay: origDay,
			batch: (course.major || '').toUpperCase().split(/[\s,]+/).find((m) => crBatchNames.includes(m)) ?? course.major,
			day: pos.day,
			startTime: pos.startTime,
			endTime: pos.endTime,
			courseName: course.courseName,
			faculty: course.faculty,
			room: course.room
		};
	}

	function setOverride(key: string, pos: MovePos | null) {
		const m = new Map(scheduleOverrides);
		if (pos) m.set(key, pos);
		else m.delete(key);
		scheduleOverrides = m;
	}

	async function applyDrop(course: Course, origDay: string, day: string, newStart: string, newEnd: string) {
		const overrideKey = `${course.courseCode}|${course.component ?? ''}|${origDay}`;
		const prevOverride = scheduleOverrides.get(overrideKey);
		const after: MovePos = { day, startTime: newStart, endTime: newEnd };

		// Optimistic update — apply immediately so UI moves before API responds
		setOverride(overrideKey, after);

		syncStatus = 'saving';
		try {
			const res = await fetch('/api/cr/schedule', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(scheduleBody(course, origDay, after))
			});
			if (res.ok) {
				undoStack = [...undoStack, { key: overrideKey, course, origDay, before: prevOverride ?? null, after }].slice(-3);
				redoStack = [];
				lastSyncedAt = Date.now();
				syncStatus = 'saved';
				setTimeout(() => (syncStatus = 'idle'), 2500);
				// Notify co-managing CRs and any CR tracking this course
				fetch('/api/cr/notify', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ courseCode: course.courseCode.split('-')[0], major: course.major })
				});
			} else {
				setOverride(overrideKey, prevOverride ?? null);
				syncStatus = 'error';
				setTimeout(() => (syncStatus = 'idle'), 3000);
			}
		} catch {
			setOverride(overrideKey, prevOverride ?? null);
			syncStatus = 'error';
			setTimeout(() => (syncStatus = 'idle'), 3000);
		}
	}

	async function undoMove() {
		if (syncStatus === 'saving' || !undoStack.length) return;
		const entry = undoStack[undoStack.length - 1];
		undoStack = undoStack.slice(0, -1);
		setOverride(entry.key, entry.before);
		syncStatus = 'saving';
		try {
			const res = entry.before
				? await fetch('/api/cr/schedule', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(scheduleBody(entry.course, entry.origDay, entry.before))
					})
				: await fetch('/api/cr/schedule', {
						method: 'DELETE',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ courseCode: entry.course.courseCode, component: entry.course.component ?? '', originalDay: entry.origDay })
					});
			if (!res.ok) throw new Error();
			redoStack = [...redoStack, entry].slice(-3);
			lastSyncedAt = Date.now();
			syncStatus = 'saved';
			setTimeout(() => (syncStatus = 'idle'), 2500);
		} catch {
			setOverride(entry.key, entry.after);
			undoStack = [...undoStack, entry];
			syncStatus = 'error';
			setTimeout(() => (syncStatus = 'idle'), 3000);
		}
	}

	async function redoMove() {
		if (syncStatus === 'saving' || !redoStack.length) return;
		const entry = redoStack[redoStack.length - 1];
		redoStack = redoStack.slice(0, -1);
		setOverride(entry.key, entry.after);
		syncStatus = 'saving';
		try {
			const res = await fetch('/api/cr/schedule', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(scheduleBody(entry.course, entry.origDay, entry.after))
			});
			if (!res.ok) throw new Error();
			undoStack = [...undoStack, entry].slice(-3);
			lastSyncedAt = Date.now();
			syncStatus = 'saved';
			setTimeout(() => (syncStatus = 'idle'), 2500);
		} catch {
			setOverride(entry.key, entry.before);
			redoStack = [...redoStack, entry];
			syncStatus = 'error';
			setTimeout(() => (syncStatus = 'idle'), 3000);
		}
	}

	function signOut() { window.location.href = '/auth/signout'; }

	const tColors: Record<string, string> = { green: '#22c55e', yellow: '#eab308', red: '#ef4444' };
	const DAY_LIST = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
</script>

<!-- Touch drag ghost (mobile only) -->
{#if touchDragCourse}
	<div style="position: fixed; left: {touchX - touchDragOffsetX}px; top: {touchY - touchDragOffsetY}px; width: {touchGhostW}px; height: {touchGhostH}px; pointer-events: none; z-index: 9999; opacity: 0.85; background: var(--block); border: 1px solid var(--accent); padding: 2px 4px; overflow: hidden;">
		<div class="text-[10px] font-medium truncate" style="color: var(--fg);">{touchDragCourse.courseCode.split('-')[0]}</div>
		<div class="text-[9px] truncate" style="color: var(--muted);">{touchDragCourse.courseName}</div>
	</div>
{/if}

<div class="flex min-h-dvh flex-col" style="background: var(--bg);">
	<!-- Header -->
	<header class="flex items-center justify-between gap-3 px-4 py-3 md:px-8 md:py-4" style="border-bottom: 1px solid var(--border);">
		<div class="flex items-center gap-2.5">
			<span class="grid h-7 w-7 place-items-center rounded-md" style="background: var(--accent); color: var(--on-accent); font-family: var(--font-serif); font-weight: 700; font-size: 1.25rem; line-height: 1;">d</span>
			<span class="title-md" style="font-size: 1.35rem;">dooby</span>
			<span class="badge ml-1 hidden sm:inline-flex">{data.user.role}</span>
		</div>
		<div class="flex items-center gap-2 md:gap-3">
			{#if isAdmin}
				<a href="/admin" class="linkbtn hidden sm:inline">admin</a>
			{/if}
			<span class="hidden max-w-[14rem] truncate text-xs md:inline" style="color: var(--muted);">{data.user.email}</span>
			<button onclick={toggleTheme} title="Toggle light / dark" aria-label="Toggle theme"
				class="grid h-9 w-9 shrink-0 place-items-center rounded-full border transition-colors duration-200"
				style="border-color: var(--border); color: var(--muted); background: transparent;"
				onmouseenter={(e) => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.borderColor = 'var(--accent)'; }}
				onmouseleave={(e) => { e.currentTarget.style.color = 'var(--muted)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
			><span style="font-size: 0.95rem; line-height: 1;">{theme === 'light' ? '☾' : '☀'}</span></button>
			<button onclick={signOut} class="btn btn-ghost btn-sm">sign out</button>
		</div>
	</header>

	{#if !canManage}
		<!-- Signed in, but not a CR yet -->
		<main class="flex flex-1 items-center justify-center px-4 py-16">
			<div class="card card-pad animate-in flex max-w-md flex-col gap-3 text-center">
				<h1 class="title-md">Waiting for access</h1>
				<p class="hint">Your account isn't a class rep yet. An admin needs to assign you a batch before you can manage a timetable.</p>
				<p class="hint" style="font-size: 0.75rem;">Signed in as {data.user.email}</p>
			</div>
		</main>
	{:else}

	<!-- Tabs -->
	<nav class="flex gap-5 overflow-x-auto px-4 md:gap-7 md:px-8" style="border-bottom: 1px solid var(--border);">
		<button onclick={() => activeTab = 'courses'} class="tab {activeTab === 'courses' ? 'tab-active' : ''}">courses{#if notifications.length > 0}<span class="absolute -right-2.5 top-2.5 h-1.5 w-1.5 rounded-full" style="background: var(--accent);"></span>{/if}</button>
		<button onclick={() => activeTab = 'timetable'} class="tab {activeTab === 'timetable' ? 'tab-active' : ''}">timetable</button>
		<button onclick={() => activeTab = 'settings'} class="tab {activeTab === 'settings' ? 'tab-active' : ''}">constraints</button>
		<button onclick={() => activeTab = 'browse'} class="tab {activeTab === 'browse' ? 'tab-active' : ''}">browse batch</button>
	</nav>

	<!-- Content -->
	<main class="flex-1 px-4 py-8 md:px-8 md:py-12">

		<!-- ==================== CR: COURSES ==================== -->
		{#if activeTab === 'courses'}
			<div class="animate-in mx-auto flex w-full max-w-5xl flex-col gap-6">
				{#if notifications.length > 0}
					<div class="flex flex-col gap-2">
						{#each notifications as notif (notif.id)}
							<div class="card flex items-start justify-between gap-3 px-4 py-3" style="border-left: 3px solid var(--accent);">
								<div class="flex flex-col gap-0.5">
									<p class="text-sm" style="color: var(--fg);">{notif.message}</p>
									<p class="eyebrow" style="font-size: 0.58rem;">{browser ? relativeTime(notif.createdAt) : ''}</p>
								</div>
								<button onclick={() => dismissNotification(notif.id)} class="linkbtn shrink-0">dismiss</button>
							</div>
						{/each}
					</div>
				{/if}

				<div class="flex flex-col gap-1">
					<h1 class="title-xl">Courses you're tracking</h1>
					<p class="hint">Search the timetable and add any course you care about. Added courses overlay onto your weekly grid and show whether they clash with your batch.</p>
				</div>

				<!-- Search + add -->
				<div class="card card-pad flex flex-col gap-3">
					<label for="course-search" class="field-label">Add a course <span style="color: var(--muted); font-weight: 400;">— search by code or name</span></label>
					<input id="course-search" bind:value={search} placeholder="e.g. ECE204 or Signals" autocomplete="off" class="input" />
					{#if loadingCourses}
						<p class="hint animate-pulse">Loading courses…</p>
					{:else if search.trim().length >= 2}
						{#if searchResults().length}
							<div class="flex flex-col" style="max-height: 20rem; overflow-y: auto;">
								{#each searchResults() as r}
									{@const level = getTrafficLight(r.code)}
									<div class="flex items-center gap-3 px-1 py-2" style="border-bottom: 1px solid var(--border);">
										<span class="inline-block h-2 w-2 shrink-0 rounded-full" style="background: {tColors[level]};"></span>
										<div class="min-w-0 flex-1">
											<div class="truncate text-sm font-medium" style="color: var(--fg);">{r.code}</div>
											<div class="truncate text-xs" style="color: var(--muted);">{r.name}</div>
										</div>
										{#if r.watched}
											<span class="badge shrink-0">added</span>
										{:else}
											<button onclick={() => addCourse(r.code, r.name)} disabled={addingCode === r.code} class="btn btn-primary btn-sm shrink-0">
												{addingCode === r.code ? 'adding…' : '+ add'}
											</button>
										{/if}
									</div>
								{/each}
							</div>
						{:else}
							<p class="hint">No course matches “{search.trim()}”.</p>
						{/if}
					{:else}
						<p class="hint">Type at least 2 characters to search.</p>
					{/if}
				</div>

				<!-- Watch list -->
				<div class="flex flex-wrap items-center justify-between gap-2">
					<h2 class="title-md">Your list ({myCourses.length})</h2>
					<div class="flex gap-1.5">
						{#each [['course', 'by course'], ['conflict', 'least conflict']] as [mode, label]}
							<button onclick={() => listSort = mode as 'course' | 'conflict'}
								class="cursor-pointer border px-2.5 py-1 text-[9px] uppercase tracking-[0.08em] transition-all duration-150"
								style="border-color: {listSort === mode ? 'var(--accent)' : 'var(--border)'}; color: {listSort === mode ? 'var(--accent)' : 'var(--muted)'}; background: {listSort === mode ? 'var(--tint)' : 'transparent'};"
							>{label}</button>
						{/each}
					</div>
				</div>

				{#if !myCourses.length}
					<div class="card card-pad text-center" style="border-style: dashed;">
						<p class="hint">Nothing tracked yet — search above and add your first course.</p>
					</div>
				{:else}
					<div class="card nood-mono overflow-x-auto">
						<table class="w-full min-w-[540px] text-left text-sm" style="border-collapse: collapse;">
							<thead>
								<tr style="border-bottom: 1px solid var(--border);">
									<th class="px-4 py-3 text-xs font-semibold uppercase tracking-wider" style="color: var(--muted);">course</th>
									<th class="px-4 py-3 text-xs font-semibold uppercase tracking-wider" style="color: var(--muted);">conflicts</th>
									<th class="px-4 py-3 text-xs font-semibold uppercase tracking-wider" style="color: var(--muted);">status</th>
									<th class="px-4 py-3"><span class="sr-only">actions</span></th>
								</tr>
							</thead>
							<tbody>
								{#each sortedMyCourses() as item}
									{@const level = getTrafficLight(item.courseCode)}
									{@const adjustedLevel = adjustedConflictMap().get(item.courseCode) ?? level}
									{@const conflictCleared = level !== 'green' && adjustedLevel === 'green'}
									{@const conf = courseConflicts().get(item.courseCode)}
									<tr style="border-bottom: 1px solid var(--border);">
										<td class="px-3 py-2.5">
											<span class="font-medium" style="color: var(--fg);">{item.courseCode}</span>
											{#if item.courseName}<span class="ml-2 hidden text-[9px] md:inline" style="color: var(--muted);">{item.courseName}</span>{/if}
										</td>
										<td class="px-3 py-2.5 whitespace-nowrap">
											{#if conf && conf.score > 0}
												{#if conf.red > 0}<span style="color: {tColors.red};">{conf.red}R</span>{/if}
												{#if conf.red > 0 && conf.yellow > 0}<span style="color: var(--muted);"> · </span>{/if}
												{#if conf.yellow > 0}<span style="color: {tColors.yellow};">{conf.yellow}Y</span>{/if}
											{:else}
												<span class="inline-block h-2 w-2 rounded-full" style="background: {tColors.green};"></span>
											{/if}
										</td>
										<td class="px-3 py-2.5">
											<div class="flex flex-wrap items-center gap-2">
												<span class="inline-block h-2 w-2 rounded-full" style="background: {conflictCleared ? '#22c55e' : tColors[level]};"></span>
												{#if conflictCleared}
													<span class="text-[8px] uppercase tracking-[0.08em] px-1.5 py-0.5" style="color: #22c55e; border: 1px solid #22c55e44; background: #22c55e0d;">no conflict after adjustment</span>
												{/if}
											</div>
										</td>
										<td class="px-3 py-2.5 text-right">
											<button onclick={() => removeCourse(item.courseCode)}
												class="cursor-pointer border-none bg-transparent text-xs transition-colors"
												style="color: var(--muted);"
												onmouseenter={(e) => { e.currentTarget.style.color = '#d8593f'; }}
												onmouseleave={(e) => { e.currentTarget.style.color = 'var(--muted)'; }}
											>remove</button>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>

					<!-- Legend -->
					<div class="flex flex-wrap gap-4 pt-3" style="border-top: 1px solid var(--border);">
						{#each [['#22c55e', 'no conflict'], ['#eab308', 'tutorial overlap'], ['#ef4444', 'lecture conflict']] as [color, label]}
							<div class="flex items-center gap-1.5">
								<span class="inline-block h-1.5 w-1.5 rounded-full" style="background: {color};"></span>
								<span class="text-[8px] uppercase tracking-[0.1em]" style="color: var(--muted);">{label}</span>
							</div>
						{/each}
						<div class="flex items-center gap-1.5">
							<span class="text-[8px] uppercase tracking-[0.08em] px-1.5 py-0.5" style="color: #22c55e; border: 1px solid #22c55e44; background: #22c55e0d;">no conflict after adjustment</span>
							<span class="text-[8px] uppercase tracking-[0.1em]" style="color: var(--muted);">cr moved this slot</span>
						</div>
					</div>
				{/if}
			</div>

		<!-- ==================== CR: TIMETABLE ==================== -->
		{:else if activeTab === 'timetable'}
			<div class="nood-mono flex flex-col gap-5">
				<div class="flex flex-wrap items-start justify-between gap-2">
					<div class="min-w-0">
						<h2 class="text-lg" style="font-family: var(--font-serif); color: var(--accent);">weekly schedule</h2>
						<p class="text-[9px] uppercase tracking-[0.1em]" style="color: var(--muted);">
							{#if viewedBatchNames.length}
								{viewedBatchNames.join(', ')} ·
							{/if}
							{crBatchCourses().length} courses
						</p>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<!-- Originals toggle + reset -->
						{#if scheduleOverrides.size > 0}
							<button
								onclick={() => showOriginals = !showOriginals}
								class="cursor-pointer border px-2.5 py-1 text-[9px] uppercase tracking-[0.1em] transition-all duration-150"
								style="border-color: {showOriginals ? 'var(--muted)' : 'var(--border)'}; color: {showOriginals ? 'var(--fg)' : 'var(--muted)'}; background: transparent;"
							>{showOriginals ? 'hide original' : 'show original'}</button>
							<button
								onclick={async () => {
									const prev = scheduleOverrides;
									scheduleOverrides = new Map();
									syncStatus = 'saving';
									try {
										const res = await fetch('/api/cr/schedule', { method: 'DELETE' });
										if (res.ok) {
											undoStack = [];
											redoStack = [];
											syncStatus = 'saved';
											setTimeout(() => (syncStatus = 'idle'), 2500);
										} else {
											scheduleOverrides = prev;
											syncStatus = 'error';
											setTimeout(() => (syncStatus = 'idle'), 3000);
										}
									} catch {
										scheduleOverrides = prev;
										syncStatus = 'error';
										setTimeout(() => (syncStatus = 'idle'), 3000);
									}
								}}
								class="cursor-pointer border px-2.5 py-1 text-[9px] uppercase tracking-[0.1em] transition-all duration-150"
								style="border-color: var(--border); color: var(--muted); background: transparent;"
								onmouseenter={(e) => { (e.currentTarget as HTMLElement).style.color = '#e44'; (e.currentTarget as HTMLElement).style.borderColor = '#e44'; }}
								onmouseleave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; }}
							>reset positions</button>
						{/if}
						<!-- Undo / redo (session-only, last 3 moves) -->
						<button onclick={undoMove} disabled={!undoStack.length || syncStatus === 'saving'}
							class="cursor-pointer border px-2.5 py-1 text-[9px] uppercase tracking-[0.1em] transition-all duration-150 disabled:cursor-default disabled:opacity-30"
							style="border-color: var(--border); color: var(--muted); background: transparent;"
							onmouseenter={(e) => { e.currentTarget.style.color = 'var(--accent)'; }}
							onmouseleave={(e) => { e.currentTarget.style.color = 'var(--muted)'; }}
						>↶ undo</button>
						<button onclick={redoMove} disabled={!redoStack.length || syncStatus === 'saving'}
							class="cursor-pointer border px-2.5 py-1 text-[9px] uppercase tracking-[0.1em] transition-all duration-150 disabled:cursor-default disabled:opacity-30"
							style="border-color: var(--border); color: var(--muted); background: transparent;"
							onmouseenter={(e) => { e.currentTarget.style.color = 'var(--accent)'; }}
							onmouseleave={(e) => { e.currentTarget.style.color = 'var(--muted)'; }}
						>↷ redo</button>
						<!-- Sync status -->
						<span class="text-[9px] uppercase tracking-[0.12em] text-right" style="min-width: 5.5rem; color: {syncStatus === 'saving' ? 'var(--muted)' : syncStatus === 'saved' ? '#4e4' : syncStatus === 'error' ? '#e44' : 'var(--fg)'};">
							{#if syncStatus === 'saving'}saving…{:else if syncStatus === 'saved'}synced ✓{:else if syncStatus === 'error'}sync failed{:else if lastSyncedAt > 0}live{/if}
						</span>
					</div>
				</div>
				<!-- Time range controls -->
				<div class="flex items-center gap-3">
					<button onclick={() => extraHoursBefore = Math.min(extraHoursBefore + 1, Math.floor(tDispMin / 60))}
						class="cursor-pointer border px-2.5 py-1 text-[9px] tracking-wider transition-all duration-150"
						style="border-color: var(--border); color: var(--muted); background: transparent;"
						onmouseenter={(e) => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.borderColor = 'var(--muted)'; }}
						onmouseleave={(e) => { e.currentTarget.style.color = 'var(--muted)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
						disabled={tDispMin <= 0}
					>↑ earlier</button>
					<span class="text-[9px]" style="color: var(--muted);">{minutesToTime(tDispMin)} — {minutesToTime(tDispMax)}</span>
					<button onclick={() => extraHoursAfter = Math.min(extraHoursAfter + 1, Math.floor((1440 - tDispMax) / 60))}
						class="cursor-pointer border px-2.5 py-1 text-[9px] tracking-wider transition-all duration-150"
						style="border-color: var(--border); color: var(--muted); background: transparent;"
						onmouseenter={(e) => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.borderColor = 'var(--muted)'; }}
						onmouseleave={(e) => { e.currentTarget.style.color = 'var(--muted)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
						disabled={tDispMax >= 1440}
					>↓ later</button>
					{#if extraHoursBefore > 0 || extraHoursAfter > 1}
						<button onclick={() => { extraHoursBefore = 0; extraHoursAfter = 1; }}
							class="cursor-pointer border-none bg-transparent text-[9px] tracking-wider transition-colors duration-150"
							style="color: var(--muted);"
							onmouseenter={(e) => { e.currentTarget.style.color = 'var(--muted)'; }}
							onmouseleave={(e) => { e.currentTarget.style.color = 'var(--border)'; }}
						>reset</button>
					{/if}
				</div>

				<!-- Batch view switcher — one batch at a time, or all together -->
				{#if crBatchNames.length > 1}
					<div class="flex items-center gap-2">
						<span class="shrink-0 text-[9px] uppercase tracking-[0.1em]" style="color: var(--muted);">batch</span>
						<div class="flex gap-1.5 overflow-x-auto pb-0.5" style="scrollbar-width: none;">
							<button onclick={() => batchViews = new Set()}
								class="cursor-pointer shrink-0 border px-2.5 py-1 text-[9px] uppercase tracking-[0.08em] transition-all duration-150"
								style="border-color: {!batchViews.size ? 'var(--accent)' : 'var(--border)'}; color: {!batchViews.size ? 'var(--accent)' : 'var(--muted)'}; background: {!batchViews.size ? 'var(--tint)' : 'transparent'};"
							>all ({crBatchNames.length})</button>
							{#each crBatchNames as bn}
								{@const on = batchViews.has(bn)}
								<button onclick={() => toggleBatchView(bn)}
									class="cursor-pointer shrink-0 border px-2.5 py-1 text-[9px] uppercase tracking-[0.08em] transition-all duration-150"
									style="border-color: {on ? 'var(--accent)' : 'var(--border)'}; color: {on ? 'var(--accent)' : 'var(--muted)'}; background: {on ? 'var(--tint)' : 'transparent'};"
								>{on ? '✓ ' : ''}{bn}</button>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Dept filter chips -->
				{#if ttDepts.length > 1}
					<div class="flex gap-1.5 overflow-x-auto pb-0.5" style="scrollbar-width: none;">
						<button onclick={() => ttDeptFilter = ''}
							class="cursor-pointer shrink-0 border px-2.5 py-1 text-[9px] uppercase tracking-[0.08em] transition-all duration-150"
							style="border-color: {!ttDeptFilter ? 'var(--muted)' : 'var(--border)'}; color: {!ttDeptFilter ? 'var(--fg)' : 'var(--muted)'}; background: transparent;"
						>all</button>
						{#each ttDepts as dept}
							<button onclick={() => ttDeptFilter = ttDeptFilter === dept ? '' : dept}
								class="cursor-pointer shrink-0 border px-2.5 py-1 text-[9px] uppercase tracking-[0.08em] transition-all duration-150"
								style="border-color: {ttDeptFilter === dept ? 'var(--accent)' : 'var(--border)'}; color: {ttDeptFilter === dept ? 'var(--accent)' : 'var(--muted)'}; background: {ttDeptFilter === dept ? 'var(--tint)' : 'transparent'};"
							>{dept}</button>
						{/each}
					</div>
				{/if}

				{#if !crBatchNames.length}
					<p class="text-xs py-8 text-center" style="color: var(--muted);">no batches assigned — ask an admin to assign batches to your CR account</p>
				{:else if calendarBlocks().length === 0 && loadingCourses}
					<p class="text-xs animate-pulse" style="color: var(--muted);">loading timetable...</p>
				{:else}
					<div class="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
						<div class="min-w-[600px]">
							<div class="grid" style="grid-template-columns: 50px repeat({DAYS.length}, 1fr); border: 1px solid var(--border);">
								<div style="border-bottom: 1px solid var(--border); border-right: 1px solid var(--border);"></div>
								{#each DAYS as day}
									<div class="px-1 py-2 text-center text-[8px] uppercase tracking-[0.08em]"
										style="border-bottom: 1px solid var(--border); border-right: 1px solid var(--border); color: var(--muted);">
										<span class="hidden md:inline">{day}</span><span class="md:hidden">{day.slice(0, 3)}</span>
									</div>
								{/each}

								{#each timeLabels as { mins, label }, i}
									{#if i < timeLabels.length - 1}
										{@const blockStarts = [...new Set(filteredCalendarBlocks().filter((b) => b.startMin > mins && b.startMin < mins + 60).map((b) => b.startMin))].sort((a, b) => a - b)}
										<div class="relative px-0.5 text-right" style="height: {CELL_H}px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border);">
											<span class="text-[7px]" style="color: var(--muted);">{label}</span>
											{#each blockStarts as bMin}
												{@const yOff = ((bMin - mins) / 60) * CELL_H}
												<span class="absolute right-0.5 text-[6px]" style="top: {yOff}px; color: var(--border);">{minutesToTime(bMin)}</span>
											{/each}
										</div>
										{#each DAYS as day}
											{@const hStart = mins}
											{@const hEnd = mins + 60}
											<div class="relative" style="height: {CELL_H}px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border);"
												role="cell" tabindex="-1"
												data-day={day} data-hstart={hStart}
												ondragover={(e) => onDragOver(e, day, hStart)}
												ondrop={(e) => onDrop(e, day, hStart)}>
												{#each filteredCalendarBlocks().filter((b) => b.day === day && b.startMin >= hStart && b.startMin < hEnd) as block}
													{@const top = ((block.startMin - hStart) / 60) * CELL_H}
													{@const h = ((block.endMin - block.startMin) / 60) * CELL_H}
													{@const level = block.isUWE ? getTrafficLight(block.course.courseCode.split('-')[0]) : null}
													{@const violation = block.isUWE ? null : blockConstraintViolation(block.course, block.day, block.startMin, block.endMin)}
													{@const uweKey = block.day + '|' + block.startMin + '|' + block.endMin}
													{@const uweGroup = block.isUWE ? filteredCalendarBlocks().filter(b2 => b2.isUWE && b2.day === block.day && b2.startMin === block.startMin && b2.endMin === block.endMin) : []}
													{@const uweIdx = block.isUWE ? uweGroup.findIndex(b2 => b2.course.courseCode === block.course.courseCode) : 0}
													{@const activeUweIdx = (uweGroupActive.get(uweKey) ?? 0) % (uweGroup.length || 1)}
													{#if !block.isUWE || uweIdx === activeUweIdx}
													<div role="button" tabindex="0"
														class="absolute right-0.5 overflow-hidden px-1 py-0.5 {block.isUWE ? 'cursor-pointer left-0' : 'cursor-grab active:cursor-grabbing left-0.5'}"
														onmouseenter={(e) => hoverAt(e, block.course, violation)}
														onmousemove={(e) => hoverAt(e, block.course, violation)}
														onmouseleave={() => (hoverInfo = null)}
														style="top: {top}px; height: {h}px; min-height: 20px; background: {violation ? tColors.red + '1f' : block.isUWE ? 'var(--tint-strong)' : 'var(--block)'}; border: 1px solid {violation ? tColors.red : block.isUWE && level ? tColors[level] + '66' : 'var(--border)'}; z-index: {block.isUWE ? 1 : 2}; {violation ? 'border-left: 3px solid ' + tColors.red + ';' : block.isUWE ? 'border-left: 3px solid ' + (level ? tColors[level] : 'var(--border)') + ';' : ''}"
														draggable={!block.isUWE}
														ondragstart={(e) => { if (!block.isUWE) onDragStart(e, block.course, block.originalDay, block.isUWE); }}
														ontouchstart={(e) => { if (!block.isUWE) onTouchStart(e, block.course, block.originalDay, block.isUWE); }}
														onclick={(e) => { if (block.isUWE && uweGroup.length > 1) cycleUwe(uweKey, uweGroup.length, e); }}>
														{#if block.isUWE && uweGroup.length > 1}
															<div style="position: absolute; top: 2px; right: 2px; background: {level ? tColors[level] : 'var(--muted)'}; color: #000; border-radius: 3px; padding: 0 3px; font-size: 7px; font-weight: 700; line-height: 12px; letter-spacing: 0.03em; pointer-events: none;">
																{activeUweIdx + 1}/{uweGroup.length}
															</div>
														{/if}
														<!-- Line-height is 1.5, so lines cost 15 / 12 / 13.5 / 12px on top of 4px
														     padding — cumulative 19 / 31 / 44.5 / 56.5. Drop lines that would spill
														     instead of clipping them; hover or tap shows the full details. -->
														<!-- Tracked-course labels scroll themselves so they're readable without any
														     interaction; they're also hoverable and tappable for the full details.
														     Drops still land because drag events bubble to the grid cell, and core
														     blocks sit above overlays (z-index 2 vs 1) so they stay grabbable. -->
														<div class="text-[10px] font-medium {block.isUWE ? 'tt-scroll' : 'truncate'}" style="color: {block.isUWE ? (level ? tColors[level] : 'var(--fg)') : 'var(--fg)'}; padding-right: {block.isUWE && uweGroup.length > 1 ? '18px' : '0'};"><span>{block.course.courseCode.split('-')[0]}</span></div>
														{#if sectionBatch(block.course) && h > 31}
															<div class="text-[8px] uppercase tracking-[0.06em] {block.isUWE ? 'tt-scroll' : 'truncate'}" style="color: var(--accent);"><span>{block.course.component} · {sectionBatch(block.course)}</span></div>
														{/if}
														{#if h > 45}
															<div class="text-[9px] {block.isUWE ? 'tt-scroll' : 'truncate'}" style="color: var(--muted);"><span>{block.course.courseName}</span></div>
														{/if}
														{#if h > 57}
															<div class="text-[8px] {block.isUWE ? 'tt-scroll' : 'truncate'}" style="color: var(--muted);"><span>{block.course.component ?? ''}{block.course.room ? ' • ' + block.course.room : ''}{block.course.faculty ? ' • ' + block.course.faculty : ''}</span></div>
														{/if}
													</div>
													{/if}
												{/each}
											<!-- Ghost blocks (original positions of moved courses) -->
											{#if showOriginals}
												{#each ghostBlocks().filter((g) => g.day === day && g.startMin >= hStart && g.startMin < hEnd && (!ttDeptFilter || deptPrefix(g.courseCode) === ttDeptFilter)) as ghost}
													{@const gTop = ((ghost.startMin - hStart) / 60) * CELL_H}
													{@const gH = Math.max(14, ((ghost.endMin - ghost.startMin) / 60) * CELL_H)}
													<div class="absolute left-0.5 right-0.5 overflow-hidden px-1 py-0.5 pointer-events-none"
														style="top: {gTop}px; height: {gH}px; border: 1px dashed var(--muted); opacity: 0.4; z-index: 1;">
														<div class="text-[7px] truncate" style="color: var(--muted);">{ghost.courseCode.split('-')[0]}</div>
													</div>
												{/each}
											{/if}
											{#if dragOverSlot?.day === day && dragOverSlot?.startMin >= hStart && dragOverSlot?.startMin < hEnd}
												{@const dropY = ((dragOverSlot.startMin - hStart) / 60) * CELL_H}
												<div class="absolute left-0.5 right-0.5" style="top: {dropY}px; height: 2px; background: var(--accent); z-index: 3;"></div>
												<span class="absolute text-[6px] z-[4]" style="top: {dropY - 8}px; right: 2px; color: var(--accent);">{minutesToTime(dragOverSlot.startMin)}</span>
											{/if}
											</div>
										{/each}
									{/if}
								{/each}
							</div>
						</div>
					</div>
				{/if}

				<!-- Tracked-course overlay controls -->
				{#if myCourses.length > 0}
					<div class="flex flex-col gap-4 pt-3" style="border-top: 1px solid var(--border);">
						<div class="flex flex-col gap-2">
							<div class="flex flex-wrap items-center justify-between gap-2">
								<span class="text-[9px] uppercase tracking-[0.1em]" style="color: var(--muted);">your courses — click to overlay</span>
								<div class="flex gap-1.5">
									{#each [['course', 'by course'], ['conflict', 'least conflict']] as [mode, label]}
										<button onclick={() => listSort = mode as 'course' | 'conflict'}
											class="cursor-pointer border px-2.5 py-1 text-[9px] uppercase tracking-[0.08em] transition-all duration-150"
											style="border-color: {listSort === mode ? 'var(--accent)' : 'var(--border)'}; color: {listSort === mode ? 'var(--accent)' : 'var(--muted)'}; background: {listSort === mode ? 'var(--tint)' : 'transparent'};"
										>{label}</button>
									{/each}
								</div>
							</div>
							<div class="flex flex-wrap gap-1.5">
								{#each sortedMyCourses() as item}
									{@const level = getTrafficLight(item.courseCode)}
									{@const active = enabledCourses.has(item.courseCode)}
									{@const conf = courseConflicts().get(item.courseCode)}
									<button
										onclick={() => toggleCourseOverlay(item.courseCode)}
										class="cursor-pointer border px-2 py-1 text-[10px] tracking-wide transition-all duration-150"
										style="border-color: {active ? (tColors[level] + '88') : 'var(--border)'}; color: {active ? 'var(--fg)' : 'var(--muted)'}; background: {active ? 'var(--tint)' : 'transparent'};"
									>
										<span class="inline-block h-1 w-1 rounded-full mr-1" style="background: {tColors[level]};"></span>
										{item.courseCode}
										{#if conf && conf.score > 0}
											<span class="text-[7px] ml-0.5">
												{#if conf.red > 0}<span style="color: {tColors.red};">{conf.red}R</span>{/if}{#if conf.red > 0 && conf.yellow > 0}<span style="color: var(--muted);">·</span>{/if}{#if conf.yellow > 0}<span style="color: {tColors.yellow};">{conf.yellow}Y</span>{/if}
											</span>
										{/if}
									</button>
								{/each}
							</div>
						</div>

						<!-- Legend -->
						<div class="flex flex-wrap gap-4">
							{#each [['#22c55e', 'no conflict'], ['#eab308', 'tutorial overlap'], ['#ef4444', 'lecture conflict']] as [color, label]}
								<div class="flex items-center gap-1.5">
									<span class="inline-block h-1.5 w-1.5 rounded-full" style="background: {color};"></span>
									<span class="text-[8px] uppercase tracking-[0.1em]" style="color: var(--muted);">{label}</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			</div>

		<!-- ==================== CR: CONSTRAINTS ==================== -->
		{:else if activeTab === 'settings'}
			<div class="animate-in mx-auto flex w-full max-w-5xl flex-col gap-6">
				<div class="flex flex-col gap-1">
					<h1 class="title-xl">Professor constraints</h1>
					<p class="hint">Block the times a professor is unavailable. Blocked slots refuse a class when you drag it there on the timetable.</p>
				</div>

				<div class="grid gap-5 lg:grid-cols-2 lg:items-start">
				<!-- Add form -->
				<div class="card card-pad flex flex-col gap-4">
					<div class="flex flex-col">
						<label for="prof-input" class="field-label">Professor <span style="color: var(--muted); font-weight: 400;">— search by name or course code</span></label>
						<div class="relative">
							<input id="prof-input" bind:value={profName} placeholder="e.g. Sharma or ECE204"
								autocomplete="off"
								oninput={() => profSuggestOpen = true}
								onfocus={() => profSuggestOpen = true}
								onblur={() => setTimeout(() => profSuggestOpen = false, 150)}
								class="input" />
							{#if profSuggestions().length}
								<div class="card absolute left-0 top-full z-10 mt-1 max-h-60 w-full overflow-y-auto p-1" style="box-shadow: var(--shadow-lg);">
									{#each profSuggestions() as p}
										<button
											onmousedown={() => { profName = p.name; profSuggestOpen = false; }}
											ontouchstart={() => { profName = p.name; profSuggestOpen = false; }}
											class="flex w-full cursor-pointer items-baseline justify-between gap-2 rounded-md border-none bg-transparent px-3 py-2.5 text-left transition-colors duration-100"
											style="color: var(--muted);"
											onmouseenter={(e) => { e.currentTarget.style.background = 'var(--tint)'; e.currentTarget.style.color = 'var(--fg)'; }}
											onmouseleave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--muted)'; }}
										>
											<span class="min-w-0 truncate text-sm" style="color: var(--fg);">{p.name}</span>
											<span class="shrink-0 font-mono text-xs uppercase tracking-[0.05em]">{p.codes.slice(0, 4).join(', ')}{p.codes.length > 4 ? ` +${p.codes.length - 4}` : ''}</span>
										</button>
									{/each}
								</div>
							{/if}
						</div>
					</div>
					<div class="flex items-end gap-3">
						<div class="flex flex-1 flex-col">
							<label for="c-day" class="field-label">Day</label>
							<select id="c-day" bind:value={constraintDay} class="select">
								{#each DAY_LIST as d}<option value={d}>{d}</option>{/each}
							</select>
						</div>
						<label class="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5" style="border-color: var(--border);">
							<input type="checkbox" bind:checked={allDay} style="accent-color: var(--accent); width: 1rem; height: 1rem;" />
							<span class="text-sm" style="color: var(--fg);">All day</span>
						</label>
					</div>
					{#if !allDay}
						<div class="flex gap-3">
							<div class="flex flex-1 flex-col">
								<label for="c-from" class="field-label">From</label>
								<input id="c-from" type="time" bind:value={cStartTime} class="input" />
							</div>
							<div class="flex flex-1 flex-col">
								<label for="c-to" class="field-label">To</label>
								<input id="c-to" type="time" bind:value={cEndTime} class="input" />
							</div>
						</div>
					{/if}
					<button onclick={addConstraint} disabled={savingConstraint} class="btn btn-primary">{savingConstraint ? 'adding…' : 'add constraint'}</button>
				</div>

				<!-- List -->
				<div class="card card-pad flex flex-col gap-3">
					<span class="eyebrow">Active ({constraints.length})</span>
					{#if loadingCR}
						<p class="hint animate-pulse">Loading…</p>
					{/if}
					{#each constraints as c}
						<div class="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5" style="border-color: var(--border);">
							<div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
								<span class="text-sm font-semibold" style="color: var(--fg);">{c.professorName}</span>
								<span class="font-mono text-xs" style="color: var(--muted);">{c.day}{c.allDay ? ' · all day' : ` · ${c.startTime}–${c.endTime}`}</span>
							</div>
							<button onclick={() => removeConstraint(c.id)}
								class="shrink-0 cursor-pointer border-none bg-transparent text-xs font-medium transition-colors"
								style="color: var(--muted);"
								onmouseenter={(e) => { e.currentTarget.style.color = '#d8593f'; }}
								onmouseleave={(e) => { e.currentTarget.style.color = 'var(--muted)'; }}
							>remove</button>
						</div>
					{:else}
						<p class="hint">No constraints set.</p>
					{/each}
				</div>
				</div>
			</div>

		<!-- ==================== CR: BROWSE ANY BATCH ==================== -->
		{:else if activeTab === 'browse'}
			<div class="animate-in mx-auto flex w-full max-w-5xl flex-col gap-6">
				<div class="flex flex-col gap-1">
					<h1 class="title-xl">Browse a batch</h1>
					<p class="hint">{selectedBatches.length ? 'Weekly schedule across the batches below (read-only).' : 'Enter batch code(s) and load to see their weekly schedule.'}</p>
				</div>

				<!-- Batch selector -->
				<div class="card flex flex-col gap-2.5 p-4 max-w-md">
					<span class="eyebrow">Batches</span>
					<div class="grid gap-2" style="grid-template-columns: repeat(auto-fit, minmax(116px, 1fr));">
						{#each batchInputs as input, i}
							<div class="relative flex items-center gap-2">
								<input
									type="text"
									bind:value={batchInputs[i]}
									oninput={() => onBatchInput(i)}
									onfocus={() => onBatchInput(i)}
									onblur={() => setTimeout(() => { batchSuggestions[i] = []; batchSuggestions = [...batchSuggestions]; }, 150)}
									placeholder="e.g. CSE2X"
									autocomplete="off"
									class="input uppercase"
								/>
								{#if batchInputs.length > 1}
									<button onclick={() => removeBatchInput(i)} aria-label="Remove batch"
										class="grid h-9 w-9 shrink-0 place-items-center rounded-md border transition-colors duration-150"
										style="border-color: var(--border); color: var(--muted);"
										onmouseenter={(e) => { e.currentTarget.style.color = '#d8593f'; e.currentTarget.style.borderColor = '#d8593f'; }}
										onmouseleave={(e) => { e.currentTarget.style.color = 'var(--muted)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
									>&times;</button>
								{/if}
								<!-- Suggestions dropdown -->
								{#if batchSuggestions[i]?.length}
									<div class="card absolute left-0 top-full z-10 mt-1 max-h-44 w-full overflow-y-auto p-1" style="box-shadow: var(--shadow-lg);">
										{#each batchSuggestions[i] as suggestion}
											<button
												onmousedown={() => selectBatchSuggestion(i, suggestion)}
												ontouchstart={() => selectBatchSuggestion(i, suggestion)}
												class="block w-full cursor-pointer rounded-md border-none bg-transparent px-3 py-2.5 text-left text-sm uppercase transition-colors duration-100"
												style="color: var(--muted);"
												onmouseenter={(e) => { e.currentTarget.style.background = 'var(--tint)'; e.currentTarget.style.color = 'var(--fg)'; }}
												onmouseleave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--muted)'; }}
											>{suggestion}</button>
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					</div>

					<div class="flex items-center gap-3">
						{#if batchInputs.length < 4}
							<button onclick={addBatchInput} class="linkbtn">+ add batch</button>
						{/if}
						<div class="flex-1"></div>
						<button onclick={loadBatches} class="btn btn-primary btn-sm">load timetable</button>
					</div>
				</div>

				<!-- Timetable grid -->
				{#if selectedBatches.length && browseBlocks().length}
					<div class="nood-mono overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
						<div class="min-w-[600px]">
							<div class="grid" style="grid-template-columns: 50px repeat({DAYS.length}, 1fr); border: 1px solid var(--border);">
								<div style="border-bottom: 1px solid var(--border); border-right: 1px solid var(--border);"></div>
								{#each DAYS as day}
									<div class="px-1 py-2 text-center text-[8px] uppercase tracking-[0.08em]"
										style="border-bottom: 1px solid var(--border); border-right: 1px solid var(--border); color: var(--muted);">
										<span class="hidden md:inline">{day}</span><span class="md:hidden">{day.slice(0, 3)}</span>
									</div>
								{/each}
								{#each sTimeLabels as { mins, label }, i}
									{#if i < sTimeLabels.length - 1}
										<div class="relative px-0.5 text-right" style="height: 56px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border);">
											<span class="text-[9px]" style="color: var(--muted);">{label}</span>
										</div>
										{#each DAYS as day}
											{@const hStart = mins}
											{@const hEnd = mins + 60}
											<div class="relative" style="height: 56px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border);">
												{#each browseBlocks().filter((b) => b.day === day && b.startMin >= hStart && b.startMin < hEnd) as block}
													{@const top = ((block.startMin - hStart) / 60) * 100}
													{@const h = ((block.endMin - block.startMin) / 60) * 56}
													<div role="note" class="absolute left-0.5 right-0.5 overflow-hidden px-1 py-0.5"
														onmouseenter={(e) => hoverAt(e, block.course, null)}
														onmousemove={(e) => hoverAt(e, block.course, null)}
														onmouseleave={() => (hoverInfo = null)}
														style="top: {top}%; height: {h}px; min-height: 24px; background: var(--block); border: 1px solid var(--border);">
														<div class="text-[10px] font-medium truncate" style="color: var(--fg);">{block.course.courseCode.split('-')[0]}</div>
														{#if sectionBatch(block.course) && h > 31}
															<div class="truncate text-[8px] uppercase tracking-[0.06em]" style="color: var(--accent);">{block.course.component} · {sectionBatch(block.course)}</div>
														{/if}
														{#if h > 45}
															<div class="text-[9px] truncate" style="color: var(--muted);">{block.course.courseName}</div>
														{/if}
														{#if h > 57}
															<div class="text-[8px] truncate" style="color: var(--muted);">{block.course.room} • {block.course.faculty}</div>
														{/if}
													</div>
												{/each}
											</div>
										{/each}
									{/if}
								{/each}
							</div>
						</div>
					</div>
				{:else if selectedBatches.length}
					<div class="card card-pad text-center">
						<p class="hint">No courses found for these batches — double-check the codes above.</p>
					</div>
				{/if}
			</div>
		{/if}
	</main>
	{/if}

	<!-- Hover card for timetable blocks -->
	{#if hoverInfo}
		<div class="pointer-events-none fixed z-[60] max-w-[21rem] rounded-lg px-3 py-2 text-xs leading-relaxed"
			style="left: {hoverInfo.x}px; top: {hoverInfo.y}px; background: var(--surface); border: 1px solid var(--border); color: var(--fg); box-shadow: var(--shadow-lg);">
			{hoverInfo.text}
			{#if hoverInfo.warn}
				<div class="mt-1" style="color: #ef4444;">⚠ Prof. {hoverInfo.warn} has a constraint at this time</div>
			{/if}
		</div>
	{/if}

	<!-- Toast -->
	{#if toast}
		<div class="animate-in fixed bottom-6 left-1/2 z-50 flex max-w-[min(90vw,34rem)] -translate-x-1/2 items-center gap-2.5 rounded-2xl px-4 py-2.5 text-sm"
			style="background: var(--surface); border: 1px solid var(--border); color: var(--fg); box-shadow: var(--shadow-lg);">
			<span class="inline-block h-1.5 w-1.5 rounded-full" style="background: var(--accent);"></span>{toast}
		</div>
	{/if}

	<!-- Tracked-course warning modal -->
	{#if moveWarnModal}
		<div class="fixed inset-0 z-50 flex items-center justify-center px-4" style="background: rgba(0,0,0,0.55); backdrop-filter: blur(2px);" onclick={cancelDrop}>
			<div class="card animate-in flex w-full max-w-sm flex-col gap-5 p-6" style="box-shadow: var(--shadow-lg);" onclick={(e) => e.stopPropagation()}>
				<div class="flex flex-col gap-2">
					<span class="eyebrow" style="color: var(--accent);">heads up</span>
					<p class="text-base leading-relaxed" style="color: var(--fg);">
						<span class="font-semibold">{moveWarnModal.count} other {moveWarnModal.count === 1 ? 'CR is' : 'CRs are'}</span> tracking
						<span class="font-semibold">{moveWarnModal.courseCode}</span>.
						Shifting this class may create conflicts for their batches.
					</p>
					<p class="hint">Do you still want to proceed with the move?</p>
				</div>
				<div class="flex justify-end gap-3">
					<button onclick={cancelDrop} class="btn btn-ghost btn-sm">cancel</button>
					<button onclick={confirmDrop} class="btn btn-primary btn-sm">yes, move it</button>
				</div>
			</div>
		</div>
	{/if}
</div>

<footer class="border-t py-5 text-center" style="border-color: var(--border); background: var(--bg);">
	<span class="eyebrow" style="font-size: 0.6rem;">built &amp; maintained by
		<a href="https://github.com/rohitjg13" target="_blank" rel="noopener noreferrer" class="underline decoration-1 underline-offset-4 transition-colors" style="color: var(--muted);"
			onmouseenter={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = 'var(--accent)'; }}
			onmouseleave={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = 'var(--muted)'; }}
		>rohit j g</a>
	</span>
</footer>
