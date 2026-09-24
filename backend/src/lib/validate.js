import { badRequest } from './errors.js';

// Parse and strictly validate input with a zod schema. Unknown keys are
// rejected so clients can't smuggle fields like "status" or "amount".
export function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest('Invalid input', issues);
  }
  return result.data;
}
