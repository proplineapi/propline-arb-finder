# propline-arb-finder

Live cross-book 2-way arbitrage scanner powered by the [PropLine API](https://prop-line.com/?ref=github).

When two sportsbooks disagree on a complementary outcome — e.g. one offers Over 8.5 at +110, another offers Under 8.5 at -100 — the sum of their implied probabilities can drop below 100%. Splitting your stake across both books in proportion to those probabilities locks in a guaranteed profit, regardless of which side wins. This is "arb" or "sure betting."

This is a reference implementation (~250 LOC) showing how to use the [`propline`](https://www.npmjs.com/package/propline) Node SDK to do exactly that, across every book PropLine ingests (Bovada, DraftKings, FanDuel, Pinnacle, Unibet).

## Quickstart

```bash
git clone https://github.com/proplineapi/propline-arb-finder
cd propline-arb-finder
npm install

export PROPLINE_API_KEY=...   # free key at https://prop-line.com/?ref=github
npm start -- --sport baseball_mlb --bankroll 1000
```

Sample output:

```
Fetching baseball_mlb events…
Scanning 8 upcoming events…

ARB +2.34%  ·  Yankees @ Red Sox  ·  totals  o/u 8.5
  Over   8.5    @  Bovada      +110    stake $476.20
  Under  8.5    @  FanDuel     -100    stake $523.80
  Pay either side: $1023.40 → guaranteed profit $23.40

ARB +0.42%  ·  Aaron Judge · batter_total_bases  o/u 1.5
  Over   1.5    @  DraftKings  +130    stake $434.13
  Under  1.5    @  Unibet      -135    stake $565.87
  Pay either side: $1004.20 → guaranteed profit $4.20

Found 2 arbs. Real markets vanish in seconds — verify each book still posts the price before placing.
```

## CLI flags

| Flag           | Default | Notes |
| -------------- | ------- | ----- |
| `--sport`      | _required_ | PropLine sport key, e.g. `baseball_mlb`, `basketball_nba`. Full list at `GET /v1/sports`. |
| `--bankroll`   | `1000`  | Total stake across both legs (USD). |
| `--min-edge`   | `0`     | Skip arbs below this edge percent. Set to `0.5` to filter noise. |
| `--markets`    | _all_   | Comma-separated PropLine market keys, e.g. `totals,h2h,batter_total_bases`. |

## What's covered

This example scans 2-way markets where the complement is unambiguous:

- **Totals** (Over/Under)
- **h2h** for two-team sports (MLB, NBA, NHL, NFL — explicitly skips soccer because soccer h2h is 3-way: Home/Draw/Away).
- **Yes/No** player props (anytime goalscorer, double-double, etc.).
- **Player prop O/U** (every market PropLine grades — strikeouts, points, total bases, etc.).

## What's intentionally skipped

- **Spreads** (`-1.5` favorite vs `+1.5` dog). Their complement requires favorite-aware bucketing — the same logic PropLine's `/ev` endpoint already does internally. Adding it here would double the LOC; this example is meant to be readable, not exhaustive.
- **3-way markets** (soccer h2h, correct score, etc.). Same idea (`p_home + p_draw + p_away < 1` → arb), but the stake split is a 3-vector. Easy follow-on.
- **DFS books** (PrizePicks, Underdog). Their prices aren't true book odds — payouts scale with parlay correctness — so they shouldn't be paired with fixed-odds books for arb.

## How the math works

For a 2-way arb between two books:

```
implied_A = americanToImpliedProb(price_A)    // 1 / decimal_A
implied_B = americanToImpliedProb(price_B)    // 1 / decimal_B
book_sum  = implied_A + implied_B

if book_sum < 1:
  edge_pct  = (1 - book_sum) * 100
  stake_A   = bankroll * implied_A / book_sum
  stake_B   = bankroll * implied_B / book_sum
  # whichever leg wins, payout = stake_A * decimal_A == stake_B * decimal_B
```

See [`src/arb.ts`](src/arb.ts) for the full implementation.

## Reality check

Arbs in liquid US markets are rare and short-lived — most disappear within seconds of a line move. This tool finds them; placing them in time is a separate problem (book account speed, deposit limits, automated betting being against most books' ToS).

It's most useful as:
- A **CLV signal**: an arb means at least one book has a softer line than its peers right now. Even if you can't place both legs, you can take the soft side as a +EV bet.
- A **line-quality dashboard**: scan periodically, see which books drift; build intuition for where the soft money sits.

## Links

- **Player props API** (markets, books, sports covered): [prop-line.com/player-props-api](https://prop-line.com/player-props-api?ref=github)
- Endpoints this tool uses: [`/odds` per event](https://prop-line.com/docs?ref=github#player-props) and [`/best-line`](https://prop-line.com/docs?ref=github#best-line)
- [Odds API by sport and market](https://prop-line.com/odds-api?ref=github) — the live cross-book board per market, with graded outcomes
- [More recipes](https://prop-line.com/recipes?ref=github) · [Pricing](https://prop-line.com/pricing?ref=github) · [Node SDK](https://www.npmjs.com/package/propline)

## License

MIT.
