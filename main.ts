// Floor Sniper: a paper-trading bot for pump.fun bonding curves.
//
// Idea, from the curve math itself: a pump.fun coin's price is
// virtual_sol_reserves / virtual_token_reserves, and the virtual SOL
// reserves never drop below the 30 SOL they start with. So a coin's
// price can never fall below its create price p0. Buying a fresh coin
// while it still trades near its floor bounds the downside to
// (buy_price - p0) / buy_price, while the upside runs to the
// migration cap near 14.7x p0. The bot therefore buys new coins only
// while they sit within 10% of their floor, scales out half at +60%,
// lets the rest run toward +250% with a +10% trailing floor, and frees
// the slot when a coin bleeds back to its floor or stalls too long.
//
// The harness caps each buy at 1% of the coin's real SOL reserves, so
// early entries are small (0.01 SOL once real reserves reach 1 SOL)
// and the bot tops a position up toward 0.05 SOL while the coin stays
// near its floor. At most 5 positions are open at once.
//
// Fully deterministic: every decision comes from the harness state and
// the batch; no clock, no Math.random, no network, no environment.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
} from "./vendor/makefun-bot.ts";

// ------------------------------------------------------------------ tuning

const MAX_OPEN_POSITIONS = 5;
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL, the guardrail minimum
const MAX_PER_COIN_LAMPORTS = 50_000_000n; // 0.05 SOL per coin
const MIN_REAL_RESERVES_LAMPORTS = 1_000_000_000n; // 1 SOL of real reserves
const BUY_CEILING_MULT = 1.1; // only buy while price <= 1.10x create price
const FLOOR_STOP_MULT = 1.02; // coin bled back to its floor: exit, free slot
const TAKE_PROFIT_1 = 0.6; // sell half at +60%
const TAKE_PROFIT_2 = 2.5; // sell the rest at +250%
const TRAIL_FLOOR = 0.1; // after scaling out, sell rest if back to +10%
const STOP_LOSS = -0.25; // safety net, rarely hit given the price floor
const TIMEOUT_SLOTS = 7200; // ~48 min of slots: stall out, free the slot
const FLOOR_STOP_MIN_AGE_SLOTS = 200;
const MAX_SLIPPAGE_BPS = 500;
const MAX_ORDERS_PER_BATCH = 16;

// ------------------------------------------------------------------ tracking

interface Coin {
  /** Create price in SOL per token. */
  p0: number;
  /** Slot the CreateEvent arrived. */
  createdSlot: number;
}

interface Held {
  /** Slot the position first showed up in the account. */
  sinceSlot: number;
  /** True once half was sold at TAKE_PROFIT_1. */
  scaled: boolean;
}

const coins = new Map<string, Coin>();
const held = new Map<string, Held>();
/** Mints fully exited: never buy again, avoid churn. */
const done = new Set<string>();
/** Lamports spent buying each mint (fills seen so far). */
const spent = new Map<string, bigint>();

function priceOf(state: BotState, mint: string): number | null {
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  const quote = Number(curve.virtual_quote_reserves);
  const tokens = Number(curve.virtual_token_reserves);
  if (tokens <= 0) return null;
  return quote / tokens;
}

function pendingBuyLamports(state: BotState, mint: string): bigint {
  let total = 0n;
  for (const pending of state.pending.values()) {
    if (pending.order.side === "buy" && pending.order.mint === mint) {
      total += BigInt(pending.order.quote_lamports);
    }
  }
  return total;
}

// ------------------------------------------------------------------ decisions

