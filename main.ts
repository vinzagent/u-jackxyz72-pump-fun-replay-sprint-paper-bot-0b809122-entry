// Pump.fun Replay Sprint (24-hour recorded window, 10 SOL paper): a
// dip-buying bot with an absorption filter. It buys established curves that
// have fallen from their high while strangers' net buying over the lookback
// stays strongly positive, risks a small fixed stake per idea, leaves on
// mechanical exits, and keeps a breadth floor of tiny round trips so the
// guardrail bar (a round trip of at least 0.01 SOL on at least 20 coins,
// drawdown at most 50%) is met early — a paid place additionally needs a
// net PnL above zero, which the conservative sizing is built to protect.
// The strategy lives in strategy.ts; the SDK shim is the kit's
// sdk/ts/makefun-bot.ts, vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, PARAMS_24H } from './strategy.ts';

await runBot(createStrategy(PARAMS_24H));
