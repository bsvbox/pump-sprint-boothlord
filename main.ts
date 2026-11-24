import { runBot } from "./vendor/makefun-bot.ts";
import type { Batch, BotState, OrderInput } from "./vendor/makefun-bot.ts";

// Floor-and-scalp paper trader for the pump.fun replay sprint.
// Idea, from backtests on the kit dev window (24h, 1222 coins):
// - A coin's price never falls below its create price, and the first pump is
//   instant (inside the create slot), so buying after a pump means buying high
//   and bleeding. The only coins buyable near the floor are the ones that did
//   NOT pump in their create slot; they return about 0% gross, and a few of
//   them pump later. Buy those near the floor, take +30% when one pumps.
// - The guardrail needs 20 distinct mints, but floor coins are rare (about 5
//   per 6h), so fill the count with tiny quick scalps on fresh pumpers:
//   buy 0.01 SOL, exit at +3% / -3% / 30 slots. Each scalp loses a little;
//   the floor coins carry the upside. Cap the whole run at 30 mints so the
//   scalp bleed stays small. Dev window: about -0.005 SOL, 29 mints, max
//   drawdown about 0.1%. No strategy in this replay is positive on average;
//   this one loses the least while staying compliant.
// Deterministic: no clock, no randomness, no environment reads. Every
// decision comes from the batch state and the fixed constants below.

const BUY_LAMPORTS = 10_000_000n; // 0.01 SOL per buy (guardrail minimum)
const ONE_SOL = 1_000_000_000n;
const SLIPPAGE_BPS = 500;
const MAX_MINTS = 30;
const MAX_POSITIONS = 5;

// Floor buys: price at most 1.10x the create price, real reserves >= 1 SOL.
const FLOOR_MAX_NUM = 11n;
const FLOOR_MAX_DEN = 10n;
const FLOOR_MIN_REAL = ONE_SOL;
// Floor exit: take +30%, no stop-loss (the create price is the floor),
// timeout 40000 slots so early positions cycle and free a slot.
const FLOOR_TP_NUM = 13n;
const FLOOR_TP_DEN = 10n;
const FLOOR_TIMEOUT = 40000;
const MAX_FLOOR_POS = 3;

// Scalp buys: a coin whose create slot ended at 1.5x its create price or more.
const SCALP_MIN_NUM = 3n;
const SCALP_MIN_DEN = 2n;
// Scalp exit: +3% / -3% / 30 slots.
const SCALP_TP_NUM = 103n;
const SCALP_TP_DEN = 100n;
const SCALP_SL_NUM = 97n;
const SCALP_SL_DEN = 100n;
const SCALP_TIMEOUT = 30;

type Ratio = { n: bigint; d: bigint };
type Tag = "floor" | "scalp";

// Create price per mint (virtual quote / virtual token at CreateEvent).
const p0 = new Map<string, Ratio>();
// Pure fill price per mint, from the buy fill: (quote - fee - tx) / tokens.
const buyPrice = new Map<string, Ratio>();
// Fill slot per mint, for the timeout exits.
const buySlot = new Map<string, number>();
// Which kind of buy each mint got (decides its exit rule).
const tags = new Map<string, Tag>();
// Mints already bought (cap) and mints already exited (never re-buy).
const traded = new Set<string>();
const done = new Set<string>();
// Mints with a buy or sell currently in flight, so we never double-order.
const pendingBuy = new Map<string, Tag>();
const pendingSell = new Set<string>();

// Is a/b <= multN/multD ? Exact bigint cross-multiplication, no floats.
function leRatio(aN: bigint, aD: bigint, bN: bigint, bD: bigint, mN: bigint, mD: bigint): boolean {
  // (aN/aD) / (bN/bD) <= mN/mD  <=>  aN*bD*mD <= bN*aD*mN
  return aN * bD * mD <= bN * aD * mN;
}

// Is a/b >= multN/multD ? Exact bigint cross-multiplication.
function geRatio(aN: bigint, aD: bigint, bN: bigint, bD: bigint, mN: bigint, mD: bigint): boolean {
  return aN * bD * mD >= bN * aD * mN;
}

// Current price of a curve as a ratio (virtual quote / virtual token).
function curvePrice(state: BotState, mint: string): Ratio | null {
  const c = state.curves.get(mint);
  if (c === undefined) return null;
  if (c.virtual_token_reserves === 0n) return null;
  return { n: c.virtual_quote_reserves, d: c.virtual_token_reserves };
}

