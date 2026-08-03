import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLossLimitBreached,
  resolveFill,
  settlePnl,
  type EntryPlan,
} from '../src/services/strategy.js';

/** The plan a $100 stake produces at a 0.94 ask: 106.38 shares. */
function plan(over: Partial<EntryPlan> = {}): EntryPlan {
  return {
    side: 'UP',
    entryPrice: 0.94,
    spread: 0.01,
    askSize: 500,
    shares: 106.38,
    stakeUsd: 99.9972,
    ...over,
  };
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// === resolveFill ===

test('a full fill leaves the planned shares and stake untouched', () => {
  const o = resolveFill(plan(), 106.38, 0.94);
  assert.equal(o.status, 'filled');
  assert.equal(o.partial, false);
  assert.equal(o.shares, 106.38);
  assert.ok(close(o.stakeUsd, 99.9972));
});

test('matching more than planned never books more than planned', () => {
  // Defensive: the exchange should not over-fill a limit order, but if the
  // number comes back high we must not invent shares we did not buy.
  const o = resolveFill(plan(), 200, 0.94);
  assert.equal(o.shares, 106.38);
  assert.equal(o.partial, false);
});

test('a partial fill becomes a real position sized to what matched', () => {
  const o = resolveFill(plan(), 40, 0.93);
  assert.equal(o.status, 'filled', 'a partial fill is a position, not a cancel');
  assert.equal(o.partial, true);
  assert.equal(o.shares, 40);
  assert.ok(close(o.stakeUsd, 40 * 0.93), 'stake must reflect the price actually paid');
});

test('a partial fill with no reported price falls back to the limit price', () => {
  // A GTC buy can only fill at or below the posted limit, so this is a
  // conservative estimate of what was spent.
  const o = resolveFill(plan(), 40, null);
  assert.equal(o.shares, 40);
  assert.ok(close(o.stakeUsd, 40 * 0.94));
});

test('nothing matched is a cancel with no position', () => {
  const o = resolveFill(plan(), 0, null);
  assert.equal(o.status, 'cancelled');
  assert.equal(o.shares, 0);
  assert.equal(o.stakeUsd, 0);
  assert.equal(o.partial, false);
});

test('an unparseable or negative match count is treated as no fill', () => {
  for (const bad of [NaN, -5, Infinity]) {
    const o = resolveFill(plan(), bad, 0.94);
    assert.equal(o.status, 'cancelled', `expected cancel for ${bad}`);
    assert.equal(o.shares, 0);
  }
});

// === partial fills settle on the shares actually held ===

test('a partial position settles on its own share count, not the plan', () => {
  const o = resolveFill(plan(), 40, 0.93);
  // Win: each share pays out $1.
  assert.ok(close(settlePnl(o.shares, 0.93, true), 40 * 0.07));
  // Loss: only what was actually spent is lost.
  assert.ok(close(settlePnl(o.shares, 0.93, false), -40 * 0.93));
  // The unfilled remainder must not appear in either direction.
  assert.ok(
    Math.abs(settlePnl(o.shares, 0.93, false)) < Math.abs(settlePnl(106.38, 0.93, false))
  );
});

// === isLossLimitBreached ===

test('open exposure counts toward the daily loss limit', () => {
  // Realized alone is comfortably inside the limit...
  assert.equal(isLossLimitBreached(-100, 0, 300), false);
  // ...but three stakes in flight on the same 5-minute boundary are not.
  assert.equal(isLossLimitBreached(-100, 300, 300), true);
});

test('the limit trips exactly at the boundary', () => {
  assert.equal(isLossLimitBreached(-300, 0, 300), true);
  assert.equal(isLossLimitBreached(-299.99, 0, 300), false);
  assert.equal(isLossLimitBreached(0, 300, 300), true);
});

test('profit offsets open exposure', () => {
  assert.equal(isLossLimitBreached(200, 400, 300), false);
  assert.equal(isLossLimitBreached(200, 500, 300), true);
});
