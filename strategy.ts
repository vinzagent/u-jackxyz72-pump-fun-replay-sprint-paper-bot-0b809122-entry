// Dip-buying strategy with an absorption filter, written for the 24-hour
// pump.fun replay window of this competition (agent-fun/replay/v2).
//
// Why dips and not breakouts: on the kit's 24-hour calibration window every
// momentum variant tested while building this entry lost money, the house
// momentum pilot catastrophically so (about -9.4 SOL with a 95% drawdown on
// the calibration slice). On pump.fun curves, visible strength is usually
// early holders advertising for exit liquidity. What survived testing is
// the opposite posture:
//
//  1. Buy only established curves — old enough, with a real reserve and a
//     tape of several distinct buyers — after the price has fallen 8–45%
//     from its 300-slot high, and only while the tape says the fall is
//     being absorbed: net flow over the entry lookback still strongly
//     positive (at least ~1.75 SOL more bought than sold) and the shortest
//     window no longer bleeding. One wallet dominating the lookback's
//     buying disqualifies the coin.
//  2. Risk a fixed small stake (0.2 SOL, also capped at 1% of the curve's
//     real reserve, at most four main positions and 1 SOL of open cost),
//     and leave mechanically: take-profit at +15%, stop at -8%, a trailing
//     stop after a small run, a fade exit when short-window flow turns,
//     and a 900-slot time limit. The longer window of this competition is
//     why the take-profit and the time limit sit wider than a sprint
//     tuning would: a bounce here has hours, not minutes, to arrive.
//  3. Keep the breadth floor the guardrails ask for (a round trip of at
//     least 0.01 SOL on at least 20 coins, drawdown at most 50%): tiny
//     0.012 SOL scout round trips on calm liquid curves, paced against the
//     24 hours of block time so the count is banked early. A loss brake
//     halts new main entries at -20% equity; scouts keep running.
//
// Decisions come from the batch stream alone — no clock, no randomness, no
// environment — and iteration follows insertion order, so two runs over
// the same data emit identical orders.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Slots of tape the entry signal reads. */
  lookback: number;
  /** Slots of tape the fade exit reads. */
  fadeLookback: number;
  /** Curve must be at least this many slots old before a main entry. */
  minAgeSlots: number;
  /** Real SOL reserve bounds for a main entry. */
  minReserveSol: number;
  maxReserveSol: number;
  /** Buy trades and distinct buying wallets over the lookback. */
  minBuyTrades: number;
  minDistinctBuyers: number;
  /** Slots of tape the drawdown is measured over. */
  highLookback: number;
  /** Net flow over the whole lookback must be at least this (absorption). */
  minLookbackFlowSol: number;
  /** Last price must sit between these shares below the lookback high. */
  dipMin: number;
  dipMax: number;
  /** Largest single buyer's share of lookback buy SOL; above it, skip. */
  maxTopBuyerShare: number;
  /** Sell the whole position once close value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** SOL risked on one main position (before the reserve size cap). */
  stakeSol: number;
  /** Most main positions open at once (one slot stays free for scouts). */
  maxMainPositions: number;
  /** Most SOL of cost open across main positions at once. */
  maxExposureSol: number;
  /** Buy slippage tolerance (bps). Sells always go out wide open. */
  buySlippageBps: number;
  /** Exit when close value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms at cost * (1 + trailArm), exits at peak * (1 - trailDrop). */
  trailArm: number;
  trailDrop: number;
  /** Exit when net flow over fadeLookback drops below -fadeOutflowSol. */
  fadeOutflowSol: number;
  /** Exit after this many slots unless the position is up holdIfUp or more. */
  maxHoldSlots: number;
  holdIfUp: number;
  /** Slots after an exit before the same coin can be entered again. */
  cooldownSlots: number;
  /** Most main entries per coin over the whole run. */
  maxEntriesPerCoin: number;
  /** Stop new main entries when equity falls below start * (1 - lossBrake). */
  lossBrake: number;
  /** Breadth floor: distinct coins to round-trip, and the size that counts. */
  breadthTarget: number;
  breadthMinBuySol: number;
  /** Scout round-trip size (SOL) and the calm-tape bounds it accepts. */
  scoutSol: number;
  scoutMinReserveSol: number;
  scoutMaxDrop: number;
  scoutMaxGain: number;
  /** Expected length of the scored window, for pacing the breadth floor. */
  windowSeconds: number;
}

