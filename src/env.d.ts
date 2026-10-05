/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

type CfRuntime = import("@astrojs/cloudflare").Runtime<import("./lib/server/env").Env>;

declare namespace App {
  interface Locals extends CfRuntime {}
}
