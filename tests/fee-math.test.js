const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const FeeMath = require("../fee-math.js");

const MONEY_TOLERANCE = 0.005;

function assertMoney(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) <= MONEY_TOLERANCE,
    `${label}: expected ${expected.toFixed(6)}, received ${actual.toFixed(6)}`
  );
}

function annualToMonthlyReturn(annualReturnPercent) {
  return Math.pow(1 + annualReturnPercent / 100, 1 / 12) - 1;
}

function ordinaryAnnuityEnding(settings) {
  const months = settings.years * 12;
  const monthlyReturn = annualToMonthlyReturn(settings.annualReturnPercent);
  const monthlyContribution = settings.annualContribution / 12;
  if (Math.abs(monthlyReturn) < Number.EPSILON) {
    return settings.startingBalance + monthlyContribution * months;
  }
  return (
    settings.startingBalance * Math.pow(1 + monthlyReturn, months) +
    monthlyContribution * ((Math.pow(1 + monthlyReturn, months) - 1) / monthlyReturn)
  );
}

function feeAdjustedClosedForm(settings, plan) {
  const months = settings.years * 12;
  const monthlyReturn = annualToMonthlyReturn(settings.annualReturnPercent);
  const monthlyContribution = settings.annualContribution / 12;
  const monthlyAssetFee = plan.assetFeeBps / 10000 / 12;
  const monthlyFlatFee = plan.annualFlatFee / 12;
  const a = (1 + monthlyReturn) * (1 - monthlyAssetFee);
  const b = monthlyContribution * (1 - monthlyAssetFee) - monthlyFlatFee;

  if (Math.abs(a - 1) < Number.EPSILON) {
    const endingBalance = settings.startingBalance + b * months;
    const sumPostFeeBalancesBeforeCurrentMonth = months * settings.startingBalance + b * (months * (months - 1)) / 2;
    const cumulativeFees = monthlyAssetFee * ((1 + monthlyReturn) * sumPostFeeBalancesBeforeCurrentMonth + months * monthlyContribution) + months * monthlyFlatFee;
    return { endingBalance, cumulativeFees };
  }

  const factor = Math.pow(a, months);
  const geometricSum = (factor - 1) / (a - 1);
  const endingBalance = settings.startingBalance * factor + b * geometricSum;
  const sumPostFeeBalancesBeforeCurrentMonth =
    settings.startingBalance * geometricSum +
    (b / (a - 1)) * (geometricSum - months);
  const cumulativeFees = monthlyAssetFee * ((1 + monthlyReturn) * sumPostFeeBalancesBeforeCurrentMonth + months * monthlyContribution) + months * monthlyFlatFee;
  return { endingBalance, cumulativeFees };
}

function getEnd(rows) {
  return rows[rows.length - 1];
}

function testNoFeeAnnualCompounding() {
  const rows = FeeMath.projectPlan(
    { assetFeeBps: 0, annualFlatFee: 0 },
    { startingBalance: 100000, annualContribution: 0, annualReturnPercent: 6, years: 1 }
  );
  const end = getEnd(rows);
  assertMoney(end.balance, 106000, "one-year no-fee annual return");
  assertMoney(end.cumulativeFees, 0, "one-year no-fee cumulative fees");
}

function testMonthlyContributionTiming() {
  const settings = { startingBalance: 100000, annualContribution: 12000, annualReturnPercent: 6, years: 5 };
  const rows = FeeMath.projectPlan({ assetFeeBps: 0, annualFlatFee: 0 }, settings);
  assertMoney(getEnd(rows).balance, ordinaryAnnuityEnding(settings), "monthly contribution ordinary annuity");
}

function testFlatFees() {
  const rows = FeeMath.projectPlan(
    { assetFeeBps: 0, annualFlatFee: 120 },
    { startingBalance: 1200, annualContribution: 0, annualReturnPercent: 0, years: 1 }
  );
  const end = getEnd(rows);
  assertMoney(end.balance, 1080, "flat-fee ending balance");
  assertMoney(end.cumulativeFees, 120, "flat-fee cumulative fees");
}

function testAssetBpsFees() {
  const startingBalance = 100000;
  const monthlyFee = 100 / 10000 / 12;
  const expectedBalance = startingBalance * Math.pow(1 - monthlyFee, 12);
  const rows = FeeMath.projectPlan(
    { assetFeeBps: 100, annualFlatFee: 0 },
    { startingBalance, annualContribution: 0, annualReturnPercent: 0, years: 1 }
  );
  const end = getEnd(rows);
  assertMoney(end.balance, expectedBalance, "100 bps monthly asset-fee ending balance");
  assertMoney(end.cumulativeFees, startingBalance - expectedBalance, "100 bps monthly asset-fee cumulative fees");
}

