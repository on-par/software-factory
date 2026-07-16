// packages/server/src/index.ts — SaaS server placeholder
//
// Phase 2 of the SaaS roadmap: a server that receives GitHub webhook
// triggers and runs the factory pipeline against repos in sandboxed
// environments (Docker/Daytona).
//
// This is a stub — the actual server implementation will use:
//   - Express/Hono for HTTP
//   - @octokit/webhooks for GitHub webhook verification
//   - @on-par/factory-core for the pipeline (ModelRouter, checkers, phases)
//   - Docker/Daytona SDK for sandboxed execution
//   - A job queue (BullMQ/Inngest) for managing concurrent runs

export const SERVER_VERSION = '0.1.0';

export interface ServerConfig {
  port: number;
  webhookSecret: string;
  sandboxProvider: 'docker' | 'daytona';
  autoMerge: boolean;
}

export function createServer(_config: ServerConfig): void {
  throw new Error('Server not yet implemented — see SaaS roadmap in README');
}
