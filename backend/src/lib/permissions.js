// Admin permissions (Section 9.8). Each admin account gets an explicit
// permission set; there is no implicit "super user" that bypasses
// maker-checker. Every permission-gated action is audited.

export const PERMISSIONS = {
  'bookings.manage': 'View bookings, reassign workers, cancel bookings',
  'workers.kyc': 'Review and approve/reject worker KYC',
  'workers.enforce': 'Suspend workers, issue strikes, place payout holds',
  'commission.request': 'Propose a change to a worker commission rate or reactivation',
  'changes.approve': 'Approve commission, reactivation, payout-hold and admin-access changes made by someone else',
  'customers.view': 'View customer accounts',
  'payouts.prepare': 'Generate weekly payout batches',
  'payouts.approve': 'Approve and release payout batches',
  'disputes.manage': 'Handle disputes and request refunds',
  'refunds.approve': 'Approve refunds requested by someone else',
  'fraud.review': 'Review the fraud & anomaly queue',
  'catalog.manage': 'Manage services and pricing',
  'reports.view': 'View reports and dashboards',
  'audit.view': 'View and verify the audit log',
  'admins.manage': 'Create admin accounts, change permissions, run access reviews',
};

// Section 9.8: "no single internal role can both approve a payout AND
// change a worker's commission rate or bank details". Bank details can't
// be edited by any admin at all (only the worker, via penny-drop).
// Approving someone else's change (changes.approve) is the checker side,
// so it may sit with the payout approver: that is how a 2-person team
// gets full maker-checker coverage.
export const CONFLICTS = [
  ['payouts.approve', 'commission.request'],
  ['payouts.approve', 'payouts.prepare'],
  ['refunds.approve', 'disputes.manage'],
  ['admins.manage', 'payouts.approve'],
];

export function validatePermissionSet(perms) {
  const unknown = perms.filter((p) => !(p in PERMISSIONS));
  if (unknown.length) return `Unknown permissions: ${unknown.join(', ')}`;
  for (const [a, b] of CONFLICTS) {
    if (perms.includes(a) && perms.includes(b)) {
      return `Separation of duties: "${a}" and "${b}" cannot be held by the same admin`;
    }
  }
  return null;
}
