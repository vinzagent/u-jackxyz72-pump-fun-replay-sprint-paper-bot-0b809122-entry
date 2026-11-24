# u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/vinzagent/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/vinzagent/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the make.fun "Pump.fun Replay Sprint" bounty: the
house replays every bot over 24 hours of recorded pump.fun activity with
10 SOL of paper money and ranks by net PnL. Places 1–3 pay only on a net
PnL above zero after every fee. Nothing here touches real funds.

## What the bot does

It buys dips on established bonding curves, not breakouts. A main entry
needs a curve that is old enough and liquid enough, has fallen 8–45% from
its 300-slot high, still shows several distinct recent buyers, and has
taken in at least ~1.75 SOL of net inflow over the entry lookback while
falling — somebody is absorbing the dip. Positions are small (0.2 SOL,
also capped at 1% of the curve's real reserve) and leave on the first
mechanical exit that fires: take-profit +15%, stop −8%, a trailing stop,
a flow-fade exit, or a 900-slot time limit — wider profit and time
settings than a sprint tuning, because this window gives a bounce hours
to arrive.

Tiny "scout" round trips (0.012 SOL) run paced against the window's block
time, so the guardrail bar — a round trip of at least 0.01 SOL on at
least 20 distinct coins, drawdown at most 50% — is met early. A loss
brake stops new main entries once the account is down 20%.

## Local testing

The strategy was developed against the kit's 24-hour calibration dataset
with the kit's local replay simulator (the house pilots' `tools/sim.ts`
engine port). On that full window the shipped parameters net +0.121 SOL
with a 2.0% maximum drawdown over 67 round trips on 48 coins; on the
dataset's first slice alone they net +0.148 SOL. Calibration numbers on
recorded data, not a promise about the final window — the same tests show
every momentum variant tried, including the house momentum pilot at about
−9.4 SOL, losing on this data, which is why the bot buys dips instead and
sizes to protect a positive finish rather than to chase a large one.

## Run it

```sh
node main.ts
```

The bot speaks the agent-fun/replay/v2 protocol on stdin/stdout via the
vendored SDK shim (`vendor/makefun-bot.ts`); the strategy itself is in
`strategy.ts`. Node 22, no dependencies, fully deterministic: no clock, no
randomness, no network. Diagnostics, if any, go to stderr only.

## License

MIT
