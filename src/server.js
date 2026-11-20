import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { AgentService } from './service.js';
import { createMcpServer } from './mcp.js';
import { errorResult } from './errors.js';

try {
  const service = new AgentService(loadConfig());
  const handle = serveStdio(() => createMcpServer(service), {
    onerror: () => console.error('MCP connection error.'),
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await handle.close();
    await service.shutdown();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  process.stdin.once('end', () => void shutdown());
} catch (error) {
  console.error(JSON.stringify({ error: errorResult(error) }));
  process.exitCode = 1;
}
