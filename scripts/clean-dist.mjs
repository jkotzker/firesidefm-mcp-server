// Empties dist/ before a build so files from deleted or renamed sources never reach the package.
// The directory itself is kept: it may carry attributes (such as a sync-exclusion marker) that
// would be lost if it were deleted and recreated.
import { existsSync, readdirSync, rmSync } from 'node:fs';

const dist = new URL('../dist/', import.meta.url);
if (existsSync(dist)) {
  for (const entry of readdirSync(dist)) rmSync(new URL(entry, dist), { recursive: true, force: true });
}
