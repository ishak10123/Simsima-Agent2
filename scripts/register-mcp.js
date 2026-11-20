import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot } from '../src/config.js';

const path = join(projectRoot, '.codex', 'config.toml');
const section = `[mcp_servers.simsima_x]\ncommand = ${JSON.stringify(process.execPath.replaceAll('\\', '/'))}\nargs = [${JSON.stringify(join(projectRoot, 'src', 'server.js').replaceAll('\\', '/'))}]\ntool_timeout_sec = 120\n`;
let previous = '';
try { previous = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (/^\[mcp_servers\.simsima_x\]/m.test(previous)) {
  if (!previous.includes(section)) throw new Error('simsima_x already exists with different settings; preserved the existing configuration.');
  console.log('MCP configuration is already registered.');
} else if (!process.argv.includes('--write')) {
  console.log(JSON.stringify({ path, append: section, backup: Boolean(previous) }, null, 2));
} else {
  await mkdir(join(projectRoot, '.codex'), { recursive: true });
  if (previous) await copyFile(path, `${path}.bak-${Date.now()}`);
  await writeFile(path, `${previous}${previous.endsWith('\n') || !previous ? '' : '\n'}\n${section}`, 'utf8');
  console.log(`Registered simsima_x in ${path}`);
}
