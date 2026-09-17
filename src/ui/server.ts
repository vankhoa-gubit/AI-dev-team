import http from "node:http";
import type { AddressInfo } from "node:net";
import type { HarnessConfig } from "../config.js";
import { createHttpHandler } from "./routes.js";
import { assertLoopbackHost } from "./security.js";

export interface HarnessUiServerOptions {
  host?: string;
  port?: number;
}

export class HarnessUiServer {
  private server: http.Server | null = null;
  private readonly host: string;
  private readonly requestedPort: number;
  private actualPort = 0;
  private readonly config: HarnessConfig;
  private readonly harnessRoot: string;

  constructor(
    config: HarnessConfig,
    harnessRoot: string,
    options: HarnessUiServerOptions = {},
  ) {
    this.config = config;
    this.harnessRoot = harnessRoot;
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 4310;
    assertLoopbackHost(this.host);
  }

  async start(): Promise<void> {
    assertLoopbackHost(this.host);
    if (this.server) {
      throw new Error("Server is already running");
    }

    const handler = createHttpHandler(this.config, this.harnessRoot);

    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        void handler(req, res);
      });

      srv.once("error", (err) => {
        this.server = null;
        reject(err);
      });

      srv.listen(this.requestedPort, this.host, () => {
        const address = srv.address() as AddressInfo;
        this.actualPort = address.port;
        this.server = srv;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const srv = this.server;
    if (!srv) return;
    this.server = null;

    if (typeof srv.closeIdleConnections === "function") {
      srv.closeIdleConnections();
    }
    if (typeof (srv as any).closeAllConnections === "function") {
      (srv as any).closeAllConnections();
    }

    return new Promise((resolve, reject) => {
      srv.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  get listening(): boolean {
    return this.server !== null && this.server.listening;
  }

  get port(): number {
    return this.actualPort || this.requestedPort;
  }

  get hostName(): string {
    return this.host;
  }

  get address(): { host: string; port: number } {
    return { host: this.host, port: this.port };
  }

  get url(): string {
    const formattedHost = this.host.includes(":") ? `[${this.host}]` : this.host;
    return `http://${formattedHost}:${this.port}`;
  }
}
