/**
 * 2-way arbitrage math.
 *
 * An arb exists when, for two complementary outcomes priced at two
 * different books, the sum of implied probabilities is < 1. The
 * difference is the guaranteed edge — split your stake across the two
 * books in proportion to the implied probs and you lock it in.
 */

export interface ArbLeg {
  book: string;
  bookTitle: string;
  outcomeName: string;
  priceAmerican: number;
  decimal: number;
  impliedProb: number;
}

export interface ArbOpportunity {
  marketKey: string;
  description: string; // player name (props) or "" (game lines)
  point: number | null;
  eventId: string;
  awayTeam: string;
  homeTeam: string;
  legs: [ArbLeg, ArbLeg];
  /** Sum of legs' implied probabilities. < 1 means arb exists. */
  bookSum: number;
  /** Profit % on a $1 bankroll split optimally between the two legs. */
  profitPct: number;
  /** Stake fraction per leg (sums to 1). */
  stakeSplit: [number, number];
}

export function americanToDecimal(price: number): number {
  if (price > 0) return price / 100 + 1;
  return 100 / -price + 1;
}

export function americanToImpliedProb(price: number): number {
  if (price > 0) return 100 / (price + 100);
  return -price / (-price + 100);
}

function makeLeg(
  book: string,
  bookTitle: string,
  outcomeName: string,
  priceAmerican: number,
): ArbLeg {
  return {
    book,
    bookTitle,
    outcomeName,
    priceAmerican,
    decimal: americanToDecimal(priceAmerican),
    impliedProb: americanToImpliedProb(priceAmerican),
  };
}

/**
 * Given the best price each book offers on each side of a complementary
 * pair, return the best 2-leg arbitrage if any.
 *
 * @param sideABest Map of book → (priceAmerican) for outcome A
 * @param sideBBest Map of book → (priceAmerican) for outcome B (the complement)
 */
function findBestArb(
  sideAName: string,
  sideABest: Map<string, { price: number; bookTitle: string }>,
  sideBName: string,
  sideBBest: Map<string, { price: number; bookTitle: string }>,
): {
  leg1: ArbLeg;
  leg2: ArbLeg;
  bookSum: number;
  profitPct: number;
  stakeSplit: [number, number];
} | null {
  let best: ReturnType<typeof findBestArb> = null;
  for (const [bookA, { price: pA, bookTitle: titleA }] of sideABest) {
    for (const [bookB, { price: pB, bookTitle: titleB }] of sideBBest) {
      // Two legs of an arb must come from different books — same book
      // pricing both sides at <100% combined would imply they're vig-
      // free, which is implausible enough to filter out (data error).
      if (bookA === bookB) continue;
      const legA = makeLeg(bookA, titleA, sideAName, pA);
      const legB = makeLeg(bookB, titleB, sideBName, pB);
      const bookSum = legA.impliedProb + legB.impliedProb;
      if (bookSum >= 1) continue;
      const profitPct = (1 - bookSum) * 100;
      // Stake split: proportion to invested implied prob so payout is
      // identical regardless of which side wins.
      const splitA = legA.impliedProb / bookSum;
      const splitB = legB.impliedProb / bookSum;
      if (best === null || profitPct > best.profitPct) {
        best = {
          leg1: legA,
          leg2: legB,
          bookSum,
          profitPct,
          stakeSplit: [splitA, splitB],
        };
      }
    }
  }
  return best;
}

/**
 * Group outcomes by their no-vig pair key, find the best two opposing
 * prices across books, return any arbs.
 *
 * Pair key includes (market_key, description, point) which is correct
 * for h2h / totals / player props. Spreads are intentionally skipped —
 * the complement of "Marlins -1.5" is "Giants +1.5", which has a
 * different signed point and would need favorite-aware bucketing
 * (PropLine's /ev endpoint already does this; we don't reimplement it
 * here to keep this example focused).
 */
