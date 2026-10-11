export function classifyModerationAction(entry, auditLogEvent) {
  if (entry.action === auditLogEvent.MemberKick) return { type: 'kick', label: 'Kick' };
  if (entry.action === auditLogEvent.MemberBanAdd) return { type: 'ban', label: 'Ban' };
  const isNewTimeout = entry.action === auditLogEvent.MemberUpdate &&
    Array.isArray(entry.changes) &&
    entry.changes.some(change => change.key === 'communication_disabled_until' && change.new != null);
  if (isNewTimeout) return { type: 'timeout', label: 'Timeout' };
  return null;
}

export function shouldMonitorActor(hasMonitoredRole, isQuarantined) {
  return hasMonitoredRole || isQuarantined;
}

export function shouldTriggerProtection(history) {
  if (history.length < 2) return false;
  const burst = history.at(-1) - history.at(-2) <= 10_000;
  return burst || history.length >= 3;
}
