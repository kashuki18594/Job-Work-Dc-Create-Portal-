export const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const inr = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function lineCalc(l, factor = 10.764) {
  const sqftPerPc = ((Number(l.parameter) || 0) * (Number(l.length) || 0) / 1e6) * factor;
  const pcs = Number(l.pcs) || 0;
  const coatingPerPc = r2(sqftPerPc * (Number(l.ratePerSqft) || 0));
  return {
    sqftPerPc,
    totalSqft: r2(sqftPerPc * pcs),
    coatingPerPc,
    coatingAmount: r2(sqftPerPc * pcs * (Number(l.ratePerSqft) || 0)),
    newCostPerPc: r2((Number(l.rawCostPerPc) || 0) + coatingPerPc),
  };
}
export const balance = (l) => l.pcs - (l.receivedPcs || 0) - (l.scrapPcs || 0);