function testDefaultScenarioAgainstClosedForm() {
  const settings = {
    startingBalance: 100000,
    annualContribution: 12000,
    annualReturnPercent: 6,
    years: 40
  };
  const plan = { assetFeeBps: 28, annualFlatFee: 36 };
  const expected = feeAdjustedClosedForm(settings, plan);
  const end = getEnd(FeeMath.projectPlan(plan, settings));
  assertMoney(end.balance, expected.endingBalance, "default Innovest plan ending balance");
  assertMoney(end.cumulativeFees, expected.cumulativeFees, "default Innovest plan cumulative fees");
}

function testScenarioGapsUseNoFeeBaseline() {
  const scenario = {
    startingBalance: 100000,
    annualContribution: 12000,
    annualReturnPercent: 6,
    years: 40,
    plans: [
      { id: "client", assetFeeBps: 28, annualFlatFee: 36 },
      { id: "prospect", assetFeeBps: 55, annualFlatFee: 72 },
      { id: "high", assetFeeBps: 95, annualFlatFee: 120 }
    ]
  };
  const projected = FeeMath.calculateScenario(scenario);
  const baselineEnd = FeeMath.ending(projected[0]);
  assertMoney(baselineEnd.balance, ordinaryAnnuityEnding(scenario), "default no-fee baseline ending balance");

  const expected = [
    { id: "client", balance: 2682823.74, fees: 108049.39, gap: 253425.81 },
    { id: "prospect", balance: 2460813.65, fees: 199983.61, gap: 475435.90 },
    { id: "high", balance: 2168863.69, fees: 316595.62, gap: 767385.86 }
  ];

  expected.forEach((expectedSeries, index) => {
    const end = FeeMath.ending(projected[index + 1]);
    assert.equal(projected[index + 1].plan.id, expectedSeries.id);
    assertMoney(end.balance, expectedSeries.balance, `${expectedSeries.id} default ending balance`);
    assertMoney(end.cumulativeFees, expectedSeries.fees, `${expectedSeries.id} default cumulative fees`);
    assertMoney(end.gap, expectedSeries.gap, `${expectedSeries.id} default baseline gap`);
    assertMoney(end.gap, baselineEnd.balance - end.balance, `${expectedSeries.id} calculated gap`);
  });
}

function testGeminiComparisonParameters() {
  const scenario = {
    startingBalance: 0,
    annualContribution: 10000,
    annualReturnPercent: 6,
    years: 40,
    plans: [
      { id: "person-1", assetFeeBps: 40.9, annualFlatFee: 0 },
      { id: "person-2", assetFeeBps: 66.2, annualFlatFee: 0 }
    ]
  };
  const projected = FeeMath.calculateScenario(scenario);
  const person1 = FeeMath.ending(projected[1]);
  const person2 = FeeMath.ending(projected[2]);
  assertMoney(FeeMath.ending(projected[0]).balance, 1589731.46, "Gemini comparison no-fee baseline");
  assertMoney(person1.balance, 1423652.85, "Gemini comparison person 1 site balance");
  assertMoney(person2.balance, 1330888.45, "Gemini comparison person 2 site balance");
  assertMoney(person1.balance - person2.balance, 92764.41, "Gemini comparison site delta");
}

function testFeesCannotOverdrawBalance() {
  const rows = FeeMath.projectPlan(
    { assetFeeBps: 0, annualFlatFee: 120 },
    { startingBalance: 5, annualContribution: 0, annualReturnPercent: 0, years: 1 }
  );
  const end = getEnd(rows);
  assertMoney(end.balance, 0, "fee cap ending balance");
  assertMoney(end.cumulativeFees, 5, "fee cap cumulative fees");
}

function testHtmlUsesProductionMathModule() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(html, /<script src="fee-math\.js"><\/script>/, "index.html should load the shared production math module");
}

[
  testNoFeeAnnualCompounding,
  testMonthlyContributionTiming,
  testFlatFees,
  testAssetBpsFees,
  testDefaultScenarioAgainstClosedForm,
  testScenarioGapsUseNoFeeBaseline,
  testGeminiComparisonParameters,
  testFeesCannotOverdrawBalance,
  testHtmlUsesProductionMathModule
].forEach((test) => test());

console.log("fee math deterministic tests passed");