export const PARAMS_24H: Params = {
  lookback: 60,
  fadeLookback: 18,
  minAgeSlots: 900,
  minReserveSol: 5,
  maxReserveSol: 85,
  minBuyTrades: 4,
  minDistinctBuyers: 4,
  highLookback: 300,
  // The absorption floor and the 0.2 stake are the two settings the
  // calibration window separates on: weaker flow or a 0.25 stake both flip
  // the same signal negative there, the values here stay positive on the
  // full window and on its first slice.
  minLookbackFlowSol: 1.75,
  dipMin: 0.08,
  dipMax: 0.45,
  maxTopBuyerShare: 0.6,
  takeProfit: 0.15,
  stakeSol: 0.2,
  maxMainPositions: 4,
  maxExposureSol: 1.0,
  buySlippageBps: 1500,
  stopLoss: 0.08,
  trailArm: 0.05,
  trailDrop: 0.1,
  fadeOutflowSol: 0.5,
  maxHoldSlots: 900,
  holdIfUp: 0.1,
  cooldownSlots: 300,
  maxEntriesPerCoin: 2,
  lossBrake: 0.2,
  breadthTarget: 24,
  breadthMinBuySol: 0.01,
  scoutSol: 0.012,
  scoutMinReserveSol: 3,
  scoutMaxDrop: 0.05,
  scoutMaxGain: 0.15,
  windowSeconds: 86_400,
};

const SOL = 1e9;
/** Curve fee share the close-value estimate assumes (protocol + creator, rounded up). */
const CURVE_FEE_SHARE = 0.013;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  createdSlot: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExitSlot: number;
}

interface Held {
  openedSlot: number;
  peakValueSol: number;
  exiting: boolean;
  filled: boolean;
}

