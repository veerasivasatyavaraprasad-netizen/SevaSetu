// In-app chat filter (Section 9.1): blocks sharing contact details or
// payment handles that enable off-app deals.

const PATTERNS = [
  // Phone numbers, including spaced/dotted/dashed forms and +91 prefixes.
  /(?:\+?\d[\s.\-()]*){10,13}/g,
  // Email addresses.
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  // UPI IDs (name@bank).
  /\b[a-z0-9.\-_]{2,256}@[a-z]{2,64}\b/gi,
  // Messaging deep links.
  /\b(?:wa\.me|api\.whatsapp\.com|t\.me|telegram\.me)\/\S*/gi,
];

const CASH_WORDS = /\b(cash|gpay|google\s*pay|phone\s*pe|phonepe|paytm|upi|pay\s+me\s+directly|outside\s+the\s+app|directly\s+to\s+me)\b/i;

export function redactMessage(text) {
  let out = text;
  let redacted = false;
  for (const re of PATTERNS) {
    out = out.replace(re, () => {
      redacted = true;
      return '[hidden]';
    });
  }
  return { text: out, redacted, mentionsOffAppPayment: CASH_WORDS.test(text) };
}
