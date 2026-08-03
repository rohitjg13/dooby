// Self-check for the timetable parsing helpers: node src/lib/types.check.ts
import assert from 'node:assert/strict';
import { expandBlocks, parseDays } from './types.ts';

assert.deepEqual(expandBlocks(''), []);
assert.deepEqual(expandBlocks('BIO21, BIO22'), ['BIO21', 'BIO22']);
assert.deepEqual(expandBlocks('CSD31 to CSD36'), [
	'CSD31',
	'CSD32',
	'CSD33',
	'CSD34',
	'CSD35',
	'CSD36'
]);
assert.deepEqual(expandBlocks('CSD37 to CSD311'), [
	'CSD37',
	'CSD38',
	'CSD39',
	'CSD310',
	'CSD311'
]);
assert.equal(expandBlocks('ECE21 to ECE215').length, 15);
assert.deepEqual(expandBlocks('BIO31, BIO32, CHY3YR'), ['BIO31', 'BIO32', 'CHY3YR']);

// Monsoon 2026 spells days out as Mon/Tue/Wed/Thu/Fri/Sat
assert.deepEqual(parseDays('Mon'), ['Monday']);
assert.deepEqual(parseDays('Tue'), ['Tuesday']);
assert.deepEqual(parseDays('Wed'), ['Wednesday']);
assert.deepEqual(parseDays('Thu'), ['Thursday']);
assert.deepEqual(parseDays('Fri'), ['Friday']);
assert.deepEqual(parseDays('Sat'), ['Saturday']);

console.log('ok');
