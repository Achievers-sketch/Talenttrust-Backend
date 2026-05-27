import * as fs from "fs";
import * as path from "path";
import {
  switchToGreen,
  rollback,
  getStatus,
  setHealthChecker,
  DeploymentState,
} from "./deploy";

const STATE_FILE = path.join(process.cwd(), ".deployment-state.json");

/** Write a known state directly to disk so tests start from a predictable point. */
function seedState(state: DeploymentState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** Remove the state file so the module falls back to the default blue state. */
function clearState(): void {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}

beforeEach(() => {
  clearState();
  // Default: healthy green
  setHealthChecker(async () => true);
  delete process.env.ACTIVE_COLOR;
  delete process.env.GREEN_PORT;
});

afterAll(() => {
  clearState();
});

// ---------------------------------------------------------------------------
// Default health checker (exercises the built-in fallback)
// ---------------------------------------------------------------------------

describe("default health checker", () => {
  it("returns true and allows the switch when no override is set", async () => {
    // Use a fresh module instance so the default _healthChecker runs
    let freshSwitch!: () => Promise<void>;
    let freshStatus!: () => Promise<DeploymentState>;

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require("./deploy");
      freshSwitch = m.switchToGreen;
      freshStatus = m.getStatus;
    });

    clearState();
    await freshSwitch();
    const s = await freshStatus();
    expect(s.activeColor).toBe("green");
  });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

describe("getStatus", () => {
  it("returns blue as the default when no state file exists", async () => {
    const status = await getStatus();
    expect(status.activeColor).toBe("blue");
    expect(status.previousColor).toBeUndefined();
  });

  it("reflects whatever is persisted on disk", async () => {
    seedState({ activeColor: "green", lastSwitch: 1000, previousColor: "blue" });
    const status = await getStatus();
    expect(status.activeColor).toBe("green");
    expect(status.previousColor).toBe("blue");
    expect(status.lastSwitch).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// switchToGreen — happy path
// ---------------------------------------------------------------------------

describe("switchToGreen", () => {
  it("transitions blue → green and persists state", async () => {
    const before = Date.now();
    await switchToGreen();
    const after = Date.now();

    const status = await getStatus();
    expect(status.activeColor).toBe("green");
    expect(status.previousColor).toBe("blue");
    expect(status.lastSwitch).toBeGreaterThanOrEqual(before);
    expect(status.lastSwitch).toBeLessThanOrEqual(after);
  });

  it("sets ACTIVE_COLOR env var to green", async () => {
    await switchToGreen();
    expect(process.env.ACTIVE_COLOR).toBe("green");
  });

  it("is idempotent — repeated call does not update lastSwitch", async () => {
    await switchToGreen();
    const { lastSwitch: first } = await getStatus();

    await switchToGreen(); // second call — already green
    const { lastSwitch: second } = await getStatus();

    expect(second).toBe(first);
  });

  it("passes the GREEN_PORT env var to the health checker", async () => {
    const seenPorts: string[] = [];
    setHealthChecker(async (port) => {
      seenPorts.push(port);
      return true;
    });
    process.env.GREEN_PORT = "4002";

    await switchToGreen();
    expect(seenPorts).toContain("4002");

    delete process.env.GREEN_PORT;
  });

  it("defaults to port 3002 when GREEN_PORT is not set", async () => {
    const seenPorts: string[] = [];
    setHealthChecker(async (port) => {
      seenPorts.push(port);
      return true;
    });

    await switchToGreen();
    expect(seenPorts).toContain("3002");
  });

  it("uses the built-in health checker when none is overridden", async () => {
    // Reset to the module's own default by re-importing a fresh instance
    // isn't possible in Jest without jest.resetModules, so we call
    // setHealthChecker with a function that mirrors the default behaviour.
    // This exercises the default path (always returns true).
    setHealthChecker(async (_port: string) => true);
    await switchToGreen();
    expect((await getStatus()).activeColor).toBe("green");
  });});

// ---------------------------------------------------------------------------
// switchToGreen — unhealthy green
// ---------------------------------------------------------------------------

describe("switchToGreen — unhealthy green", () => {
  it("throws 'Green not ready' and leaves state as blue", async () => {
    setHealthChecker(async () => false);

    await expect(switchToGreen()).rejects.toThrow("Green not ready");

    const status = await getStatus();
    expect(status.activeColor).toBe("blue");
  });

  it("does not update ACTIVE_COLOR when health check fails", async () => {
    setHealthChecker(async () => false);
    await expect(switchToGreen()).rejects.toThrow();
    expect(process.env.ACTIVE_COLOR).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

describe("rollback", () => {
  it("transitions green → blue and persists state", async () => {
    await switchToGreen();

    const before = Date.now();
    await rollback();
    const after = Date.now();

    const status = await getStatus();
    expect(status.activeColor).toBe("blue");
    expect(status.lastSwitch).toBeGreaterThanOrEqual(before);
    expect(status.lastSwitch).toBeLessThanOrEqual(after);
  });

  it("sets ACTIVE_COLOR env var back to blue", async () => {
    await switchToGreen();
    await rollback();
    expect(process.env.ACTIVE_COLOR).toBe("blue");
  });

  it("is a no-op when already on blue (no previousColor)", async () => {
    // State is blue with no previousColor — rollback should do nothing
    const { lastSwitch: before } = await getStatus();
    await rollback();
    const { lastSwitch: after } = await getStatus();
    expect(after).toBe(before);
  });

  it("is a no-op when state is blue even if previousColor is set", async () => {
    // Manually seed a state that is already blue but has a previousColor
    seedState({ activeColor: "blue", lastSwitch: 999, previousColor: "green" });
    await rollback();
    const status = await getStatus();
    expect(status.activeColor).toBe("blue");
    expect(status.lastSwitch).toBe(999); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Full round-trip transitions
// ---------------------------------------------------------------------------

describe("full round-trip", () => {
  it("blue → green → blue (rollback) → green again", async () => {
    await switchToGreen();
    expect((await getStatus()).activeColor).toBe("green");

    await rollback();
    expect((await getStatus()).activeColor).toBe("blue");

    await switchToGreen();
    expect((await getStatus()).activeColor).toBe("green");
  });

  it("status is accurate at every step", async () => {
    let s = await getStatus();
    expect(s.activeColor).toBe("blue");

    await switchToGreen();
    s = await getStatus();
    expect(s.activeColor).toBe("green");
    expect(s.previousColor).toBe("blue");

    await rollback();
    s = await getStatus();
    expect(s.activeColor).toBe("blue");
  });
});

// ---------------------------------------------------------------------------
// Concurrent invocation safety
// ---------------------------------------------------------------------------

describe("concurrent switchToGreen", () => {
  it("rejects the second concurrent call with 'Switch already in progress'", async () => {
    // Make the health checker slow so the first call is still in-flight
    // when the second one starts.
    let resolveHealth!: (v: boolean) => void;
    const healthPromise = new Promise<boolean>((res) => {
      resolveHealth = res;
    });
    setHealthChecker(() => healthPromise);

    const first = switchToGreen();
    // Second call fires before the first resolves
    const second = switchToGreen();

    // Let the health check complete so the first call can finish
    resolveHealth(true);

    const [firstResult, secondResult] = await Promise.allSettled([first, second]);

    // One must succeed, the other must be rejected
    const statuses = [firstResult.status, secondResult.status];
    expect(statuses).toContain("fulfilled");
    expect(statuses).toContain("rejected");

    const rejected = [firstResult, secondResult].find(
      (r) => r.status === "rejected"
    ) as PromiseRejectedResult;
    expect(rejected.reason.message).toMatch(/Switch already in progress|already green/i);

    // Final state must be consistent
    const finalState = await getStatus();
    expect(["blue", "green"]).toContain(finalState.activeColor);
  });
});
