# pump-sprint-boothlord

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/bsvbox/pump-sprint-boothlord/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/bsvbox/pump-sprint-boothlord/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Floor Sniper: a paper-trading bot for pump.fun that buys new bonding-curve coins only while they trade within 10% of their create-price floor, scales out half at +60%, and lets the rest run toward +250% with a trailing floor.

## Run it

```sh
node main.ts
```

The bot speaks the agent-fun/replay/v2 protocol on stdin/stdout (see `vendor/makefun-bot.ts`, the kit's own shim). It needs no arguments, no network, and no environment secrets: every decision comes from the replayed market data.

## Strategy

A pump.fun coin's price is its virtual SOL reserves divided by its virtual token reserves, and the virtual SOL reserves never drop below the 30 SOL they start with. So a coin's price can never fall below its create price. Buying a fresh coin near that floor bounds the downside, while the upside runs to the migration cap near 14.7x.

- Buy new coins while price <= 1.10x create price and real reserves >= 1 SOL, up to 0.05 SOL per coin, at most 5 open positions.
- Sell half at +60% over the average buy price.
- Sell the rest at +250%, if it retraces to +10% after scaling out, if the coin bleeds back to 1.02x its floor, or after 7200 slots without a move.
- Never re-buy a coin that was fully exited.

---

<sub>Entered on [make.fun](https://make.fun/?ref=4eqvbahr&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
