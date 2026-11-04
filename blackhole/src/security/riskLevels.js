export const RiskLevel = Object.freeze({
  SAFE: 'SAFE',
  WARNING: 'WARNING',
  BLOCKED: 'BLOCKED'
});

export function maxRisk(left, right) {
  const order = {
    [RiskLevel.SAFE]: 0,
    [RiskLevel.WARNING]: 1,
    [RiskLevel.BLOCKED]: 2
  };
  return order[right] > order[left] ? right : left;
}
