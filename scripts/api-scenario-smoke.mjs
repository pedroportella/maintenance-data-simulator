#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  runApiScenarioSmoke
} from "../src/api/api-scenario-smoke.mjs";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runApiScenarioSmoke(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}
