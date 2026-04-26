#!/usr/bin/env node
/**
 * propline-arb-finder — CLI for live cross-book 2-way arbitrage scanning.
 *
 * Usage:
 *   PROPLINE_API_KEY=... npx tsx src/index.ts --sport baseball_mlb [--bankroll 1000] [--min-edge 0.5]
 *
 * Pulls upcoming events for a sport via the PropLine SDK, walks every
 * book's odds, and prints any 2-way arbitrage opportunities (Over/Under,
 * h2h moneylines, Yes/No props). Sorted by edge% descending.
 */

import { PropLine } from "propline";
import {
  americanToDecimal,
  findArbsAcrossOutcomes,
  type ArbOpportunity,
  type FlattenedOutcome,
} from "./arb.js";

interface CliArgs {
  sport: string;
  bankroll: number;
  minEdge: number; // skip arbs with edge below this %
  marketsFilter?: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sport") args.sport = argv[++i];
    else if (a === "--bankroll") args.bankroll = Number(argv[++i]);
    else if (a === "--min-edge") args.minEdge = Number(argv[++i]);
    else if (a === "--markets") args.marketsFilter = argv[++i]!.split(",");
    else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    }
  }
  if (!args.sport) {
    console.error(
      "missing --sport. Try --sport baseball_mlb (see https://api.prop-line.com/v1/sports)",
    );
    process.exit(2);
  }
  return {
    sport: args.sport!,
    bankroll: args.bankroll ?? 1000,
    minEdge: args.minEdge ?? 0,
    marketsFilter: args.marketsFilter,
  };
}

function printHelp(): void {
  console.log(`
propline-arb-finder

Usage:
  PROPLINE_API_KEY=... propline-arb-finder --sport <sport_key> [options]

Options:
  --sport <key>       PropLine sport key (e.g. baseball_mlb, basketball_nba).
  --bankroll <usd>    Bankroll for the stake-split print (default 1000).
  --min-edge <pct>    Skip arbs below this edge percent (default 0).
  --markets <a,b,c>   Restrict to these market keys (default: all 2-way).
  -h, --help          Print this help.

Sample output:
  ARB +2.34%  ·  Yankees @ Red Sox  ·  totals  o/u 8.5
    Over  8.5  @  Bovada    +110   stake $476.20
    Under 8.5  @  FanDuel   -100   stake $523.80
    Pay either side: $1023.40 → guaranteed profit $23.40
`);
}

async function main(): Promise<void> {
  const apiKey = process.env.PROPLINE_API_KEY;
  if (!apiKey) {
    console.error(
      "PROPLINE_API_KEY env var is required. Get a free key at https://prop-line.com",
    );
    process.exit(2);
  }

  const cli = parseArgs(process.argv.slice(2));
  const client = new PropLine(apiKey);

  console.log(`Fetching ${cli.sport} events…`);
  const events = await client.getEvents(cli.sport);

  // Look ahead 36h, skip already-started events.
  const now = Date.now();
  const cutoff = now + 36 * 3600 * 1000;
  const upcoming = events.filter((e) => {
    const t = Date.parse(e.commence_time);
    return t > now && t < cutoff;
  });

  if (upcoming.length === 0) {
    console.log(`No upcoming ${cli.sport} events in the next 36h.`);
    return;
  }
  console.log(`Scanning ${upcoming.length} upcoming events…\n`);

  const allArbs: ArbOpportunity[] = [];
  for (const event of upcoming) {
    const flattened = await flattenOddsForEvent(
      client,
      cli.sport,
      event.id,
      event.home_team,
      event.away_team,
      cli.marketsFilter,
    );
    if (flattened.length === 0) continue;
    const arbs = findArbsAcrossOutcomes(flattened).filter(
      (a) => a.profitPct >= cli.minEdge,
    );
    allArbs.push(...arbs);
  }

  if (allArbs.length === 0) {
    console.log(
      `No arbs found above ${cli.minEdge.toFixed(2)}% edge. Lines may be aligned right now — try again in a few minutes.`,
    );
    return;
  }

  allArbs.sort((a, b) => b.profitPct - a.profitPct);
  for (const arb of allArbs) printArb(arb, cli.bankroll);

  console.log(
    `\nFound ${allArbs.length} arb${allArbs.length === 1 ? "" : "s"}. ` +
      `Real markets vanish in seconds — verify each book still posts the price before placing.`,
  );
}

async function flattenOddsForEvent(
  client: PropLine,
  sport: string,
  eventId: string | number,
  homeTeam: string,
  awayTeam: string,
  marketsFilter?: string[],
): Promise<FlattenedOutcome[]> {
  // Per-event call returns full player props + game lines across every
  // book PropLine ingests (Bovada, DraftKings, FanDuel, Pinnacle, Unibet).
  const ev = await client.getOdds(sport, {
    eventId,
    markets: marketsFilter,
  });

  const out: FlattenedOutcome[] = [];
  for (const book of ev.bookmakers ?? []) {
    for (const market of book.markets ?? []) {
      // Skip spreads — the favorite/dog complement requires bucketing
      // we don't reimplement here (PropLine's /ev endpoint handles it).
      if (market.key === "spreads") continue;
      for (const oc of market.outcomes ?? []) {
        if (oc.price === null || oc.price === undefined) continue;
        out.push({
          eventId: String(ev.id),
          awayTeam,
          homeTeam,
          marketKey: market.key,
          description: oc.description ?? "",
          point: oc.point ?? null,
          outcomeName: oc.name,
          book: book.key,
          bookTitle: book.title,
          priceAmerican: oc.price,
        });
      }
    }
  }
  return out;
}

function fmtPrice(p: number): string {
  return p > 0 ? `+${p}` : String(p);
}

function fmtMoney(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function printArb(arb: ArbOpportunity, bankroll: number): void {
  const subject = arb.description
    ? `${arb.description} · ${arb.marketKey}`
    : arb.marketKey;
  const lineSuffix = arb.point !== null ? `  o/u ${arb.point}` : "";
  const stake1 = bankroll * arb.stakeSplit[0];
  const stake2 = bankroll * arb.stakeSplit[1];
  // Either leg pays the same total — use leg 1 for the headline.
  const payout = stake1 * americanToDecimal(arb.legs[0].priceAmerican);
  const profit = payout - bankroll;

  console.log(
    `ARB +${arb.profitPct.toFixed(2)}%  ·  ${arb.awayTeam} @ ${arb.homeTeam}  ·  ${subject}${lineSuffix}`,
  );
  console.log(
    `  ${pad(arb.legs[0].outcomeName, 6)} ${pad(arb.point !== null ? String(arb.point) : "", 5)}  @  ${pad(arb.legs[0].bookTitle, 11)} ${pad(fmtPrice(arb.legs[0].priceAmerican), 5)}   stake ${fmtMoney(stake1)}`,
  );
  console.log(
    `  ${pad(arb.legs[1].outcomeName, 6)} ${pad(arb.point !== null ? String(arb.point) : "", 5)}  @  ${pad(arb.legs[1].bookTitle, 11)} ${pad(fmtPrice(arb.legs[1].priceAmerican), 5)}   stake ${fmtMoney(stake2)}`,
  );
  console.log(
    `  Pay either side: ${fmtMoney(payout)} → guaranteed profit ${fmtMoney(profit)}\n`,
  );
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
