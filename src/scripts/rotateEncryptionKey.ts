import { getPool } from "../db/pool.js";
import { PostgresTenantStore } from "../store/postgres.js";

function parseArgs(argv: string[]): { oldKey?: string; newKey?: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return { oldKey: out["old-key"], newKey: out["new-key"] };
}

/**
 * Re-encrypts every tenant's stored channel credentials from the old
 * LEADRECOVERY_ENCRYPTION_KEY to a new one. This is a batch job, not a
 * runtime concern — the running app already tolerates both keys during a
 * rotation window via LEADRECOVERY_ENCRYPTION_KEY_PREVIOUS (see
 * src/store/postgres.ts's decodeChannels fallback), so this script can run
 * at any time without downtime. Full rotation procedure (see
 * DEPLOYMENT.md "Rotating the encryption key"):
 *
 *   1. Set LEADRECOVERY_ENCRYPTION_KEY=<new> and
 *      LEADRECOVERY_ENCRYPTION_KEY_PREVIOUS=<old>, redeploy.
 *   2. Run this script: npm run rotate-encryption-key -- --old-key <old> --new-key <new>
 *   3. Once it reports every tenant re-encrypted, remove
 *      LEADRECOVERY_ENCRYPTION_KEY_PREVIOUS and redeploy again.
 */
async function main() {
  const { oldKey, newKey } = parseArgs(process.argv.slice(2));
  if (!oldKey || !newKey) {
    console.error("Usage: npm run rotate-encryption-key -- --old-key <base64> --new-key <base64>");
    process.exitCode = 1;
    return;
  }
  if (oldKey === newKey) {
    console.error("--old-key and --new-key are identical — nothing to rotate.");
    process.exitCode = 1;
    return;
  }

  const pool = getPool();
  const readWithOldKey = new PostgresTenantStore(pool, oldKey);
  // updateTenant() re-reads the existing row internally before merging the
  // patch — this store must be able to decode that still-old-key-encrypted
  // row too (it's the target key, but the row it's about to overwrite
  // hasn't been rotated yet), hence oldKey as the fallback here as well.
  const writeWithNewKey = new PostgresTenantStore(pool, newKey, oldKey);

  const tenants = await readWithOldKey.listTenants();
  console.log(`Re-encrypting channel credentials for ${tenants.length} tenant(s)...`);

  let rotated = 0;
  let failed = 0;
  for (const tenant of tenants) {
    try {
      // Re-reads and re-decrypts fresh (rather than reusing `tenant` from
      // listTenants above) so a concurrent write to this tenant mid-rotation
      // isn't clobbered by a stale in-memory copy.
      const fresh = await readWithOldKey.getTenant(tenant.id);
      if (!fresh) continue;
      await writeWithNewKey.updateTenant(tenant.id, { channels: fresh.channels });
      rotated++;
    } catch (err) {
      failed++;
      console.error(`✗ ${tenant.id} (${tenant.name}): ${(err as Error).message}`);
    }
  }

  console.log(`Done: ${rotated} re-encrypted, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
