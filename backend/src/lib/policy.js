// The worker agreement's anti-cash clause (Section 9.6). Workers must
// accept the current version before taking jobs; a confirmed cash-demand
// strike resets the acknowledgement and forces re-training.
// NOTE: have a lawyer finalise this text before launch (Section 13).

import { config } from '../config.js';
import { sha256Hex } from './crypto.js';

export const WORKER_POLICY_TEXT = `PLATFORM PAYMENT POLICY (version ${config.policyVersion})

1. All payments for jobs booked through this platform must be made by the customer inside the app. You must never ask for, suggest, or accept cash, UPI transfers to you, or any payment outside the app.
2. Prices are fixed by the platform and shown to the customer before booking. You may not negotiate or charge extra on site.
3. You must check in with GPS at the customer's address when you arrive, and complete the job only by entering the completion code the customer gives you when they are satisfied.
4. You must not share your personal phone number or take the customer's number. Use in-app chat and masked calling only.
5. Using mock-location or GPS spoofing apps is a security violation and results in immediate suspension.
6. Consequences: a confirmed cash-payment request results in a formal warning and mandatory re-training (1st), a 7-day suspension (2nd), and permanent deactivation (3rd). A confirmed off-app job diversion results in a payout hold and deactivation. Taking payment outside the app is a violation of the platform agreement and grounds for permanent removal, with commission owed on any confirmed off-app job recovered from pending payouts where legally applicable.
7. Your earnings (job price minus your commission rate) are paid weekly to your verified bank/UPI account.`;

export const WORKER_POLICY_SHA256 = sha256Hex(WORKER_POLICY_TEXT);
