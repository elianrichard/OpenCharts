import { resolve } from "node:path";
import { createServer, loadEnv, type Plugin, type ResolvedConfig, type ViteDevServer } from "vite";
import { STOCKS_API_PREFIX } from "../data/protocol.ts";
import { HttpError, createStocksApi, type StocksApi } from "./api.ts";
import { resolveConfig } from "./config.ts";
import type { ScanFns } from "./scans.ts";

/**
 * Vite plugin: the stock workspace's local backend, mounted at /stocks-api/ on
 * both `vite` (dev) and `vite preview`.
 *
 *   GET /stocks-api/bars?symbol&timeframe&start&end&limit   Bar[] oldest first
 *   GET /stocks-api/snapshots?symbols=A,B                   Record<string, StockSnapshot>
 *   GET /stocks-api/assets?symbols=A,B                      AssetInfo[]
 *   GET /stocks-api/list                                    ListEntry[]
 *   GET /stocks-api/holdings                                HoldingsReport
 *   GET /stocks-api/scans?refresh=1&wait=0                  ScanReport (202 + status while running with wait=0)
 *   GET /stocks-api/scans/status                            ScanStatus
 *
 * Alpaca keys are loaded here with loadEnv (no VITE_ prefix, so they are never
 * exposed to the bundle) or from STOCKS_DOTENV, and used only server-side.
 * Errors are JSON `{ error }`; nothing a route returns or logs carries a key.
 */

export interface AlpacaProxyOptions {
  /** Root-relative module exporting scanDivergence and scanStoch. */
  scansModule?: string;
}

interface Req {
  url?: string;
  method?: string;
}

interface Res {
  statusCode: number;
  headersSent?: boolean;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

type Next = (err?: unknown) => void;

function send(res: Res, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export function alpacaProxy(options: AlpacaProxyOptions = {}): Plugin {
  const scansModule = options.scansModule ?? "/src/stocks/scans/index.ts";
  let config: ResolvedConfig | null = null;
  let devServer: ViteDevServer | null = null;
  /** Preview has no module runner of its own; a headless one loads the scans. */
  let scanRunner: Promise<ViteDevServer> | null = null;
  let api: StocksApi | null = null;

  async function loadScans(): Promise<ScanFns> {
    let mod: Record<string, unknown>;
    try {
      if (devServer) {
        mod = await devServer.ssrLoadModule(scansModule);
      } else {
        const root = config?.root ?? ".";
        scanRunner ??= createServer({
          configFile: false,
          root,
          logLevel: "silent",
          appType: "custom",
          server: { middlewareMode: true, hmr: false, watch: null },
          resolve: { alias: { "@": resolve(root, "src") } },
          optimizeDeps: { noDiscovery: true, include: [] },
        });
        mod = await (await scanRunner).ssrLoadModule(scansModule);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new HttpError(503, `Scans unavailable: could not load ${scansModule}: ${reason}`);
    }
    if (typeof mod.scanDivergence !== "function" || typeof mod.scanStoch !== "function") {
      throw new HttpError(503, `Scans unavailable: ${scansModule} must export scanDivergence and scanStoch`);
    }
    return mod as unknown as ScanFns;
  }

  function getApi(): StocksApi {
    api ??= createStocksApi({
      loadConfig: () => {
        const root = config?.root ?? ".";
        const envDir = typeof config?.envDir === "string" ? config.envDir : root;
        // "" = every variable, not only VITE_*. This stays in the server process.
        return resolveConfig(loadEnv(config?.mode ?? "development", envDir, ""), root);
      },
      loadScans,
    });
    return api;
  }

  // Node's request/response, typed loosely: the repo has no @types/node.
  function middleware(rawReq: unknown, rawRes: unknown, next: Next): void {
    const req = rawReq as Req;
    const res = rawRes as Res;
    const raw = req.url ?? "/";
    const q = raw.indexOf("?");
    let pathname = q >= 0 ? raw.slice(0, q) : raw;
    const base = config?.base ?? "/";
    if (base !== "/" && pathname.startsWith(base)) pathname = `/${pathname.slice(base.length)}`;
    if (pathname !== STOCKS_API_PREFIX && !pathname.startsWith(`${STOCKS_API_PREFIX}/`)) {
      next();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, { error: "Only GET is supported" });
      return;
    }
    const route = pathname.slice(STOCKS_API_PREFIX.length) || "/";
    const params = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : "");
    getApi()
      .handle(route, params)
      .then(({ status, body }) => {
        if (status >= 500) {
          console.warn(`[stocks] ${route} -> ${status}: ${(body as { error?: string }).error ?? ""}`);
        }
        send(res, status, body);
      })
      .catch((err: unknown) => {
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
  }

  return {
    name: "opencharts-stocks-alpaca",
    configResolved(resolved) {
      config = resolved;
    },
    configureServer(server) {
      devServer = server;
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
      server.httpServer?.once("close", () => {
        void scanRunner?.then((runner) => runner.close());
      });
    },
  };
}
