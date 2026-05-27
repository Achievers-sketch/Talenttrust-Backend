import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

/**
 * Blue-green deployment state machine.
 *
 * Transitions:
 *   blue  --switchToGreen()--> green
 *   green --rollback()-------> blue
 *
 * State is persisted to `.deployment-state.json` so it survives process
 * restarts.  The file is gitignored; never put secrets in it.
 *
 * Concurrency: a simple in-process mutex prevents two concurrent
 * `switchToGreen` calls from racing on the state file.
 *
 * @module deploy
 */

const STATE_FILE = path.join(process.cwd(), ".deployment-state.json");

/** Shape of the persisted deployment state. */
export interface DeploymentState {
  activeColor: "blue" | "green";
  /** Unix ms timestamp of the last successful transition. */
  lastSwitch: number;
  /** The color that was active before the most recent switch. */
  previousColor?: "blue" | "green";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

async function readState(): Promise<DeploymentState> {
  try {
    const data = await readFileAsync(STATE_FILE, "utf8");
    return JSON.parse(data) as DeploymentState;
  } catch {
    return { activeColor: "blue", lastSwitch: Date.now() };
  }
}

async function writeState(state: DeploymentState): Promise<void> {
  await writeFileAsync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Health-check function used by `switchToGreen`.
 * Replaced in tests via `setHealthChecker`.
 */
let _healthChecker: (port: string) => Promise<boolean> = async (_port) => {
  // Real implementation would do:
  //   const res = await axios.get(`http://localhost:${_port}/health/ready`);
  //   return res.status === 200;
  return true;
};

/**
 * Override the health-check implementation.
 * Intended for testing only — do not call in production code.
 *
 * @param fn - Async function that returns `true` when the target is healthy.
 */
export function setHealthChecker(
  fn: (port: string) => Promise<boolean>
): void {
  _healthChecker = fn;
}

// Simple in-process mutex to guard concurrent switch attempts.
let _switching = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Promote the green instance to active.
 *
 * - No-op (idempotent) when green is already active.
 * - Throws `Error("Green not ready")` when the health check fails.
 * - Throws `Error("Switch already in progress")` when called concurrently.
 *
 * @throws {Error} If green is unhealthy or a switch is already in progress.
 */
export async function switchToGreen(): Promise<void> {
  const state = await readState();
  if (state.activeColor === "green") return; // idempotent

  if (_switching) throw new Error("Switch already in progress");
  _switching = true;

  try {
    const greenHealthy = await _healthChecker(
      process.env.GREEN_PORT ?? "3002"
    );
    if (!greenHealthy) throw new Error("Green not ready");

    state.previousColor = state.activeColor;
    state.activeColor = "green";
    state.lastSwitch = Date.now();
    await writeState(state);
    process.env.ACTIVE_COLOR = "green";
    console.log("Switched to green");
  } finally {
    _switching = false;
  }
}

/**
 * Roll back to the previous (blue) color.
 *
 * - No-op when already on blue or when there is no recorded previous color.
 */
export async function rollback(): Promise<void> {
  const state = await readState();
  if (state.activeColor === "blue" || !state.previousColor) return;

  state.activeColor = state.previousColor;
  state.lastSwitch = Date.now();
  await writeState(state);
  process.env.ACTIVE_COLOR = state.activeColor;
  console.log("Rolled back to", state.activeColor);
}

/**
 * Return the current deployment state without modifying it.
 */
export async function getStatus(): Promise<DeploymentState> {
  return readState();
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/* istanbul ignore next */
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === "switch-green") {
    switchToGreen().catch(console.error);
  } else if (cmd === "rollback") {
    rollback().catch(console.error);
  } else if (cmd === "status") {
    getStatus().then(console.log);
  }
}
