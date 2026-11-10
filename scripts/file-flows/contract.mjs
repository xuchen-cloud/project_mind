// Shared evidence names. A native result must contain each successful assertion.
export const requiredAssertions = [
  'native-main-and-registered-editors',
  'g13-save-failure-retains-draft',
  'g13-commit-failure-releases-source',
  'g13-saves-only-target',
  'g13-closes-source-and-preserves-saved-bytes',
  'g14-replaces-session-keeps-tab',
  'g14-preserves-saved-pending-version',
  'g15-metadata-keeps-session-and-content',
  'unrelated-dirty-instance-untouched',
];

export function assertReport(report) {
  if (report?.kind !== 'file-flows-native' || report.status !== 'passed')
    throw Error(`Native acceptance failed: ${report?.error ?? report?.status ?? 'no report'}`);
  if (report.windowLabel !== 'main' || report.visibility !== 'visible'
    || !Array.isArray(report.runtimeErrors) || report.runtimeErrors.length)
    throw Error('Native report lacks a visible main Webview or contains runtime errors');
  if (!Array.isArray(report.assertions) || report.assertions.some(item => item.passed !== true))
    throw Error('Native report contains incomplete or failed assertions');
  for (const name of requiredAssertions) {
    if (!report.assertions?.some(item => item.name === name && item.passed === true))
      throw Error(`Missing native assertion: ${name}`);
  }
}
