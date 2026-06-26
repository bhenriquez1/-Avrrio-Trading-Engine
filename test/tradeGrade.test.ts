import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeTradeGrade,
  gradeFromScore,
  tradeGradeText,
} from "../src/ai/tradeGrade.js";
import type { ScoreComponents } from "../src/scanner/scanner.js";

function components(overrides: Partial<ScoreComponents> = {}): ScoreComponents {
  return {
    trend: 90,
    volume: 85,
    news: 90,
    momentum: 90,
    risk: 80,
    structure: 92,
    ...overrides,
  };
}

test("gradeFromScore maps thresholds to letter grades", () => {
  assert.equal(gradeFromScore(95), "A+");
  assert.equal(gradeFromScore(85), "A");
  assert.equal(gradeFromScore(75), "B");
  assert.equal(gradeFromScore(65), "C");
  assert.equal(gradeFromScore(40), "D");
});

test("computeTradeGrade produces a high score for a clean A+ setup", () => {
  const result = computeTradeGrade({
    components: components(),
    rewardRiskRatio: 3,
    riskApproved: true,
    consensus: { agreement: 3, available: 3 },
  });
  assert.equal(result.grade, "A+");
  assert.ok(result.qualityScore >= 90, `expected >=90, got ${result.qualityScore}`);
  assert.equal(result.qualifies, true);
  assert.equal(result.riskApproved, true);
});

test("computeTradeGrade penalizes poor reward/risk and weak consensus", () => {
  const result = computeTradeGrade({
    components: components({ trend: 40, momentum: 35, volume: 40, structure: 45 }),
    rewardRiskRatio: 1,
    riskApproved: true,
    consensus: { agreement: 0, available: 3 },
  });
  assert.ok(result.qualityScore < 60, `expected low score, got ${result.qualityScore}`);
  assert.equal(result.qualifies, false);
});

test("computeTradeGrade never qualifies when risk checks failed, even with a high score", () => {
  const result = computeTradeGrade({
    components: components(),
    rewardRiskRatio: 3,
    riskApproved: false,
    consensus: { agreement: 3, available: 3 },
  });
  assert.equal(result.qualifies, false);
  assert.equal(result.riskApproved, false);
});

test("computeTradeGrade respects a custom quality threshold", () => {
  const input = {
    components: components({ trend: 70, momentum: 70, volume: 70, structure: 70 }),
    rewardRiskRatio: 2,
    riskApproved: true,
    consensus: { agreement: 2, available: 3 },
  };
  const strict = computeTradeGrade(input, 90);
  const lenient = computeTradeGrade(input, 50);
  assert.equal(strict.qualifies, false);
  assert.equal(lenient.qualifies, true);
});

test("computeTradeGrade treats unavailable AI consensus as neutral, not a penalty", () => {
  const withConsensus = computeTradeGrade({
    components: components(),
    rewardRiskRatio: 3,
    riskApproved: true,
    consensus: { agreement: 0, available: 0 },
  });
  const withoutConsensus = computeTradeGrade({
    components: components(),
    rewardRiskRatio: 3,
    riskApproved: true,
    consensus: null,
  });
  assert.equal(withConsensus.breakdown.consensus, 50);
  assert.equal(withoutConsensus.breakdown.consensus, 50);
});

test("tradeGradeText renders a readable professional-desk card", () => {
  const grade = computeTradeGrade({
    components: components(),
    rewardRiskRatio: 3,
    riskApproved: true,
    consensus: { agreement: 3, available: 3 },
  });
  const text = tradeGradeText("GC", grade);
  assert.match(text, /^GC/);
  assert.match(text, /Confidence: \d+%/);
  assert.match(text, /Grade: A\+/);
  assert.match(text, /Risk: Approved/);
});
