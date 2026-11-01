/** Bounded native consent notices for an authenticated operator, never a model. */
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : undefined;
export function nativePluginNotice(details) {
  if (!details || typeof details !== 'object') return null;
  if (details.capabilityConsentCode === 'PLUGIN_CAPABILITY_CONSENT_REQUIRED' &&
      typeof details.pluginId === 'string' && typeof details.reviewToken === 'string') {
    const widened = Object.fromEntries(['tools', 'channels', 'providers', 'hooks', 'contracts', 'mcpServers', 'skills']
      .filter(key => Array.isArray(details.widened?.[key])).map(key => [key, details.widened[key].slice(0, 64).filter(value => typeof value === 'string').map(value => value.slice(0, 256))]));
    return { kind: 'capabilities', pluginId: text(details.pluginId, 256), reviewToken: text(details.reviewToken, 4096), widened };
  }
  if (details.installPolicyCode === 'install_policy_warning_acknowledgement_required' && details.targetType === 'plugin')
    return { kind: 'install-policy', targetName: text(details.targetName, 256), reason: text(details.reason, 2048),
      findings: (Array.isArray(details.findings) ? details.findings : []).slice(0, 24).map(item => ({
        ruleId: text(item?.ruleId, 128), severity: ['info', 'warn', 'critical'].includes(item?.severity) ? item.severity : 'warn',
        message: text(item?.message, 1024), file: text(item?.file, 256) })) };
  return null;
}
