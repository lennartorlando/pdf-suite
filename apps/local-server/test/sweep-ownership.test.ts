import { lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isOwnedByCurrentUser, JobManager } from "../src/jobs.js";

function currentUid(): number | null {
  const getuid = (process as unknown as { getuid?: () => number }).getuid;
  return typeof getuid === "function" ? getuid() : null;
}

describe("startup sweep ownership", () => {
  it("matches only the current owner where ownership exists", () => {
    const uid = currentUid();
    if (uid === null) {
      expect(isOwnedByCurrentUser(undefined)).toBe(true);
      return;
    }
    expect(isOwnedByCurrentUser(uid)).toBe(true);
    const other = uid === 0 ? 1 : uid - 1;
    expect(other).not.toBe(uid);
    expect(isOwnedByCurrentUser(other)).toBe(false);
    expect(isOwnedByCurrentUser(undefined)).toBe(false);
  });

  it("still sweeps owned orphans and keeps rejecting symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "u4f-sweep-"));
    try {
      const orphan = join(root, `job-${"b".repeat(32)}`);
      await mkdir(orphan, { recursive: true });
      await writeFile(join(orphan, "stale.pdf"), Buffer.from("stale"));
      const fillOrphan = join(root, `fill-${"c".repeat(32)}`);
      await mkdir(fillOrphan, { recursive: true });
      await writeFile(join(fillOrphan, "stale.pdf"), Buffer.from("stale"));
      const foreign = join(root, "not-a-job");
      await mkdir(foreign, { recursive: true });
      await symlink(join("nowhere"), join(root, "link-job"), "dir").catch(() => undefined);

      const manager = await JobManager.create({ tempRoot: root });
      try {
        await expect(stat(orphan)).rejects.toThrow();
        await expect(stat(fillOrphan)).rejects.toThrow();
        expect((await stat(foreign)).isDirectory()).toBe(true);
        const linkStat = await lstat(join(root, "link-job")).catch(() => null);
        if (linkStat) expect(linkStat.isSymbolicLink()).toBe(true);
      } finally {
        await manager.shutdown();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
