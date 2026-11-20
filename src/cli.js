import { readFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { AgentService } from './service.js';
import { AppError, errorResult } from './errors.js';

const [command = 'help', ...args] = process.argv.slice(2);
let service;
try {
  if (command === 'help') {
    console.log('Commands: doctor | account | youtube-account | discord-status | prepare / youtube-prepare / discord-prepare --input draft.json | publish / youtube-publish / discord-publish --input operation.json | operation / verify --request-id ID | draft --draft-id ID');
  } else {
    const config = loadConfig();
    service = new AgentService(config);
    let output;
    const input = async () => {
      if (args.length !== 2 || args[0] !== '--input') throw new AppError('invalid_arguments', 'مرّر --input ثم مسار ملف JSON.');
      return JSON.parse((await readFile(args[1], 'utf8')).replace(/^\uFEFF/, ''));
    };
    if (command === 'doctor') {
      try { output = { ready: true, ...await service.browserStatus() }; }
      catch (error) { output = { ready: false, error: errorResult(error), guide: 'docs/brave-setup.md' }; process.exitCode = 2; }
    } else if (command === 'account') output = await service.accountStatus();
    else if (command === 'youtube-account') output = await service.youtubeAccountStatus();
    else if (command === 'discord-status') output = await service.discordStatus();
    else if (command === 'prepare') output = await service.preparePost(await input());
    else if (command === 'youtube-prepare') output = await service.prepareYouTubePost(await input());
    else if (command === 'discord-prepare') output = await service.prepareDiscordPost(await input());
    else if (['publish', 'youtube-publish', 'discord-publish'].includes(command)) {
      const publish = { publish: 'publishPost', 'youtube-publish': 'publishYouTubePost', 'discord-publish': 'publishDiscordPost' }[command];
      output = await service[publish](await input());
      if (output.status !== 'succeeded') process.exitCode = 2;
    } else if (command === 'operation' && args[0] === '--request-id' && args.length === 2) output = service.getOperation({ request_id: args[1] });
    else if (command === 'verify' && args[0] === '--request-id' && args.length === 2) {
      output = await service.verifyOperation({ request_id: args[1] });
      if (output.status !== 'succeeded') process.exitCode = 2;
    }
    else if (command === 'draft' && args[0] === '--draft-id' && args.length === 2) output = service.getDraft({ draft_id: args[1] });
    else throw new AppError('invalid_arguments', 'أمر غير معروف. استخدم node src/cli.js help.');
    console.log(JSON.stringify(output, null, 2));
  }
} catch (error) { console.error(JSON.stringify({ error: errorResult(error) }, null, 2)); process.exitCode = 1; }
finally { await service?.shutdown(); }