export function createStrategy(p: Params): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Scout round trips in flight, by mint: false while the buy is pending, true once held. */
  const scouts = new Map<Pubkey, boolean>();
  /** Largest filled own buy per coin (SOL): what makes a closed coin count for the breadth floor. */
  const biggestBuy = new Map<Pubkey, number>();
  /** Coins whose round trip has closed with a big enough buy. */
  const roundTripped = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  let startCapitalSol = 0;
  const keepSlots = Math.max(p.lookback, p.fadeLookback, p.highLookback) + 15;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { createdSlot: null, trades: [], entries: 0, lastExitSlot: -1_000_000_000 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net signed SOL flow over the last `span` slots of a tape. */
  const netFlow = (t: Tape, now: number, span: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - span) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Price change across the lookback, or null when the tape cannot say. */
  const windowGain = (t: Tape, now: number, span: number): number | null => {
    let first = -1;
    let last = -1;
    for (const tr of t.trades) {
      if (tr.slot <= now - span) {
        first = tr.price;
        continue;
      }
      if (first < 0) first = tr.price;
      last = tr.price;
    }
    if (first <= 0 || last <= 0) return null;
    return last / first - 1;
  };

  /**
   * The entry test: an established curve, down from its high, tape
   * absorbing. Drawdown inside dipMin..dipMax of the highLookback high,
   * several distinct buyers in the short lookback, no single dominant
   * buyer, short-window flow no longer deeply negative, and net lookback
   * flow at or above the absorption floor.
   */
  const entryOk = (t: Tape, now: number, reserveSol: number): boolean => {
    if (reserveSol < p.minReserveSol || reserveSol > p.maxReserveSol) return false;
    if (t.createdSlot === null || now - t.createdSlot < p.minAgeSlots) return false;
    const from = now - p.lookback;
    let buySol = 0;
    let buyTrades = 0;
    const perBuyer = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from || !tr.buy) continue;
      buySol += tr.sol;
      buyTrades++;
      perBuyer.set(tr.user, (perBuyer.get(tr.user) ?? 0) + tr.sol);
    }
    if (buyTrades < p.minBuyTrades || perBuyer.size < p.minDistinctBuyers) return false;
    let top = 0;
    for (const v of perBuyer.values()) if (v > top) top = v;
    if (buySol > 0 && top > p.maxTopBuyerShare * buySol) return false;
    let high = 0;
    let last = 0;
    for (const tr of t.trades) {
      if (tr.slot <= now - p.highLookback) continue;
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (high <= 0 || last <= 0) return false;
    const dip = 1 - last / high;
    if (dip < p.dipMin || dip > p.dipMax) return false;
    if (netFlow(t, now, p.fadeLookback) < -p.fadeOutflowSol) return false;
    if (netFlow(t, now, p.lookback) < p.minLookbackFlowSol) return false;
    return true;
  };

  /** What closing a position right now would net, in SOL, fees and tx fee out. */
  const closeValueSol = (state: BotState, mint: Pubkey, tokens: bigint): number => {
    const curve = state.curves.get(mint);
    if (curve === undefined) return 0;
    const vq = Number(curve.virtual_quote_reserves);
    const vt = Number(curve.virtual_token_reserves);
    const t = Number(tokens);
    if (!(vq > 0) || !(vt > 0) || !(t > 0)) return 0;
    const gross = (t * vq) / (vt + t) / SOL;
    return gross * (1 - CURVE_FEE_SHARE) - Number(state.txFeeLamports()) / SOL;
  };

  return {
    onHello(state: BotState) {
      startCapitalSol = Number(state.hello.capital.lamports) / SOL;
    },

    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const caps = state.hello.caps;
      const txSol = Number(state.txFeeLamports()) / SOL;
      const tradedThisBatch = new Set<Pubkey>();

      // Fold the batch's own fills into the breadth bookkeeping.
      for (const f of batch.fills) {
        if (f.status !== 'filled' || f.client_id.startsWith('_')) continue;
        if (f.side === 'buy') {
          const sol = Number(f.quote_lamports) / SOL;
          if (sol > (biggestBuy.get(f.mint) ?? 0)) biggestBuy.set(f.mint, sol);
        }
      }
      // Fold the batch's events into the tapes.
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).createdSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const vt = Number(e.virtual_token_reserves);
          const price = vt > 0 ? Number(e.virtual_quote_reserves) / vt : 0;
          tapeOf(e.mint).trades.push({ slot: e.slot, buy: e.is_buy, sol: Number(e.sol_amount) / SOL, user: e.user, price });
          tradedThisBatch.add(e.mint);
        }
      }
      for (const mint of tradedThisBatch) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keepSlots) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
      for (const po of state.pending.values()) {
        const cur = pendingByMint.get(po.order.mint) ?? { buy: false, sell: false };
        if (po.order.side === 'buy') cur.buy = true;
        else cur.sell = true;
        pendingByMint.set(po.order.mint, cur);
      }
      const hasPending = (mint: Pubkey) => pendingByMint.has(mint);

      // A position that vanished with nothing in flight has closed: settle
      // the books for the breadth floor and the cooldown clock.
      for (const [mint, h] of held) {
        if (!state.positions.has(mint) && !hasPending(mint)) {
          held.delete(mint);
          if (h.filled) {
            tapeOf(mint).lastExitSlot = now;
            if ((biggestBuy.get(mint) ?? 0) >= p.breadthMinBuySol) roundTripped.add(mint);
          } else {
            tapeOf(mint).entries--;
          }
        }
      }
      for (const mint of scouts.keys()) {
        if (!state.positions.has(mint) && !hasPending(mint)) {
          scouts.delete(mint);
          if ((biggestBuy.get(mint) ?? 0) >= p.breadthMinBuySol) roundTripped.add(mint);
        }
      }

      const orders: OrderInput[] = [];
      let freeSol = Number(state.freeCashLamports()) / SOL;

      // --- Exits first: a held main position leaves on the first rule that fires.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        h.filled = true;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const value = closeValueSol(state, mint, pos.token_amount);
        const cost = Number(pos.cost_lamports) / SOL;
        if (value > h.peakValueSol) h.peakValueSol = value;
        let exit = h.exiting;
        if (!exit && cost > 0 && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && cost > 0 && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && cost > 0 && h.peakValueSol >= cost * (1 + p.trailArm) && value < h.peakValueSol * (1 - p.trailDrop)) exit = true;
        if (!exit && netFlow(tapeOf(mint), now, p.fadeLookback) < -p.fadeOutflowSol) exit = true;
        if (!exit && now - h.openedSlot > p.maxHoldSlots && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        const pend = pendingByMint.get(mint);
        if (pend !== undefined && pend.sell) continue;
        if (orders.length >= caps.max_orders_per_batch) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // --- Scouts already holding: sell the whole scout back at once.
      for (const [mint, selling] of scouts) {
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete || hasPending(mint)) continue;
        if (orders.length >= caps.max_orders_per_batch) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) scouts.set(mint, true);
      }

      // --- Equity for the loss brake: cash plus what the book would close for.
      let equity = Number(state.cash) / SOL;
      for (const [mint, pos] of state.positions) equity += Math.max(0, closeValueSol(state, mint, pos.token_amount));
      const brakeOn = startCapitalSol > 0 && equity < startCapitalSol * (1 - p.lossBrake);

      // --- Main entries: only on curves that traded this batch, signal first.
      let mainOpen = 0;
      let exposure = 0;
      for (const [mint, pos] of state.positions) {
        if (held.has(mint)) {
          mainOpen++;
          exposure += Number(pos.cost_lamports) / SOL;
        }
      }
      for (const po of state.pending.values()) {
        if (po.order.side === 'buy' && held.has(po.order.mint)) exposure += Number(po.order.quote_lamports) / SOL;
      }
      let slotsLeft = caps.max_open_positions - state.committedPositionCount();
      if (!brakeOn) {
        for (const mint of tradedThisBatch) {
          if (orders.length >= caps.max_orders_per_batch) break;
          if (slotsLeft <= 0 || mainOpen >= p.maxMainPositions) break;
          if (held.has(mint) || scouts.has(mint) || hasPending(mint) || state.positions.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const t = tapeOf(mint);
          if (t.entries >= p.maxEntriesPerCoin || now - t.lastExitSlot < p.cooldownSlots) continue;
          const reserveSol = Number(curve.real_quote_reserves) / SOL;
          if (!entryOk(t, now, reserveSol)) continue;
          const capSol = Number(state.maxBuyLamports(mint)) / SOL;
          let amount = Math.min(p.stakeSol, capSol, p.maxExposureSol - exposure, freeSol - txSol);
          if (amount < p.breadthMinBuySol) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * SOL)), max_slippage_bps: p.buySlippageBps });
          held.set(mint, { openedSlot: now, peakValueSol: 0, exiting: false, filled: false });
          t.entries++;
          freeSol -= amount + txSol;
          exposure += amount;
          mainOpen++;
          slotsLeft--;
        }
      }

      // --- Breadth floor: if closed round trips lag the window's pace, open
      // a scout on a calm liquid curve that traded this batch.
      if (firstBlockTime !== null && lastBlockTime !== null && roundTripped.size < p.breadthTarget) {
        const elapsedShare = Math.min(1, (lastBlockTime - firstBlockTime) / p.windowSeconds);
        const due = Math.ceil(p.breadthTarget * Math.min(1, elapsedShare * 1.2));
        const inFlight = [...scouts.keys()].filter((m) => !roundTripped.has(m)).length;
        if (roundTripped.size + inFlight < due && slotsLeft > 0 && scouts.size < 2) {
          for (const mint of tradedThisBatch) {
            if (orders.length >= caps.max_orders_per_batch) break;
            if (held.has(mint) || scouts.has(mint) || hasPending(mint) || state.positions.has(mint)) continue;
            if (roundTripped.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const reserveSol = Number(curve.real_quote_reserves) / SOL;
            if (reserveSol < p.scoutMinReserveSol) continue;
            const t = tapeOf(mint);
            if (t.trades.length < 3) continue;
            const gain = windowGain(t, now, p.lookback);
            if (gain === null || gain < -p.scoutMaxDrop || gain > p.scoutMaxGain) continue;
            const capSol = Number(state.maxBuyLamports(mint)) / SOL;
            if (capSol < p.scoutSol) continue;
            if (freeSol < p.scoutSol + 2 * txSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.scoutSol * SOL)), max_slippage_bps: p.buySlippageBps });
            scouts.set(mint, false);
            freeSol -= p.scoutSol + txSol;
            slotsLeft--;
            break;
          }
        }
      }

      return orders;
    },
  };
}
