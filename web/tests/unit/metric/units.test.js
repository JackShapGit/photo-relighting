import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FT_PER_M, formatLength, parseLength, toDisplay, fromDisplay } from '../../../src/metric/units.js';

test('FT_PER_M is the exact international foot', () => {
  assert.ok(Math.abs(FT_PER_M - 1 / 0.3048) < 1e-9);
});

test('formatLength in feet and meters', () => {
  assert.equal(formatLength(12.5, 'ft'), '12.5 ft');
  assert.equal(formatLength(12.5, 'm'), '3.8 m');
  assert.equal(formatLength(12.5, 'm', { precision: 2 }), '3.81 m');
  assert.equal(formatLength(-60, 'ft'), '-60.0 ft');
});

test('toDisplay / fromDisplay round trip', () => {
  assert.ok(Math.abs(fromDisplay(toDisplay(17, 'm'), 'm') - 17) < 1e-9);
  assert.equal(toDisplay(17, 'ft'), 17);
});

test('parseLength accepts plain numbers in the current unit', () => {
  assert.equal(parseLength('12.5', 'ft'), 12.5);
  assert.ok(Math.abs(parseLength('3.81', 'm') - 12.5) < 0.01);
});

test('parseLength honors explicit unit suffixes and feet-inches', () => {
  assert.ok(Math.abs(parseLength('3.81 m', 'ft') - 12.5) < 0.01);
  assert.equal(parseLength('12 ft', 'm'), 12);
  assert.equal(parseLength(`12'6"`, 'ft'), 12.5);
});

test('parseLength rejects garbage', () => {
  assert.equal(parseLength('', 'ft'), null);
  assert.equal(parseLength('abc', 'ft'), null);
  assert.equal(parseLength(undefined, 'ft'), null);
});
