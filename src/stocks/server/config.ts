import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Server-side configuration for the stocks plugin.
 *
 * Alpaca keys are read here and handed only to the server-side Alpaca client.
 * They are never VITE_-prefixed, never returned by an endpoint and never
 * logged: the 503 message names where keys were looked for, not their values.
 */

export interface AlpacaCredentials {
  keyId: string;
  secretKey: string;
}

export interface StocksConfig {
  credentials: AlpacaCredentials | null;
  /** "env" or the dotenv path the keys came from (no values). */
  credentialSource: string | null;
  /** The dotenv file consulted when the environment had no keys. */
  dotenvPath: string;
  listPath: string;
  journalPath: string;
  cacheDir: string;
  dataUrl: string;
  /** Trading API hosts for /v2/assets, tried in order. */
  tradingUrls: string[];
}

export type EnvMap = Record<string, string | undefined>;

export const DEFAULTS = {
  dotenv: "../trading-script/.env",
  list: "../trading-script/list.txt",
  journal: "../trading-script/dashboard/data/journal.json",
  cacheDir: ".cache/stocks",
  dataUrl: "https://data.alpaca.markets",
  tradingUrls: ["https://paper-api.alpaca.markets", "https://api.alpaca.markets"],
} as const;

/**
 * Minimal dotenv reader: KEY=VALUE lines, optional `export`, `#` comments,
 * single or double quotes (double quotes understand \n).
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2] ?? "";
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }
    out[key] = value;
  }
  return out;
}

function pickCredentials(env: EnvMap): AlpacaCredentials | null {
  const keyId = (env.ALPACA_API_KEY ?? env.APCA_API_KEY_ID ?? "").trim();
  const secretKey = (env.ALPACA_SECRET_KEY ?? env.APCA_API_SECRET_KEY ?? "").trim();
  return keyId && secretKey ? { keyId, secretKey } : null;
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function resolveConfig(
  env: EnvMap,
  root: string,
  readText: (path: string) => Promise<string | null> = readTextOrNull,
): Promise<StocksConfig> {
  const at = (value: string | undefined, fallback: string) => resolve(root, value?.trim() || fallback);
  const dotenvPath = at(env.STOCKS_DOTENV, DEFAULTS.dotenv);

  let credentials = pickCredentials(env);
  let credentialSource: string | null = credentials ? "env" : null;
  if (!credentials) {
    const text = await readText(dotenvPath);
    if (text != null) {
      credentials = pickCredentials(parseDotenv(text));
      if (credentials) credentialSource = dotenvPath;
    }
  }

  const tradingUrl = env.ALPACA_TRADING_URL?.trim();
  return {
    credentials,
    credentialSource,
    dotenvPath,
    listPath: at(env.STOCKS_LIST_PATH, DEFAULTS.list),
    journalPath: at(env.STOCKS_JOURNAL_PATH, DEFAULTS.journal),
    cacheDir: at(env.STOCKS_CACHE_DIR, DEFAULTS.cacheDir),
    dataUrl: (env.ALPACA_DATA_URL?.trim() || DEFAULTS.dataUrl).replace(/\/+$/, ""),
    tradingUrls: tradingUrl ? [tradingUrl.replace(/\/+$/, "")] : [...DEFAULTS.tradingUrls],
  };
}

export function missingKeysMessage(config: StocksConfig): string {
  return (
    "Alpaca API keys are not configured. Set ALPACA_API_KEY and ALPACA_SECRET_KEY in " +
    `.env.local, or point STOCKS_DOTENV at a dotenv file that has them (looked in ${config.dotenvPath}).`
  );
}
