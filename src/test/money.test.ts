import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  distribute, distributeByWeight, grossToAmount, minorUnits, money, netToAmount, round, sumMoney,
} from '../core/money';

describe('money', () => {
  test('rounds to the currency minor unit', () => {
    assert.equal(round(1.005, 'EUR'), 1.01);
    assert.equal(round(2.675, 'EUR'), 2.68);
    assert.equal(round(-1.005, 'EUR'), -1.01);
    // Yen has no minor unit, dinars have three.
    assert.equal(round(1234.56, 'JPY'), 1235);
    assert.equal(round(1.23456, 'KWD'), 1.235);
  });

  test('knows minor units per currency', () => {
    assert.equal(minorUnits('EUR'), 2);
    assert.equal(minorUnits('JPY'), 0);
    assert.equal(minorUnits('BHD'), 3);
    assert.equal(minorUnits('ZZZ'), 2);
  });

  test('splits gross into net and VAT', () => {
    const a = grossToAmount(119, 'Normal', 'EUR');
    assert.equal(a.grossAmount, 119);
    assert.equal(a.netAmount, 100);
    assert.equal(a.vatPercent, 19);

    const reduced = grossToAmount(107, 'Reduced', 'EUR');
    assert.equal(reduced.netAmount, 100);
    assert.equal(reduced.vatPercent, 7);

    const none = grossToAmount(50, 'Without', 'EUR');
    assert.equal(none.netAmount, 50);
    assert.equal(none.vatPercent, 0);
  });

  test('builds gross from net', () => {
    const a = netToAmount(100, 'Normal', 'EUR');
    assert.equal(a.grossAmount, 119);
    assert.equal(a.netAmount, 100);
  });

  test('distributes an amount without losing cents', () => {
    const parts = distribute(100, 3, 'EUR');
    assert.equal(parts.length, 3);
    assert.equal(round(parts.reduce((a, b) => a + b, 0), 'EUR'), 100);
    assert.deepEqual(parts, [33.34, 33.33, 33.33]);
  });

  test('distributes by weight and still sums exactly', () => {
    const parts = distributeByWeight(100, [1, 1, 1], 'EUR');
    assert.equal(round(parts.reduce((a, b) => a + b, 0), 'EUR'), 100);

    const skewed = distributeByWeight(10, [3, 1], 'EUR');
    assert.equal(round(skewed.reduce((a, b) => a + b, 0), 'EUR'), 10);
    assert.equal(skewed[0], 7.5);
  });

  test('sums money in one currency', () => {
    const total = sumMoney([money(1.1, 'EUR'), money(2.2, 'EUR'), money(3.3, 'EUR')], 'EUR');
    assert.equal(total.amount, 6.6);
  });
});
