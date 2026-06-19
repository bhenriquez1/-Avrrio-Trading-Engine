import { AvrrioEngine } from "./engine.js";
import type { Side, TradeIdea } from "./types.js";

/**
 * CLI entry point.
 *
 * Usage:
 *   npm run dev -- account
 *   npm run dev -- snapshot NQ
 *   npm run dev -- evaluate NQ long 5 20000 19950 20100
 *   npm run dev -- journal
 *
 * Nothing here places orders. It only reads, assesses, and journals.
 */
async function main() {
  const engine = new AvrrioEngine();
  await engine.init();

  for (const w of engine.warnings()) console.warn(`⚠️  ${w}`);

  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "account": {
      const account = await engine.getAccount();
      console.log(JSON.stringify(account, null, 2));
      break;
    }
    case "snapshot": {
      const symbol = args[0] ?? "NQ";
      console.log(JSON.stringify(await engine.snapshot(symbol), null, 2));
      break;
    }
    case "evaluate": {
      const idea = parseIdea(args);
      const { assessment, analysis } = await engine.evaluate(idea);
      console.log("\n=== Risk Assessment ===");
      console.log(`Approved: ${assessment.approved ? "✅ YES" : "🛑 NO"}`);
      console.log(`Risk: $${assessment.riskAmount.toFixed(0)}`);
      console.log(`Reward/Risk: ${assessment.rewardRiskRatio.toFixed(2)}`);
      for (const v of assessment.violations) {
        console.log(`  [${v.severity}] ${v.rule}: ${v.message}`);
      }
      console.log("\n=== Claude Analysis ===");
      console.log(`Recommendation: ${analysis.recommendation}`);
      console.log(`Confidence: ${(analysis.confidence * 100).toFixed(0)}%`);
      console.log(`Summary: ${analysis.summary}`);
      break;
    }
    case "journal": {
      console.log(JSON.stringify(engine.journal.list(), null, 2));
      console.log("\nStats:", engine.journal.stats());
      break;
    }
    default:
      console.log(
        [
          "Avrrio Trading Engine (read-only analyst + risk manager)",
          "",
          "Commands:",
          "  account                                       Show account & rules",
          "  snapshot <SYMBOL>                             Show market snapshot",
          "  evaluate <SYMBOL> <long|short> <size> <entry> <stop> <target>",
          "  journal                                       Show journal & stats",
        ].join("\n"),
      );
  }
}

function parseIdea(args: string[]): TradeIdea {
  const [symbol, side, size, entry, stop, target] = args;
  if (!symbol || (side !== "long" && side !== "short")) {
    throw new Error(
      "Usage: evaluate <SYMBOL> <long|short> <size> <entry> <stop> <target>",
    );
  }
  return {
    symbol,
    side: side as Side,
    size: Number(size),
    entry: Number(entry),
    stopLoss: Number(stop),
    target: Number(target),
  };
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
