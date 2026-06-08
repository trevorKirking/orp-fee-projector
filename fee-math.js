(function attachFeeMath(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.FeeMath = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createFeeMath() {
  const BASELINE_PLAN = {
    id: "baseline",
    name: "No-fee baseline",
    recordkeeper: "No fees",
    isBaseline: true,
    isInnovestClient: false,
    assetFeeBps: 0,
    annualFlatFee: 0
  };

  function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function normalizeSettings(settings) {
    return {
      startingBalance: Math.max(0, Number(settings?.startingBalance) || 0),
      annualContribution: Math.max(0, Number(settings?.annualContribution) || 0),
      annualReturnPercent: clampNumber(settings?.annualReturnPercent, -99, 99, 0),
      years: Math.round(clampNumber(settings?.years, 1, 60, 40))
    };
  }

  function normalizePlan(plan) {
    return {
      ...plan,
      assetFeeBps: Math.max(0, Number(plan?.assetFeeBps) || 0),
      annualFlatFee: Math.max(0, Number(plan?.annualFlatFee) || 0)
    };
  }

  function getMonthlyReturn(annualReturnPercent) {
    return Math.pow(1 + annualReturnPercent / 100, 1 / 12) - 1;
  }

  function getMonthlyAssetFeeRate(assetFeeBps) {
    return assetFeeBps / 10000 / 12;
  }

  function projectPlan(plan, settings) {
    const normalizedSettings = normalizeSettings(settings);
    const normalizedPlan = normalizePlan(plan);
    const years = normalizedSettings.years;
    let balance = normalizedSettings.startingBalance;
    let cumulativeFees = 0;
    const rows = [{ year: 0, balance, cumulativeFees, gap: 0 }];
    const monthlyReturn = getMonthlyReturn(normalizedSettings.annualReturnPercent);
    const monthlyContribution = normalizedSettings.annualContribution / 12;
    const monthlyAssetFee = getMonthlyAssetFeeRate(normalizedPlan.assetFeeBps);
    const monthlyFlatFee = normalizedPlan.annualFlatFee / 12;

    for (let month = 1; month <= years * 12; month += 1) {
      balance = Math.max(0, balance * (1 + monthlyReturn));
      balance += monthlyContribution;
      const assetFee = balance * monthlyAssetFee;
      const totalFee = Math.min(balance, assetFee + monthlyFlatFee);
      balance = Math.max(0, balance - totalFee);
      cumulativeFees += totalFee;

      if (month % 12 === 0) {
        rows.push({
          year: month / 12,
          balance,
          cumulativeFees,
          gap: 0
        });
      }
    }

    return rows;
  }

  function calculateScenario(settings) {
    const plans = Array.isArray(settings?.plans) ? settings.plans : [];
    const allPlans = [{ ...BASELINE_PLAN }, ...plans];
    const projected = allPlans.map((plan) => ({
      plan,
      data: projectPlan(plan, settings)
    }));
    const baseline = projected[0];

    projected.forEach((series) => {
      series.data = series.data.map((row, index) => ({
        ...row,
        gap: baseline.data[index].balance - row.balance
      }));
    });

    return projected;
  }

  function ending(series) {
    return series.data[series.data.length - 1];
  }

  return {
    calculateScenario,
    clampNumber,
    ending,
    getMonthlyAssetFeeRate,
    getMonthlyReturn,
    projectPlan
  };
});
