/* BizSim automotive simulation engine. Pure calculations; persistence and UI live in app.js. */
(function (global) {
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const defaults = {
    prices: { ice: 31000, ev: 39000, hybrid: 35000 },
    production: { ice: 4800, ev: 3500, hybrid: 1800 },
    marketing: { advertising: 5, brand: 3, channel: 4, promotion: 2 },
    research: { battery: 4, engine: 2, autonomous: 2, quality: 3, newEnergy: 3 },
    procurement: { steel: 4, battery: 4, chip: 3, parts: 4 },
    regions: { china: 45, europe: 30, northAmerica: 25 },
    finance: { loan: 0, capex: 0, equity: 0, dividend: 0 },
    capacityExpansion: 0,
    outsourcing: 0,
    inventoryTarget: 8,
    strategy: 'balanced'
  };
  const mergeDecision = (d) => {
    const out = structuredClone(defaults);
    for (const key of Object.keys(out)) {
      if (key === 'strategy') out[key] = d?.[key] ?? out[key];
      else if (typeof out[key] === 'object') out[key] = { ...out[key], ...(d?.[key] || {}) };
      else if (d?.[key] !== undefined) out[key] = d[key];
    }
    return out;
  };

  function resolveRound(teams, submittedDecisions, market, priorResults, scenario = {}) {
    const inputs = teams.map((team) => ({
      teamId: team.id,
      teamName: team.name,
      decision: mergeDecision(submittedDecisions[team.id] || {}),
      prior: priorResults[team.id] || {
        cash: scenario.initialCapital || 100,
        debt: 0,
        inventory: { ice: 1200, ev: 900, hybrid: 400 },
        marketShare: 0.2,
        cumulativeScore: 0
      }
    }));
    const demandScale = market.demandIndex || 1;
    const productKeys = ['ice', 'ev', 'hybrid'];

    const scored = inputs.map(({ teamId, teamName, decision: d, prior }) => {
      const priceIndex = (d.prices.ice / 31000 + d.prices.ev / 39000 + d.prices.hybrid / 35000) / 3;
      const marketingIndex = (d.marketing.advertising + d.marketing.brand * 0.8 + d.marketing.channel + d.marketing.promotion * 0.7) / 14;
      const rdIndex = (d.research.battery + d.research.engine + d.research.autonomous + d.research.quality + d.research.newEnergy) / 14;
      const strategyFactor = d.strategy === 'premium' ? 1.08 : d.strategy === 'value' ? 1.06 : d.strategy === 'innovation' ? 1.04 : 1;
      const productCompetitiveness = {
        ice: clamp((1.14 / Math.pow(d.prices.ice / 31000, 1.25)) * (1 + marketingIndex * 0.08 + d.research.engine * 0.012 + d.research.quality * 0.009), 0.45, 1.65),
        ev: clamp((1.1 / Math.pow(d.prices.ev / 39000, 1.3)) * (1 + marketingIndex * 0.075 + d.research.battery * 0.017 + d.research.newEnergy * 0.018 + d.research.autonomous * 0.006), 0.42, 1.7),
        hybrid: clamp((1.12 / Math.pow(d.prices.hybrid / 35000, 1.22)) * (1 + marketingIndex * 0.08 + d.research.engine * 0.008 + d.research.newEnergy * 0.01), 0.43, 1.68)
      };
      const regionScale = sum(Object.values(d.regions)) || 100;
      const regionalFactor = sum(Object.entries(d.regions).map(([region, share]) => {
        const norm = regionScale;
        const opportunity = market.regions?.[region] ?? 0.33;
        return (share / norm) * (0.88 + opportunity * 0.3);
      }));
      const segmentFactor = {
        ice: 1 + (market.iceGrowth || 0) / 100,
        ev: 1 + (market.evGrowth || 0) / 100,
        hybrid: 1 + ((market.iceGrowth || 0) + (market.evGrowth || 0)) / 200
      };
      const demandPotential = Object.fromEntries(productKeys.map((key) => [key,
        (market.demand?.[key] || 0) * demandScale * segmentFactor[key] * productCompetitiveness[key] * regionalFactor * strategyFactor
      ]));
      const totalPotential = sum(Object.values(demandPotential));
      const marketShare = clamp(totalPotential / Math.max(1, totalPotential + (market.competitorDemand || 150000) * 5), 0.035, 0.48);
      return { teamId, teamName, decision: d, prior, productCompetitiveness, demandPotential, marketShare };
    });

    const competitiveTotal = sum(scored.map((t) => t.marketShare));
    const normalization = competitiveTotal > 0.82 ? 0.82 / competitiveTotal : 1;
    const rows = scored.map((t) => {
      const d = t.decision;
      const share = t.marketShare * normalization;
      const expansion = d.capacityExpansion;
      const capacity = (scenario.initialCapacity || 10000) + expansion + (d.outsourcing || 0);
      const desired = Object.fromEntries(productKeys.map((key) => [key, Math.round(t.demandPotential[key] * (scenario.initialMarketShare || 0.2) * 3.4)]));
      const totalDesired = sum(Object.values(desired));
      const availableCapacity = Math.max(0, capacity);
      const production = Object.fromEntries(productKeys.map((key) => [key,
        Math.min(d.production[key], Math.floor(availableCapacity * (totalDesired ? desired[key] / totalDesired : 1 / 3)))
      ]));
      let allocated = sum(Object.values(production));
      if (allocated < Math.min(availableCapacity, sum(Object.values(d.production)))) {
        for (const key of productKeys) {
          const extra = Math.min(d.production[key] - production[key], availableCapacity - allocated);
          if (extra > 0) { production[key] += extra; allocated += extra; }
        }
      }
      const inventoryAvailable = Object.fromEntries(productKeys.map((key) => [key, Math.max(0, t.prior.inventory?.[key] || 0) + production[key]]));
      const sales = Object.fromEntries(productKeys.map((key) => [key, Math.min(desired[key], inventoryAvailable[key])]));
      const endingInventory = Object.fromEntries(productKeys.map((key) => [key, inventoryAvailable[key] - sales[key]]));
      const revenue = sum(productKeys.map((key) => sales[key] * d.prices[key])) / 1_000_000;
      const materialFactors = {
        ice: 0.48 + (d.procurement.steel - 4) * 0.006 + (d.procurement.parts - 4) * 0.004,
        ev: 0.57 + (d.procurement.battery - 4) * 0.012 + (d.procurement.chip - 3) * 0.008 + (d.procurement.parts - 4) * 0.004,
        hybrid: 0.53 + (d.procurement.steel - 4) * 0.005 + (d.procurement.parts - 4) * 0.007
      };
      const materialIndex = clamp(1 + (market.materialPriceIndex || 0) / 100, 0.75, 1.5);
      const productionCost = sum(productKeys.map((key) => production[key] * d.prices[key] * materialFactors[key] * materialIndex)) / 1_000_000;
      const marketingCost = sum(Object.values(d.marketing));
      const rdCost = sum(Object.values(d.research));
      const operationsCost = 2.2 + allocated * 0.00012;
      const expansionCost = expansion * 0.00075;
      const capex = d.finance.capex;
      const financing = d.finance.loan + d.finance.equity;
      const interest = (t.prior.debt + d.finance.loan) * 0.065;
      const dividend = d.finance.dividend;
      const netProfit = revenue - productionCost - marketingCost - rdCost - operationsCost - expansionCost - capex - interest;
      const cash = t.prior.cash + netProfit + financing - dividend;
      const debt = t.prior.debt + d.finance.loan;
      const customerSatisfaction = clamp(70 + (marketingCost * 0.7) + (rdCost * 0.35) - (totalDesired > allocated ? 9 : 0) + (d.research.quality * 1.2), 48, 98);
      const utilization = capacity ? allocated / capacity * 100 : 0;
      const score = clamp(42 + netProfit * 0.12 + share * 80 + customerSatisfaction * 0.1 - debt * 0.18 + (cash > 0 ? 8 : -12), 0, 100);
      return {
        teamId: t.teamId, teamName: t.teamName, round: market.round, decision: d,
        trace: {
          priceIndex: round2((d.prices.ice / 31000 + d.prices.ev / 39000 + d.prices.hybrid / 35000) / 3),
          marketingIndex: round2((d.marketing.advertising + d.marketing.brand * 0.8 + d.marketing.channel + d.marketing.promotion * 0.7) / 14),
          rdIndex: round2((d.research.battery + d.research.engine + d.research.autonomous + d.research.quality + d.research.newEnergy) / 14),
          demandPotential: Object.fromEntries(productKeys.map(k => [k, Math.round(t.demandPotential[k])])),
          capacity, capacityLimit: availableCapacity, allocatedProduction: allocated,
          materialIndex: round2(materialIndex), materialFactors
        },
        revenue: round2(revenue), netProfit: round2(netProfit), productionCost: round2(productionCost),
        marketingCost: round2(marketingCost), rdCost: round2(rdCost), operationsCost: round2(operationsCost),
        sales, production, inventory: endingInventory, inventoryUnits: sum(Object.values(endingInventory)),
        cash: round2(cash), debt: round2(debt), marketShare: round2(share * 100), capacityUtilization: round2(utilization),
        customerSatisfaction: round2(customerSatisfaction), score: round2(score),
        cashFlow: round2(netProfit + financing - dividend), totalSales: sum(Object.values(sales)),
        cumulativeScore: round2((t.prior.cumulativeScore || 0) + score)
      };
    });
    rows.sort((a, b) => b.score - a.score);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return {
      round: market.round,
      calculatedAt: new Date().toISOString(),
      marketSnapshot: structuredClone(market),
      inputs: teams.map((team) => ({ teamId: team.id, decision: mergeDecision(submittedDecisions[team.id] || {}) })),
      results: rows
    };
  }

  global.BizSimEngine = { defaults, mergeDecision, resolveRound };
})(window);
