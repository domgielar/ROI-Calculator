require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// Industry standard assumptions (used when live data isn't available)
const DEFAULTS = {
  vacancyRate:       0.07,   // 7% vacancy
  managementFee:     0.10,   // 10% property management
  maintenancePct:    0.01,   // 1% of value/yr
  capexPct:          0.07,   // 7% of rent for capital expenses
  insuranceRate:     0.005,  // 0.5% of value/yr
  closingCostPct:    0.03,   // 3% closing costs
  downPaymentPct:    0.20,   // 20% down
  loanTermYears:     30,
  holdYears:         10,
  rentGrowthRate:    0.02,   // 2%/yr rent growth
  appreciationRate:  0.035,  // 3.5%/yr fallback
  mortgageRate:      0.072,  // 7.2% fallback if FRED fails
};

// -----------------------------------------------
// MAIN ENDPOINT — address in, ROI out
// -----------------------------------------------
app.get("/api/analyze", async (req, res) => {
  const { address, city, state, zipCode, bedrooms } = req.query;

  if (!address && !zipCode) {
    return res.status(400).json({ error: "Please provide an address or zip code." });
  }

  const result = {
    property: {},
    inputs: {},
    metrics: {},
    breakdown: {},
    errors: [],
  };

  // Run all data fetches in parallel
  const [rentData, marketData, mortgageData] = await Promise.all([

    // 1. Rent estimate
    (async () => {
      try {
        const p = new URLSearchParams();
        if (address)  p.append("address", address);
        if (city)     p.append("city", city);
        if (state)    p.append("state", state);
        if (zipCode)  p.append("zipCode", zipCode);
        if (bedrooms) p.append("bedrooms", bedrooms);
        const r = await fetch(`https://api.rentcast.io/v1/avm/rent/long-term?${p}`, {
          headers: { "X-Api-Key": process.env.RENTCAST_API_KEY, "accept": "application/json" }
        });
        if (!r.ok) throw new Error(await r.text());
        return await r.json();
      } catch(e) { result.errors.push("rent: " + e.message); return null; }
    })(),

    // 2. Market stats + property details
    (async () => {
      try {
        const zip = zipCode || "";
        if (!zip) return null;
        const r = await fetch(`https://api.rentcast.io/v1/markets?zipCode=${zip}`, {
          headers: { "X-Api-Key": process.env.RENTCAST_API_KEY, "accept": "application/json" }
        });
        if (!r.ok) throw new Error(await r.text());
        return await r.json();
      } catch(e) { result.errors.push("market: " + e.message); return null; }
    })(),

    // 3. Current mortgage rate from FRED
    (async () => {
      try {
        const p = new URLSearchParams({
          series_id: "MORTGAGE30US", api_key: process.env.FRED_API_KEY,
          file_type: "json", sort_order: "desc", limit: "1"
        });
        const r = await fetch(`https://api.stlouisfed.org/fred/series/observations?${p}`);
        if (!r.ok) throw new Error("FRED error");
        const d = await r.json();
        return d.observations?.[0] ? parseFloat(d.observations[0].value) / 100 : null;
      } catch(e) { result.errors.push("mortgage: " + e.message); return null; }
    })(),
  ]);

  // Also fetch property details if we have an address
  let propData = null;
  if (address) {
    try {
      const p = new URLSearchParams({ address });
      if (city)    p.append("city", city);
      if (state)   p.append("state", state);
      if (zipCode) p.append("zipCode", zipCode);
      const r = await fetch(`https://api.rentcast.io/v1/properties?${p}`, {
        headers: { "X-Api-Key": process.env.RENTCAST_API_KEY, "accept": "application/json" }
      });
      if (r.ok) {
        const d = await r.json();
        propData = Array.isArray(d) ? d[0] : d;
      }
    } catch(e) { result.errors.push("property: " + e.message); }
  }

  // ---- Build inputs from live data + smart defaults ----

  const monthlyRent    = rentData?.rent         || marketData?.averageRent || 0;
  const rentLow        = rentData?.rentRangeLow  || null;
  const rentHigh       = rentData?.rentRangeHigh || null;
  const purchasePrice  = propData?.lastSalePrice || marketData?.averageSalePrice || 0;
  const mortgageRate   = mortgageData            || DEFAULTS.mortgageRate;
  const appreciation   = marketData?.priceAppreciation != null
                          ? marketData.priceAppreciation * 100
                          : DEFAULTS.appreciationRate * 100;
  const hoaMonthly     = propData?.hoa?.fee      || 0;
  const propertyTaxAnn = propData?.taxAssessments?.[0]?.value
                          ? propData.taxAssessments[0].value * 0.012   // ~1.2% effective rate
                          : purchasePrice * 0.012;
  const propertyTaxMo  = propertyTaxAnn / 12;
  const insuranceMo    = (purchasePrice * DEFAULTS.insuranceRate) / 12;
  const maintenanceMo  = (purchasePrice * DEFAULTS.maintenancePct) / 12;
  const capexMo        = monthlyRent * DEFAULTS.capexPct;
  const mgmtMo         = monthlyRent * DEFAULTS.managementFee;

  // ---- Mortgage calculation ----
  const downAmt        = purchasePrice * DEFAULTS.downPaymentPct;
  const loanAmt        = purchasePrice - downAmt;
  const closingCosts   = purchasePrice * DEFAULTS.closingCostPct;
  const totalInvested  = downAmt + closingCosts;
  const mo             = mortgageRate / 12;
  const n              = DEFAULTS.loanTermYears * 12;
  const mortgage       = loanAmt > 0
    ? loanAmt * (mo * Math.pow(1+mo, n)) / (Math.pow(1+mo, n) - 1)
    : 0;

  // ---- Core metrics ----
  const effRent        = monthlyRent * (1 - DEFAULTS.vacancyRate);
  const totalOpEx      = propertyTaxMo + insuranceMo + hoaMonthly + mgmtMo + maintenanceMo + capexMo;
  const noi            = (effRent - totalOpEx) * 12;
  const monthlyCF      = effRent - totalOpEx - mortgage;
  const annualCF       = monthlyCF * 12;
  const capRate        = purchasePrice > 0 ? (noi / purchasePrice) * 100 : 0;
  const coc            = totalInvested > 0 ? (annualCF / totalInvested) * 100 : 0;
  const grm            = monthlyRent > 0 ? purchasePrice / (monthlyRent * 12) : 0;
  const breakEven      = monthlyRent > 0 ? ((totalOpEx + mortgage) / monthlyRent) * 100 : 0;

  // ---- Multi-year projection ----
  let futureValue = purchasePrice;
  let totalCF = 0;
  let rentNow = monthlyRent;
  const appRate = appreciation / 100;
  for (let y = 0; y < DEFAULTS.holdYears; y++) {
    futureValue *= (1 + appRate);
    rentNow     *= (1 + DEFAULTS.rentGrowthRate);
    const effR   = rentNow * (1 - DEFAULTS.vacancyRate);
    const opEx   = (propertyTaxMo + insuranceMo + hoaMonthly
                    + rentNow * DEFAULTS.managementFee
                    + (futureValue * DEFAULTS.maintenancePct / 12)
                    + rentNow * DEFAULTS.capexPct) * 12;
    totalCF     += (effR * 12 - opEx - mortgage * 12);
  }
  const saleProceeds = futureValue * 0.94;
  let loanBal = loanAmt;
  for (let i = 0; i < DEFAULTS.holdYears * 12; i++) {
    const interest = loanBal * mo;
    loanBal -= (mortgage - interest);
    if (loanBal < 0) loanBal = 0;
  }
  const netProceeds   = saleProceeds - loanBal;
  const totalReturn   = totalCF + netProceeds - totalInvested;
  const totalROI      = totalInvested > 0 ? (totalReturn / totalInvested) * 100 : 0;
  const annualizedROI = totalInvested > 0
    ? (Math.pow(1 + totalReturn / totalInvested, 1 / DEFAULTS.holdYears) - 1) * 100 : 0;

  // ---- Build response ----
  result.property = {
    address:      [address, city, state, zipCode].filter(Boolean).join(", "),
    bedrooms:     propData?.bedrooms    || bedrooms || null,
    bathrooms:    propData?.bathrooms   || null,
    sqft:         propData?.squareFootage || null,
    yearBuilt:    propData?.yearBuilt   || null,
    propertyType: propData?.propertyType || null,
    lastSalePrice: propData?.lastSalePrice || null,
    lastSaleDate:  propData?.lastSaleDate  || null,
  };

  result.inputs = {
    purchasePrice:   Math.round(purchasePrice),
    monthlyRent:     Math.round(monthlyRent),
    rentRangeLow:    rentLow  ? Math.round(rentLow)  : null,
    rentRangeHigh:   rentHigh ? Math.round(rentHigh) : null,
    mortgageRate:    +(mortgageRate * 100).toFixed(2),
    downPayment:     Math.round(downAmt),
    loanAmount:      Math.round(loanAmt),
    monthlyMortgage: Math.round(mortgage),
    appreciation:    +appreciation.toFixed(1),
    totalInvested:   Math.round(totalInvested),
    dataSources: {
      rent:        rentData     ? "RentCast AVM"    : "unavailable",
      market:      marketData   ? "RentCast Markets": "unavailable",
      mortgageRate: mortgageData ? "FRED / Freddie Mac" : "default estimate",
      property:    propData     ? "RentCast Property"  : "unavailable",
    }
  };

  result.breakdown = {
    monthly: {
      grossRent:     Math.round(monthlyRent),
      vacancyLoss:   Math.round(monthlyRent * DEFAULTS.vacancyRate),
      effectiveRent: Math.round(effRent),
      mortgage:      Math.round(mortgage),
      propertyTax:   Math.round(propertyTaxMo),
      insurance:     Math.round(insuranceMo),
      hoa:           Math.round(hoaMonthly),
      management:    Math.round(mgmtMo),
      maintenance:   Math.round(maintenanceMo),
      capex:         Math.round(capexMo),
      totalExpenses: Math.round(totalOpEx + mortgage),
      cashFlow:      Math.round(monthlyCF),
    }
  };

  result.metrics = {
    monthlyCashFlow:  Math.round(monthlyCF),
    annualCashFlow:   Math.round(annualCF),
    capRate:          +capRate.toFixed(2),
    cashOnCash:       +coc.toFixed(2),
    grossRentMultiplier: +grm.toFixed(1),
    breakEvenOccupancy:  +breakEven.toFixed(1),
    noi:              Math.round(noi),
    tenYearROI:       +totalROI.toFixed(1),
    annualizedROI:    +annualizedROI.toFixed(1),
    projectedValue:   Math.round(futureValue),
    netSaleProceeds:  Math.round(netProceeds),
    verdict: capRate >= 7 && coc >= 8 ? "strong"
           : capRate >= 4 && coc >= 4 ? "moderate"
           : "weak",
  };

  res.json(result);
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    keys: {
      rentcast: !!process.env.RENTCAST_API_KEY && process.env.RENTCAST_API_KEY !== "your_rentcast_key_here",
      fred:     !!process.env.FRED_API_KEY     && process.env.FRED_API_KEY     !== "your_fred_key_here",
    }
  });
});

app.listen(PORT, () => {
  console.log(`\n ROI Calculator running at http://localhost:${PORT}\n`);
});