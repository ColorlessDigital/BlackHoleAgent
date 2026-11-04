export function compareSourceIdentity(windowsInfo, linuxInfo) {
  const findings = [];
  if (!windowsInfo?.sourceHash || !linuxInfo?.sourceHash) {
    findings.push('source fingerprint missing; a matching git SHA alone does not prove release parity');
  } else if (windowsInfo.sourceHashAlgorithm !== linuxInfo.sourceHashAlgorithm) {
    findings.push('source fingerprint algorithms differ');
  } else if (windowsInfo.sourceHash !== linuxInfo.sourceHash) {
    findings.push(`source drift: windows ${windowsInfo.sourceHash} vs linux ${linuxInfo.sourceHash}`);
  }
  return findings;
}
