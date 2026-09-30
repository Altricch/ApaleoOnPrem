import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, rejectImmutablePaths } from '../core/patch';
import { ApiError } from '../core/errors';

describe('JSON Patch', () => {
  test('replaces, adds and removes members', () => {
    const doc: Record<string, any> = { a: 1, b: { c: 2 }, list: [1, 2, 3] };
    applyPatch(doc, [
      { op: 'replace', path: '/a', value: 9 },
      { op: 'add', path: '/b/d', value: 4 },
      { op: 'remove', path: '/list/1' },
    ]);
    assert.equal(doc.a, 9);
    assert.equal(doc.b.d, 4);
    assert.deepEqual(doc.list, [1, 3]);
  });

  test('appends to an array with the `-` index', () => {
    const doc: Record<string, any> = { list: [1] };
    applyPatch(doc, [{ op: 'add', path: '/list/-', value: 2 }]);
    assert.deepEqual(doc.list, [1, 2]);
  });

  test('creates intermediate objects so nested adds work', () => {
    const doc: Record<string, any> = {};
    applyPatch(doc, [{ op: 'add', path: '/bankAccount/iban', value: 'DE00' }]);
    assert.deepEqual(doc.bankAccount, { iban: 'DE00' });
  });

  test('supports move, copy and test', () => {
    const doc: Record<string, any> = { a: 1, b: 2 };
    applyPatch(doc, [
      { op: 'test', path: '/a', value: 1 },
      { op: 'copy', from: '/a', path: '/c' },
      { op: 'move', from: '/b', path: '/d' },
    ]);
    assert.deepEqual(doc, { a: 1, c: 1, d: 2 });
  });

  test('a failing test aborts the whole patch', () => {
    const doc: Record<string, any> = { a: 1 };
    assert.throws(() => applyPatch(doc, [
      { op: 'replace', path: '/a', value: 2 },
      { op: 'test', path: '/a', value: 99 },
    ]), ApiError);
    // Nothing was applied, because the patch runs on a copy first.
    assert.equal(doc.a, 1);
  });

  test('rejects unknown operations and bad pointers', () => {
    assert.throws(() => applyPatch({}, [{ op: 'frobnicate' as any, path: '/a' }]), ApiError);
    assert.throws(() => applyPatch({}, [{ op: 'add', path: 'a', value: 1 }]), ApiError);
  });

  test('guards immutable paths', () => {
    assert.throws(
      () => rejectImmutablePaths([{ op: 'replace', path: '/code', value: 'X' }], ['/code']),
      ApiError,
    );
    assert.doesNotThrow(
      () => rejectImmutablePaths([{ op: 'replace', path: '/name', value: 'X' }], ['/code']),
    );
  });
});