export interface FlattenedOutcome {
  eventId: string;
  awayTeam: string;
  homeTeam: string;
  marketKey: string;
  description: string;
  point: number | null;
  outcomeName: string;
  book: string;
  bookTitle: string;
  priceAmerican: number;
}

function pairKey(o: FlattenedOutcome): string {
  return `${o.eventId}::${o.marketKey}::${o.description}::${o.point ?? ""}`;
}

export const SUPPORTED_2WAY_PAIRS: ReadonlyArray<[string, string]> = [
  ["Over", "Under"],
  ["Yes", "No"],
];

const COMPLEMENT_OF: Record<string, string> = {
  Over: "Under",
  Under: "Over",
  Yes: "No",
  No: "Yes",
};

/**
 * h2h moneylines for two-team sports (MLB/NBA/NHL/NFL/etc.) form a
 * 2-way market when the underlying sport doesn't allow draws. Soccer
 * h2h is 3-way (Home / Draw / Away) and is intentionally skipped here.
 */
export function findArbsAcrossOutcomes(
  outcomes: FlattenedOutcome[],
): ArbOpportunity[] {
  const groups = new Map<string, FlattenedOutcome[]>();
  for (const o of outcomes) {
    const k = pairKey(o);
    const arr = groups.get(k);
    if (arr) arr.push(o);
    else groups.set(k, [o]);
  }

  const arbs: ArbOpportunity[] = [];
  for (const [, members] of groups) {
    // Distinct outcome-name buckets within this group.
    const byName = new Map<string, FlattenedOutcome[]>();
    for (const m of members) {
      const arr = byName.get(m.outcomeName);
      if (arr) arr.push(m);
      else byName.set(m.outcomeName, [m]);
    }
    if (byName.size < 2) continue;

    const names = [...byName.keys()];
    let pairs: Array<[string, string]> = [];

    // Standard 2-way pairs (Over/Under, Yes/No).
    for (const [a, b] of SUPPORTED_2WAY_PAIRS) {
      if (byName.has(a) && byName.has(b)) pairs.push([a, b]);
    }

    // h2h: exactly 2 distinct team names → form a 2-way pair.
    if (
      pairs.length === 0 &&
      names.length === 2 &&
      members[0]!.marketKey === "h2h" &&
      !names.includes("Draw")
    ) {
      pairs.push([names[0]!, names[1]!]);
    }

    for (const [aName, bName] of pairs) {
      const sideA = byName.get(aName)!;
      const sideB = byName.get(bName)!;

      // For each book, take the BEST price on its side. Best = highest
      // decimal odds (equivalent to lowest implied prob).
      const bestA = bestPricePerBook(sideA);
      const bestB = bestPricePerBook(sideB);

      const arb = findBestArb(aName, bestA, bName, bestB);
      if (!arb) continue;

      const sample = sideA[0]!;
      arbs.push({
        marketKey: sample.marketKey,
        description: sample.description,
        point: sample.point,
        eventId: sample.eventId,
        awayTeam: sample.awayTeam,
        homeTeam: sample.homeTeam,
        legs: [arb.leg1, arb.leg2],
        bookSum: arb.bookSum,
        profitPct: arb.profitPct,
        stakeSplit: arb.stakeSplit,
      });
      // Avoid double-counting reversed pair on Yes/No.
      if (COMPLEMENT_OF[aName] === bName) break;
    }
  }

  arbs.sort((a, b) => b.profitPct - a.profitPct);
  return arbs;
}

function bestPricePerBook(
  outcomes: FlattenedOutcome[],
): Map<string, { price: number; bookTitle: string }> {
  const byBook = new Map<string, { price: number; bookTitle: string }>();
  for (const o of outcomes) {
    const cur = byBook.get(o.book);
    if (
      !cur ||
      americanToDecimal(o.priceAmerican) > americanToDecimal(cur.price)
    ) {
      byBook.set(o.book, { price: o.priceAmerican, bookTitle: o.bookTitle });
    }
  }
  return byBook;
}
