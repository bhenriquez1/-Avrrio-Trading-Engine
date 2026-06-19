import { AvrrioEngine, type ProposeInput } from "./engine.js";
import type { Side, TradeIdea } from "./types.js";

/**
 * CLI entry point. Nothing here sends an order without going through the same
 * gates the dashboard uses. `approve` is the only path to execution, and it only
 * sends a real order when LIVE_TRADING_ENABLED=true (otherwise it's a paper fill).
 *
 * Usage:
 *   npm run dev -- account
 *   npm run dev -- snapshot NQ
 *   npm run dev -- evaluate NQ long 1 20000 19960 20080
 *   npm run dev -- propose  NQ long 1 20000 19960 20080
 *   npm run dev -- recommendations
 *   npm run dev -- approve <id>
 *   npm run dev -- reject  <id>
 *   npm run dev -- kill on "reason"   |   kill off
 */
async function main() {
  const engine = new AvrrioEngine();
  await engine.init();
  for (const w of engine.warnings()) console.warn(`⚠️  ${w}`);

  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "account":
      console.log(JSON.stringify(await engine.getAccount(), null, 2));
      break;
    case "snapshot":
      console.log(JSON.stringify(await engine.snapshot(args[0] ?? "NQ"), null, 2));
      break;
    case "evaluate": {
      const { assessment, analysis } = await engine.evaluate(parseIdea(args));
      printAssessment(assessment);
      console.log("\n=== Claude Analysis ===");
      console.log(`Recommendation: ${analysis.recommendation}`);
      console.log(`Confidence: ${(analysis.confidence * 100).toFixed(0)}%`);
      console.log(`Summary: ${analysis.summary}`);
      break;
    }
    case "propose": {
      const input: ProposeInput = parseIdea(args);
      const rec = await engine.propose(input);
      console.log(`\nRecommendation ${rec.id} → ${rec.status}`);
      console.log(
        `Consensus: ${rec.consensus.recommendation} (${rec.consensus.agreement}/${rec.consensus.available} agree, ${(rec.consensus.confidence * 100).toFixed(0)}%)`,
      );
      console.log(`Auto-eligible: ${rec.autoEligible}`);
      printViolations(rec.violations);
      break;
    }
    case "recommendations":
      console.log(JSON.stringify(engine.recommendations.list(), null, 2));
      break;
    case "approve": {
      if (!args[0]) throw new Error("Usage: approve <id>");
      const result = await engine.approve(args[0], "cli-operator");
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "reject":
      if (!args[0]) throw new Error("Usage: reject <id>");
      await engine.reject(args[0], "cli-operator", args[1] ?? "");
      console.log("rejected");
      break;
    case "kill":
      if (args[0] === "on") {
        await engine.engageKill(args[1] ?? "cli", "cli-operator");
        console.log("🛑 kill switch ENGAGED");
      } else if (args[0] === "off") {
        const ok = await engine.disengageKill("cli-operator");
        console.log(ok ? "kill switch cleared" : "cannot clear (env-forced)");
      } else {
        console.log(JSON.stringify(engine.killSwitch.status(), null, 2));
      }
      break;
    default:
      console.log(
        [
          "Avrrio Trading Engine — risk-first trading assistant",
          "",
          "Commands:",
          "  account | snapshot <SYM> | recommendations | kill [on <reason>|off]",
          "  evaluate <SYM> <long|short> <size> <entry> <stop> <target>",
          "  propose  <SYM> <long|short> <size> <entry> <stop> <target>",
          "  approve <id> | reject <id> [reason]",
        ].join("\n"),
      );
  }
}

function parseIdea(args: string[]): TradeIdea {
  const [symbol, side, size, entry, stop, target] = args;
  if (!symbol || (side !== "long" && side !== "short")) {
    throw new Error(
      "Usage: <command> <SYMBOL> <long|short> <size> <entry> <stop> <target>",
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

function printAssessment(a: {
  approved: boolean;
  riskAmount: number;
  rewardRiskRatio: number;
  violations: { severity: string; rule: string; message: string }[];
}) {
  console.log("\n=== Risk Assessment ===");
  console.log(`Approved: ${a.approved ? "✅ YES" : "🛑 NO"}`);
  console.log(`Risk: $${a.riskAmount.toFixed(0)}  Reward/Risk: ${a.rewardRiskRatio.toFixed(2)}`);
  printViolations(a.violations);
}

function printViolations(
  violations: { severity: string; rule: string; message: string }[],
) {
  for (const v of violations) console.log(`  [${v.severity}] ${v.rule}: ${v.message}`);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
