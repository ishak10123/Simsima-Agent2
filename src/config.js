import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { AppError } from './errors.js';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function validateEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new AppError('invalid_config', 'عنوان CDP غير صالح.'); }
  if (!['http:', 'ws:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || url.username || url.password || url.search || url.hash) {
    throw new AppError('invalid_config', 'استخدم عنوان CDP محليًا بمنفذ صريح، مثل http://127.0.0.1:9222.');
  }
  return url.href.replace(/\/$/, '');
}

export function loadConfig(env = process.env) {
  let file = {};
  const path = env.SIMSIMA_CONFIG ? resolve(env.SIMSIMA_CONFIG) : resolve(projectRoot, 'config.local.json');
  try { file = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code !== 'ENOENT' || env.SIMSIMA_CONFIG) {
      throw new AppError('invalid_config', 'تعذر قراءة ملف إعدادات الأداة.', { path });
    }
  }
  const timeoutMs = file.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new AppError('invalid_config', 'timeoutMs يجب أن يكون بين 1000 و120000.');
  }
  const localData = env.LOCALAPPDATA ?? resolve(homedir(), 'AppData', 'Local');
  const profileDir = resolve(env.SIMSIMA_PROFILE_DIR ?? file.profileDir ?? resolve(localData, 'SimsimaAgent', 'Brave'));
  const personalBraveRoot = resolve(localData, 'BraveSoftware', 'Brave-Browser', 'User Data').toLowerCase();
  if (profileDir.toLowerCase() === personalBraveRoot || profileDir.toLowerCase().startsWith(`${personalBraveRoot}\\`)
      || profileDir.toLowerCase().startsWith(`${personalBraveRoot}/`)) {
    throw new AppError('invalid_config', 'ملف الأداة يجب أن يكون مستقلًا عن ملف Brave الشخصي لمنع التعارض.');
  }
  const dataDir = resolve(projectRoot, env.SIMSIMA_DATA_DIR ?? file.dataDir ?? '.data');
  return {
    cdpEndpoint: validateEndpoint(env.SIMSIMA_CDP_ENDPOINT ?? file.cdpEndpoint ?? 'http://127.0.0.1:9222'),
    dataDir,
    discordConfigPath: resolve(projectRoot, env.SIMSIMA_DISCORD_CONFIG ?? file.discordConfigPath ?? resolve(dataDir, 'discord.json')),
    discordWebhookUrl: env.SIMSIMA_DISCORD_WEBHOOK_URL,
    profileDir,
    bravePath: env.SIMSIMA_BRAVE_PATH ?? file.bravePath ?? 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    timeoutMs,
  };
}
