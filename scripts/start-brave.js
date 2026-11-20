import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

// Deliberately does not stop Brave, copy a profile, or export account credentials.
const config = loadConfig();
try {
  const versionUrl = new URL('/json/version', config.cdpEndpoint);
  if ((await fetch(versionUrl, { signal: AbortSignal.timeout(1200) })).ok) {
    console.log('Brave متصل بالفعل. شغّل npm run account.');
    process.exit(0);
  }
} catch { /* Start only if no configured CDP endpoint is running. */ }

try {
  if (process.platform !== 'win32') throw new Error('هذا المشغّل مخصص لنظام Windows.');
  const { stdout } = await promisify(execFile)('tasklist.exe', ['/FI', 'IMAGENAME eq brave.exe', '/FO', 'CSV', '/NH'], { windowsHide: true });
  if (/"brave\.exe"/i.test(stdout)) {
    throw new Error('Brave مفتوح دون اتصال CDP. احفظ عملك، واختر Exit من قائمة Brave، ثم شغّل npm run brave مرة أخرى. لن تغلق الأداة المتصفح بالنيابة عنك.');
  }
  await access(config.bravePath);
  const profileRoot = join(process.env.LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'User Data');
  let profile = 'Default';
  try {
    const state = JSON.parse(await readFile(join(profileRoot, 'Local State'), 'utf8'));
    if (typeof state.profile?.last_used === 'string' && /^(Default|Profile \d+)$/.test(state.profile.last_used)) profile = state.profile.last_used;
  } catch { /* Brave's default profile remains the fallback. */ }
  const endpoint = new URL(config.cdpEndpoint);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new Error('للتشغيل التلقائي استخدم http://127.0.0.1 مع منفذ محلي.');
  const child = spawn(config.bravePath, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${endpoint.port}`,
    `--user-data-dir=${profileRoot}`, `--profile-directory=${profile}`, '--restore-last-session'], {
    detached: true, windowsHide: true, stdio: 'ignore', shell: false,
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      if ((await fetch(new URL('/json/version', endpoint), { signal: AbortSignal.timeout(500) })).ok) {
        console.log('Brave متصل مع ملف الحساب الحالي. شغّل npm run account.');
        process.exit(0);
      }
    } catch { /* Browser startup has a short bounded wait. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('بدأ Brave لكن لم يظهر منفذ CDP. راجع docs/brave-setup.md؛ لا تفترض الأداة نجاح الاتصال.');
} catch (error) { console.error(error.message); process.exitCode = 2; }
