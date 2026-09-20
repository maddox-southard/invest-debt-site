/**
 * The model. Everything the chart and the recommendation show comes from the
 * three files in this folder plus `src/lib/recommendation.ts`; components only
 * render what these return. Assumptions the code makes today (keep this list
 * honest when you change the math):
 *
 * - Rates are nominal annual percentages compounded monthly, for both the debt
 *   and the investment: monthly rate = APR / 100 / 12.
 * - The minimum payment is converted to a monthly equivalent (weekly x 52/12,
 *   bi-weekly x 26/12, quarterly / 3, annually / 12). The default minimum in
 *   `src/app/page.tsx` is the 30-year amortizing payment for the balance.
 * - The extra payment is treated as a monthly amount. The frequency chosen in
 *   `CashFlowInputForm` (including "lump-sum") is collected but not yet used
 *   in the math. Gotcha, not a feature.
 * - Investment contributions land at the start of each month and then earn
 *   that month's growth; the starting value is the user's current investment.
 * - The chart is one scenario, "invest the extra": debt paid with minimums
 *   only (red) beside investments growing with the extra (green). Paying the
 *   extra toward the debt is computed only for the payoff milestone.
 * - Horizon: max(minimum-only payoff months, 120). Growth is projected for
 *   max(ceil(payoff months / 12), 10) years.
 * - Crossover = first month the investment balance exceeds the remaining debt.
 *   Coverage = first month balance x rate / 12 covers the monthly minimum.
 * - If a payment cannot cover the first month's interest, `debt.ts` shows the
 *   balance growing for 30 years; otherwise amortization stops at 50 years.
 * - The recommendation (`recommendation.ts`) compares the two rates only:
 *   invest if return > APR. Confidence is low up to a 2-point spread, medium
 *   up to 5, high above. Taxes, risk and inflation are not modeled; the UI
 *   names them as considerations.
 * - Defaults (`page.tsx`): $100,000 at 5.0% APR, 7.5% return, $0 invested,
 *   $250 extra monthly. Inputs persist in localStorage under the `*-v2` keys.
 */
import { Debt, calculateAmortization } from "./debt";
import { calculateInvestmentGrowth } from "./investment";
import { Investment } from "@/components/InvestmentInputForm";

export interface ComparisonPoint {
  month: number;
  debtBalance: number;
  investmentBalance: number;
}

export interface ComparisonResult {
  data: ComparisonPoint[];
  crossoverPoint?: number; // Month when investment surpasses remaining debt in investment scenario
  coveragePoint?: number; // Month when investment returns can cover debt payment
  totalMonths: number;
  debtPayoffMonths: number;
  debtOnlyPayoffMonths: number;
}

export const calculateComparison = (
  debt: Debt,
  investment: Investment,
  additionalPayment: number
): ComparisonResult => {
  // INVESTMENT STRATEGY SCENARIO:
  // User pays minimum toward debt + puts additionalPayment toward investments
  // We want to show BOTH sides of this single strategy:
  
  // 1. Debt side: How debt decreases with MINIMUM payments only
  const debtMinimumOnly = calculateAmortization(debt, 0);
  const debtOnlyPayoffMonths = debtMinimumOnly.months;
  
  // 2. Investment side: How investments grow with the additionalPayment
  const investmentGrowthYears = Math.max(Math.ceil(debtOnlyPayoffMonths / 12), 10);
  const investmentSchedule = calculateInvestmentGrowth(
    investment,
    additionalPayment,
    investmentGrowthYears
  ).schedule;

  // For comparison purposes, also calculate how fast debt would be paid with extra payments
  const debtWithExtra = calculateAmortization(debt, additionalPayment);
  const debtPayoffMonths = debtWithExtra.months;

  // Use the debt payoff timeline for comparison
  const comparisonMonths = Math.max(debtOnlyPayoffMonths, 120);
  
  const comparison: ComparisonPoint[] = [];
  let crossoverPoint: number | undefined;
  let coveragePoint: number | undefined;
  
  const monthlyDebtPayment = getMonthlyPayment(debt.minimumPayment, debt.paymentFrequency);
  
  for (let i = 0; i < comparisonMonths; i++) {
    // RED LINE: Debt balance when paying MINIMUM only (because extra goes to investments)
    const debtBalance = i < debtMinimumOnly.schedule.length 
      ? debtMinimumOnly.schedule[i].remainingBalance 
      : 0;
    
    // GREEN LINE: Investment growth when putting additionalPayment toward investments
    const investmentBalance = i < investmentSchedule.length 
      ? investmentSchedule[i].value 
      : investmentSchedule[investmentSchedule.length - 1]?.value || 0;
    
    comparison.push({
      month: i + 1,
      debtBalance, // Debt balance with minimum payments only
      investmentBalance, // Investment balance with extra payments
    });

    // Crossover point: When investment balance exceeds remaining debt balance
    // This shows when your investments are worth more than your remaining debt
    if (!crossoverPoint && investmentBalance > debtBalance && debtBalance > 0) {
      crossoverPoint = i + 1;
    }

    // Coverage point: When investment returns can cover minimum debt payments
    if (!coveragePoint && investmentBalance > 0) {
      const annualReturn = investmentBalance * (investment.returnRate / 100);
      const monthlyReturn = annualReturn / 12;
      if (monthlyReturn >= monthlyDebtPayment) {
        coveragePoint = i + 1;
      }
    }
  }

  return {
    data: comparison,
    crossoverPoint,
    coveragePoint,
    totalMonths: comparisonMonths,
    debtPayoffMonths, // How fast debt would be paid with extra payments (for reference)
    debtOnlyPayoffMonths // How long debt takes with minimum payments only
  };
};

// Helper function to convert payment frequency to monthly amount
function getMonthlyPayment(payment: number, frequency: string): number {
  switch (frequency) {
    case "weekly":
      return payment * 52 / 12;
    case "bi-weekly":
      return payment * 26 / 12;
    case "monthly":
      return payment;
    case "quarterly":
      return payment / 3;
    case "annually":
      return payment / 12;
    default:
      return payment; // Default to monthly
  }
} 