function decideSells(state: BotState): OrderInput[] {
  const orders: OrderInput[] = [];
  for (const [mint, holding] of state.positions) {
    const price = priceOf(state, mint);
    if (price === null) continue;
    const avgBuy =
      Number(holding.cost_lamports) / Number(holding.token_amount);
    if (avgBuy <= 0) continue;
    const ret = price / avgBuy - 1;
    const coin = coins.get(mint);
    const age = state.slot - (held.get(mint)?.sinceSlot ?? state.slot);

    // Half out at the first take-profit.
    if (!held.get(mint)?.scaled && ret >= TAKE_PROFIT_1) {
      const half = holding.token_amount / 2n;
      if (half > 0n) {
        orders.push({
          side: "sell",
          mint,
          token_amount: half,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        const h = held.get(mint);
        if (h !== undefined) h.scaled = true;
      }
      continue;
    }

    // Rest out at the big target, on the trailing floor, on a stop, on
    // the floor bleed-back, or on timeout.
    const scaled = held.get(mint)?.scaled ?? false;
    const floorDead =
      coin !== undefined &&
      price <= coin.p0 * FLOOR_STOP_MULT &&
      ret < 0 &&
      age >= FLOOR_STOP_MIN_AGE_SLOTS;
    if (
      (scaled && (ret >= TAKE_PROFIT_2 || ret <= TRAIL_FLOOR)) ||
      (!scaled && ret <= STOP_LOSS) ||
      floorDead ||
      age >= TIMEOUT_SLOTS
    ) {
      orders.push({
        side: "sell",
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
  }
  return orders;
}

function decideBuys(state: BotState, alreadyCommitted: number): OrderInput[] {
  const orders: OrderInput[] = [];
  const free = state.freeCashLamports();
  // Keep a cash buffer so sells and fees always clear.
  let budget = free / 2n;
  if (budget < MIN_BUY_LAMPORTS) return orders;

  for (const [mint, coin] of coins) {
    if (orders.length + alreadyCommitted >= MAX_ORDERS_PER_BATCH) break;
    if (done.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const price = priceOf(state, mint);
    if (price === null || price > coin.p0 * BUY_CEILING_MULT) continue;
    if (curve.real_quote_reserves < MIN_REAL_RESERVES_LAMPORTS) continue;

    const alreadySpent =
      (spent.get(mint) ?? 0n) + pendingBuyLamports(state, mint);
    const remaining = MAX_PER_COIN_LAMPORTS - alreadySpent;
    if (remaining < MIN_BUY_LAMPORTS) continue;

    const committed = state.committedPositionCount();
    const isNew = !state.positions.has(mint);
    if (isNew && committed >= MAX_OPEN_POSITIONS) continue;
    if (!isNew && committed > MAX_OPEN_POSITIONS) continue;

    const cap = state.maxBuyLamports(mint);
    let size = remaining < cap ? remaining : cap;
    if (size > budget) size = budget;
    if (size < MIN_BUY_LAMPORTS) continue;

    orders.push({
      side: "buy",
      mint,
      quote_lamports: size,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    budget -= size;
    if (budget < MIN_BUY_LAMPORTS) break;
  }
  return orders;
}

// ------------------------------------------------------------------ bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    // Register new coins and refresh nothing else: the shim keeps the
    // curves current; only the create price needs our own memory.
    for (const event of batch.events) {
      if (event.event === "CreateEvent" && !coins.has(event.mint)) {
        const p0 =
          Number(event.virtual_sol_reserves) /
          Number(event.virtual_token_reserves);
        if (p0 > 0) {
          coins.set(event.mint, { p0, createdSlot: event.slot });
        }
      }
    }

    // Fills seen this batch: track spend and position starts.
    for (const fill of batch.fills) {
      if (fill.status !== "filled") continue;
      if (fill.side === "buy") {
        spent.set(
          fill.mint,
          (spent.get(fill.mint) ?? 0n) + BigInt(fill.quote_lamports),
        );
      }
    }

    // Positions that appeared: note when they started.
    for (const mint of state.positions.keys()) {
      if (!held.has(mint)) {
        held.set(mint, { sinceSlot: state.slot, scaled: false });
      }
    }
    // Positions that vanished (sold, completed, flattened): never rebuy.
    for (const mint of [...held.keys()]) {
      if (
        !state.positions.has(mint) &&
        pendingBuyLamports(state, mint) === 0n
      ) {
        held.delete(mint);
        done.add(mint);
      }
    }

    const sells = decideSells(state);
    const buys = decideBuys(state, sells.length);
    return [...sells, ...buys];
  },
});