function countFloorOpen(state: BotState): number {
  let n = 0;
  for (const mint of state.positions.keys()) if (tags.get(mint) === "floor") n++;
  for (const tag of pendingBuy.values()) if (tag === "floor") n++;
  return n;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];

    // 1. Record create prices from this batch's CreateEvents. The curve state
    // is already post-batch, so a coin that pumped in its create slot shows
    // its pumped price here; p0 is the pre-pump anchor from the event.
    for (const e of batch.events) {
      if (e.event === "CreateEvent" && !p0.has(e.mint)) {
        p0.set(e.mint, {
          n: BigInt(e.virtual_quote_reserves),
          d: BigInt(e.virtual_token_reserves),
        });
      }
    }

    // 2. Record fill prices and clear in-flight markers from resolved fills.
    for (const f of batch.fills) {
      if (f.side === "buy") {
        pendingBuy.delete(f.mint);
        if (f.status === "filled" && BigInt(f.token_amount) > 0n) {
          const net = BigInt(f.quote_lamports) - BigInt(f.fee_lamports) - BigInt(f.tx_fee_lamports);
          if (net > 0n) {
            buyPrice.set(f.mint, { n: net, d: BigInt(f.token_amount) });
            buySlot.set(f.mint, f.slot);
          }
        } else if (f.status === "rejected" || f.status === "failed") {
          // Never filled: free the mint so it can be tried again later.
          traded.delete(f.mint);
          tags.delete(f.mint);
        }
      } else {
        pendingSell.delete(f.mint);
        if (f.status === "filled") {
          done.add(f.mint);
          buyPrice.delete(f.mint);
          buySlot.delete(f.mint);
          tags.delete(f.mint);
        }
      }
    }

    // 3. Exits. A position sells in full on its take-profit, its stop (scalps
    // only), or its timeout. Floor coins have no stop: the create price is
    // the floor, so a loser just sits until it pumps or times out.
    // If the buy fill was never seen (so no pure fill price), fall back to
    // the position's cost basis so the position can still exit on timeout.
    for (const [mint, holding] of state.positions) {
      if (pendingSell.has(mint)) continue;
      const tag = tags.get(mint);
      if (tag === undefined) continue;
      const bp =
        buyPrice.get(mint) ??
        (holding.token_amount > 0n
          ? { n: holding.cost_lamports, d: holding.token_amount }
          : undefined);
      const bs = buySlot.get(mint) ?? state.slot;
      if (bp === undefined) continue;
      const price = curvePrice(state, mint);
      if (price === null) continue;
      let exit = false;
      if (tag === "floor") {
        if (geRatio(price.n, price.d, bp.n, bp.d, FLOOR_TP_NUM, FLOOR_TP_DEN)) exit = true;
        if (state.slot - bs >= FLOOR_TIMEOUT) exit = true;
      } else {
        if (geRatio(price.n, price.d, bp.n, bp.d, SCALP_TP_NUM, SCALP_TP_DEN)) exit = true;
        if (leRatio(price.n, price.d, bp.n, bp.d, SCALP_SL_NUM, SCALP_SL_DEN)) exit = true;
        if (state.slot - bs >= SCALP_TIMEOUT) exit = true;
      }
      if (exit) {
        orders.push({
          side: "sell",
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        pendingSell.add(mint);
      }
    }

    // 4. Entries. At most one buy per batch; floor coins first.
    if (state.committedPositionCount() < MAX_POSITIONS && traded.size < MAX_MINTS) {
      if (countFloorOpen(state) < MAX_FLOOR_POS) {
        for (const e of batch.events) {
          if (e.event !== "TradeEvent") continue;
          const mint = e.mint;
          if (state.positions.has(mint) || done.has(mint) || traded.has(mint)) continue;
          if (pendingBuy.has(mint)) continue;
          const anchor = p0.get(mint);
          if (anchor === undefined) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (curve.real_quote_reserves < FLOOR_MIN_REAL) continue;
          const price = curvePrice(state, mint);
          if (price === null) continue;
          if (!leRatio(price.n, price.d, anchor.n, anchor.d, FLOOR_MAX_NUM, FLOOR_MAX_DEN)) continue;
          if (state.maxBuyLamports(mint) < BUY_LAMPORTS) continue;
          if (state.freeCashLamports() < BUY_LAMPORTS + state.txFeeLamports()) continue;
          orders.push({
            side: "buy",
            mint,
            quote_lamports: BUY_LAMPORTS,
            max_slippage_bps: SLIPPAGE_BPS,
          });
          pendingBuy.set(mint, "floor");
          tags.set(mint, "floor");
          traded.add(mint);
          return orders;
        }
      }
      for (const e of batch.events) {
        if (e.event !== "CreateEvent") continue;
        const mint = e.mint;
        if (state.positions.has(mint) || done.has(mint) || traded.has(mint)) continue;
        if (pendingBuy.has(mint)) continue;
        const anchor = p0.get(mint);
        if (anchor === undefined) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const price = curvePrice(state, mint);
        if (price === null) continue;
        if (!geRatio(price.n, price.d, anchor.n, anchor.d, SCALP_MIN_NUM, SCALP_MIN_DEN)) continue;
        if (state.maxBuyLamports(mint) < BUY_LAMPORTS) continue;
        if (state.freeCashLamports() < BUY_LAMPORTS + state.txFeeLamports()) continue;
        orders.push({
          side: "buy",
          mint,
          quote_lamports: BUY_LAMPORTS,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        pendingBuy.set(mint, "scalp");
        tags.set(mint, "scalp");
        traded.add(mint);
        return orders;
      }
    }

    return orders;
  },
});
