import { expect } from 'vitest';

/** expect.stringContaining is typed any; this keeps test code under the no-any rules. */
export const containing = (text: string): string => expect.stringContaining(text) as string;
