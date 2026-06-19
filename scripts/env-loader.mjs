import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadLocalEnv({
  cwd = process.cwd(),
  env = process.env,
  files = [".env.local"]
} = {}) {
  const fileEnv = {};

  for (const file of files) {
    Object.assign(fileEnv, readEnvFile(resolve(cwd, file)));
  }

  return {
    ...fileEnv,
    ...env
  };
}

function readEnvFile(path) {
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function parseEnv(text) {
  const values = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = cleanKey(line.slice(0, equalsIndex));
    if (!key) continue;

    values[key] = stripQuotes(line.slice(equalsIndex + 1).trim());
  }

  return values;
}

function cleanKey(value) {
  return value.replace(/^export\s+/, "").trim();
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}
