/**
 * Container config write-seam tests.
 *
 * 1. `ensureContainerConfig` provider stamping (global-default-provider
 *    feature). Two load-bearing guarantees:
 *      a. A fresh row is stamped with the given provider (claude → NULL), so a
 *         new group is created on the instance default.
 *      b. An existing row is never overwritten (INSERT OR IGNORE), so enabling a
 *         non-claude default never retroactively flips existing groups.
 * 2. `updateContainerConfigScalars` image_tag allowlist. The column is consumed
 *    unchecked as the `docker run` image argument (`buildContainerArgs`), so
 *    only this install's base image and the group's own built image may be
 *    written.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A deliberately non-default base — proves the allowlist is derived from
// CONTAINER_IMAGE_BASE at call time rather than from a baked
// `nanoclaw-agent-v2-<slug>` pattern, which is what keeps the documented
// CONTAINER_IMAGE_BASE / CONTAINER_IMAGE overrides working. Literals are
// repeated below because a vi.mock factory is hoisted above the consts.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return {
    ...actual,
    CONTAINER_IMAGE_BASE: 'registry.example.test/custom-agent',
    CONTAINER_IMAGE: 'registry.example.test/custom-agent:latest',
  };
});

const BASE = 'registry.example.test/custom-agent';
const IMAGE = `${BASE}:latest`;

import { initTestDb, closeDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import { createAgentGroup } from './agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from './container-configs.js';

function makeGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
}

describe('ensureContainerConfig provider stamping', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });
  afterEach(() => {
    closeDb();
  });

  it('stamps a non-default provider on a fresh row; claude is stored as NULL', () => {
    makeGroup('ag-codex');
    ensureContainerConfig('ag-codex', 'codex');
    expect(getContainerConfig('ag-codex')?.provider).toBe('codex');

    makeGroup('ag-claude');
    ensureContainerConfig('ag-claude', 'claude');
    expect(getContainerConfig('ag-claude')?.provider).toBeNull();

    // Casing is normalized to match what resolution lowercases to.
    makeGroup('ag-cased');
    ensureContainerConfig('ag-cased', 'Codex');
    expect(getContainerConfig('ag-cased')?.provider).toBe('codex');

    makeGroup('ag-cased-claude');
    ensureContainerConfig('ag-cased-claude', 'Claude');
    expect(getContainerConfig('ag-cased-claude')?.provider).toBeNull();
  });

  it('never overwrites an existing row — existing groups are not flipped', () => {
    makeGroup('ag-existing');
    ensureContainerConfig('ag-existing', 'codex'); // existing group already on codex
    expect(getContainerConfig('ag-existing')?.provider).toBe('codex');

    // A later bare ensure (defensive re-init, or a changed instance default)
    // must NOT change it — INSERT OR IGNORE keeps the row frozen.
    ensureContainerConfig('ag-existing');
    expect(getContainerConfig('ag-existing')?.provider).toBe('codex');
  });
});

describe('updateContainerConfigScalars image_tag allowlist', () => {
  const GID = 'ag-tagged';

  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    makeGroup(GID);
    ensureContainerConfig(GID);
  });
  afterEach(() => {
    closeDb();
  });

  it("accepts the install base image and the group's own built image", () => {
    // The two values the tree ever writes: `buildAgentGroupImage` stores
    // `${CONTAINER_IMAGE_BASE}:${agentGroupId}` after a derived build, and the
    // base image is the "no derived image" value.
    updateContainerConfigScalars(GID, { image_tag: `${BASE}:${GID}` });
    expect(getContainerConfig(GID)?.image_tag).toBe(`${BASE}:${GID}`);

    updateContainerConfigScalars(GID, { image_tag: IMAGE });
    expect(getContainerConfig(GID)?.image_tag).toBe(IMAGE);
  });

  it('accepts NULL and empty string as "inherit the base image"', () => {
    // `containerConfig.imageTag || CONTAINER_IMAGE` treats both the same; this
    // is how a derived image is retired (and what the registry reconcile does).
    updateContainerConfigScalars(GID, { image_tag: `${BASE}:${GID}` });
    updateContainerConfigScalars(GID, { image_tag: null });
    expect(getContainerConfig(GID)?.image_tag).toBeNull();

    updateContainerConfigScalars(GID, { image_tag: '' });
    expect(getContainerConfig(GID)?.image_tag).toBe('');
  });

  it('rejects any image reference outside this install', () => {
    const rejected = [
      'evil.example.com/backdoor:latest', // a foreign registry
      'nanoclaw-agent-v2-deadbeef:latest', // another install's slug
      `${BASE}:ag-someone-else`, // another group's derived image
      `${BASE}:${GID} --privileged`, // argument smuggling into the docker ref
      BASE, // the repository with no tag — resolves to :latest elsewhere
      'ubuntu', // an arbitrary public image
    ];
    for (const tag of rejected) {
      expect(() => updateContainerConfigScalars(GID, { image_tag: tag })).toThrow(/Invalid image_tag/);
    }
    expect(getContainerConfig(GID)?.image_tag).toBeNull();
  });

  it('rejects a non-string value', () => {
    // `ncl groups config update --image-tag` with no value parses to boolean
    // true; without this it reached better-sqlite3 as an opaque bind error.
    expect(() => updateContainerConfigScalars(GID, { image_tag: true as unknown as string })).toThrow(
      /Invalid image_tag/,
    );
  });

  it('aborts the whole update when the image_tag is rejected', () => {
    // Validation runs before any field is bound, so a rejected tag must not
    // leave the other scalars in the same call half-applied.
    expect(() =>
      updateContainerConfigScalars(GID, { model: 'opus', image_tag: 'evil.example.com/backdoor:latest' }),
    ).toThrow(/Invalid image_tag/);
    const row = getContainerConfig(GID);
    expect(row?.model).toBeNull();
    expect(row?.image_tag).toBeNull();
  });

  it('leaves the other scalar columns untouched by the check', () => {
    updateContainerConfigScalars(GID, { model: 'opus', effort: 'high', cli_scope: 'global' });
    const row = getContainerConfig(GID);
    expect(row?.model).toBe('opus');
    expect(row?.effort).toBe('high');
    expect(row?.cli_scope).toBe('global');
  });

  it('offers no derived-image option for a group id that is not a valid tag', () => {
    // Nothing in the tree generates such an id, but the column is reachable
    // from imported/hand-edited rows and the tag is interpolated into a shell
    // command by `buildAgentGroupImage`.
    const weird = 'ag-$(touch /tmp/pwned)';
    makeGroup(weird);
    ensureContainerConfig(weird);
    expect(() => updateContainerConfigScalars(weird, { image_tag: `${BASE}:${weird}` })).toThrow(/Invalid image_tag/);
    // The base image is still writable — the id only gates the derived form.
    updateContainerConfigScalars(weird, { image_tag: IMAGE });
    expect(getContainerConfig(weird)?.image_tag).toBe(IMAGE);
  });
});
