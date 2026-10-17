export function screenLeaseId(runId: string, fence: number): string {
  return `${runId}:${fence}`;
}

export function parseScreenLeaseId(leaseId: string): { ownerId: string; fence: number } {
  const separator = leaseId.lastIndexOf(":");
  if (separator <= 0) return { ownerId: leaseId, fence: 0 };
  const fence = Number(leaseId.slice(separator + 1));
  if (!Number.isInteger(fence) || fence < 0) return { ownerId: leaseId, fence: 0 };
  return { ownerId: leaseId.slice(0, separator), fence };
}

/** A bare id (no `owner:fence` suffix) is the human's control lease, never an execution. */
export function isUserScreenLease(leaseId: string): boolean {
  return !leaseId.includes(":");
}

export function canTakeScreenLease(
  existing: string | undefined,
  incoming: string | undefined,
): boolean {
  if (!incoming) return false;
  if (!existing || existing === incoming) return true;
  // The human at the screen is never stale: user screen input must not be
  // fence-rejected just because a run renewed its lease. Fenced executions
  // keep ordering among themselves by fence (and still reclaim from a user).
  if (isUserScreenLease(incoming)) return true;
  return parseScreenLeaseId(incoming).fence > parseScreenLeaseId(existing).fence;
}

export function canReleaseScreenLease(
  existing: string | undefined,
  incoming: string | undefined,
): boolean {
  if (!incoming || !existing || existing === incoming) return true;
  const current = parseScreenLeaseId(existing);
  const next = parseScreenLeaseId(incoming);
  return next.ownerId === current.ownerId && next.fence >= current.fence;
}
