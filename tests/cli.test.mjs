import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertScenarioPack } from "../src/contracts/scenario-contract.mjs";

const cliPath = fileURLToPath(new URL("../scripts/simulator.mjs", import.meta.url));

test("generate command writes a deterministic scenario pack to stdout", () => {
  const result = runCli(["generate", "--scenario", "baseline-week"]);

  assert.equal(result.status, 0, result.stderr);
  const scenarioPack = JSON.parse(result.stdout);

  assertScenarioPack(scenarioPack);
  assert.equal(scenarioPack.scenarioId, "baseline-week");
  assert.equal(scenarioPack.events[0].eventId.startsWith("evt-baseline-week-"), true);
});

test("feed dry-run emits structured logs without raw credential-like URL parts", () => {
  const result = runCli([
    "feed",
    "--scenario",
    "baseline-week",
    "--api-url",
    "http://user:secret@host.docker.internal:5000/import?token=do-not-log#fragment",
    "--dry-run"
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes("secret"), false);
  assert.equal(result.stdout.includes("do-not-log"), false);

  const logs = result.stdout.trim().split("\n").map((line) => JSON.parse(line));

  assert.deepEqual(logs.map((entry) => entry.message), [
    "dry-run-started",
    "dry-run-completed"
  ]);
  assert.equal(logs[0].command, "feed");
  assert.equal(logs[0].mode, "dry-run");
  assert.equal(logs[0].apiTarget, "http://host.docker.internal:5000/import");
  assert.equal(logs[1].summary.scenarioId, "baseline-week");
});

test("feed without dry-run fails before live posting", () => {
  const result = runCli([
    "feed",
    "--scenario",
    "baseline-week",
    "--api-url",
    "http://host.docker.internal:5000"
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /http-feed-not-implemented/);
  assert.match(result.stderr, /planned for a later stage/);
});

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });
}
