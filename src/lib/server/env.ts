/** Bindings and secrets available to the Worker (see wrangler.jsonc). */
export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  CACHE: KVNamespace;
  /** Optional: without R2, studio uploads are staged in KV (CACHE). */
  MEDIA?: R2Bucket;
  VECTORS: Vectorize;
  AI: Ai;

  SITE_ENV: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  GITHUB_DEPLOY_WORKFLOW: string;
  CF_ACCOUNT_ID: string;

  // Secrets (wrangler secret put …). All optional so a missing one degrades
  // the matching feature instead of breaking the Worker.
  OPENROUTER_API_KEY?: string;
  RAWG_API_KEY?: string;
  GITHUB_TOKEN?: string;
  CF_ANALYTICS_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  STUDIO_OWNER_KEY?: string;
  TURNSTILE_SECRET?: string;
  ALERT_WEBHOOK_URL?: string;
}
