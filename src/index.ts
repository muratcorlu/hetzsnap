#!/usr/bin/env node
import { execSync } from 'child_process';
import { writeFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import { loadConfig, CONFIG_PATH } from './config.js';
import { createHetznerClient, ApiError } from './hetzner.js';
import { createCloudflareClient } from './cloudflare.js';

const command = process.argv[2];

function snapshotName(prefix: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${prefix}-${date}-${time}`;
}

function clearSshKnownHost(hostname: string): void {
  try {
    execSync(`ssh-keygen -R ${hostname}`, { stdio: 'pipe' });
    console.log(`Cleared SSH known_hosts entry for ${hostname}`);
  } catch {
    // not present in known_hosts — fine
  }
}

async function start() {
  const config = loadConfig();
  const hetzner = createHetznerClient(config.tokens.hetzner);

  console.log('Looking for existing server...');
  const existing = await hetzner.findServer(config.server.name);
  if (existing) {
    console.log(`Server "${config.server.name}" is already running (status: ${existing.status})`);
    console.log(`IP: ${existing.public_net.ipv4.ip}`);
    return;
  }

  console.log(`Finding latest snapshot with prefix "${config.server.snapshotPrefix}"...`);
  const snapshot = await hetzner.findLatestSnapshot(config.server.snapshotPrefix);

  let image: number | string;
  if (snapshot) {
    console.log(`Found snapshot: ${snapshot.id} — ${snapshot.description}`);
    image = snapshot.id;
  } else {
    const baseImage = config.server.baseImage ?? 'ubuntu-24.04';
    console.log(`No snapshot found. Starting fresh from base image "${baseImage}".`);
    image = baseImage;
  }

  const sshKeyIds = await Promise.all(config.server.sshKeys.map((k) => hetzner.findSshKeyByName(k)));

  console.log(`Creating server "${config.server.name}" (${config.server.serverType}, ${config.server.location})...`);
  const server = await hetzner.createServer({
    name: config.server.name,
    serverType: config.server.serverType,
    location: config.server.location,
    image,
    sshKeyIds,
  });
  console.log(`Server created (id: ${server.id}), waiting for it to start...`);

  const running = await hetzner.waitForServerStatus(server.id, 'running');
  const ip = running.public_net.ipv4.ip;
  console.log(`Server is running. IP: ${ip}`);

  if (config.tokens.cloudflare && config.cloudflare) {
    const cloudflare = createCloudflareClient(config.tokens.cloudflare);
    console.log(`Updating DNS record "${config.cloudflare.recordName}" → ${ip}...`);
    await cloudflare.upsertARecord(config.cloudflare.zoneId, config.cloudflare.recordName, ip);
    console.log('DNS record updated.');
    clearSshKnownHost(config.cloudflare.recordName);
    console.log(`\nDev server is ready at ${ip} (${config.cloudflare.recordName})`);
  } else {
    console.log(`\nDev server is ready at ${ip}`);
  }
}

function formatUptime(created: string): string {
  const ms = Date.now() - new Date(created).getTime();
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatAge(created: string): string {
  const ms = Date.now() - new Date(created).getTime();
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days > 0) return `${days}d ${hours}h ago`;
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h ${minutes}m ago`;
  return `${minutes}m ago`;
}

async function snapshots() {
  const config = loadConfig();
  const hetzner = createHetznerClient(config.tokens.hetzner);

  const list = await hetzner.findSnapshotsByPrefix(config.server.snapshotPrefix);
  if (list.length === 0) {
    console.log(`No snapshots found with prefix "${config.server.snapshotPrefix}".`);
    return;
  }

  const nameWidth = Math.max(...list.map((s) => s.description.length), 'NAME'.length);
  const header = `${'NAME'.padEnd(nameWidth)}  ${'AGE'.padEnd(14)}  SIZE`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const snap of list) {
    const age = formatAge(snap.created);
    const size = snap.image_size != null ? `${snap.image_size.toFixed(1)} GB` : 'n/a';
    console.log(`${snap.description.padEnd(nameWidth)}  ${age.padEnd(14)}  ${size}`);
  }
}

async function snapshotsCleanup(yes: boolean) {
  const config = loadConfig();
  const hetzner = createHetznerClient(config.tokens.hetzner);

  const list = await hetzner.findSnapshotsByPrefix(config.server.snapshotPrefix);
  if (list.length <= 1) {
    console.log('Nothing to clean up — at most one snapshot exists.');
    return;
  }

  const [, ...toDelete] = list; // list is sorted newest-first
  console.log(`Will delete ${toDelete.length} snapshot(s), keeping "${list[0].description}":`);
  for (const snap of toDelete) {
    const size = snap.image_size != null ? `${snap.image_size.toFixed(1)} GB` : 'n/a';
    console.log(`  - ${snap.description}  (${formatAge(snap.created)}, ${size})`);
  }

  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await ask(rl, '\nProceed? (y/N)', 'N');
    rl.close();
    if (answer.toLowerCase() !== 'y') {
      console.log('Aborted.');
      return;
    }
  }

  for (const snap of toDelete) {
    process.stdout.write(`Deleting "${snap.description}"... `);
    await hetzner.changeImageProtection(snap.id, false);
    await hetzner.deleteImage(snap.id);
    console.log('done.');
  }
  console.log('Cleanup complete.');
}

async function status() {
  const config = loadConfig();
  const hetzner = createHetznerClient(config.tokens.hetzner);

  const server = await hetzner.findServer(config.server.name);
  if (!server) {
    console.log(`No server named "${config.server.name}" is currently running.`);
    return;
  }

  const uptime = server.status === 'running' ? ` (up ${formatUptime(server.created)})` : '';
  console.log(`Name:    ${server.name}`);
  console.log(`Status:  ${server.status}${uptime}`);
  console.log(`IP:      ${server.public_net.ipv4.ip}`);
}

async function stop() {
  const config = loadConfig();
  const hetzner = createHetznerClient(config.tokens.hetzner);

  console.log(`Looking for server "${config.server.name}"...`);
  const server = await hetzner.findServer(config.server.name);
  if (!server) {
    console.log('No running server found. Nothing to stop.');
    return;
  }
  console.log(`Found server (id: ${server.id}, status: ${server.status})`);

  if (server.status === 'running') {
    console.log('Shutting down server...');
    await hetzner.shutdownServer(server.id);
    await hetzner.waitForServerStatus(server.id, 'off');
    console.log('Server is off.');
  }

  const oldSnapshots = await hetzner.findSnapshotsByPrefix(config.server.snapshotPrefix);

  const name = snapshotName(config.server.snapshotPrefix);
  console.log(`Taking snapshot "${name}"...`);
  const { imageId, actionId } = await hetzner.createSnapshot(server.id, name);
  await hetzner.waitForAction(actionId);
  console.log('Snapshot ready.');

  console.log('Enabling protection on new snapshot...');
  await hetzner.changeImageProtection(imageId, true);

  if (oldSnapshots.length > 0) {
    console.log(`Disabling protection on ${oldSnapshots.length} older snapshot(s)...`);
    await Promise.all(oldSnapshots.map((s) => hetzner.changeImageProtection(s.id, false)));
  }

  console.log('Deleting server...');
  await hetzner.deleteServer(server.id);
  console.log('Done. Goodbye!');
}

async function ask(rl: ReturnType<typeof createInterface>, question: string, defaultValue?: string): Promise<string> {
  const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

async function init() {
  if (existsSync(CONFIG_PATH)) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const overwrite = await ask(rl, `Config already exists at ${CONFIG_PATH}. Overwrite? (y/N)`, 'N');
    rl.close();
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Aborted.');
      return;
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('\nHetzner credentials');
  console.log('-------------------');
  const hetznerToken = await ask(rl, 'Hetzner API token');

  console.log('\nServer settings');
  console.log('---------------');
  const serverName = await ask(rl, 'Server name', 'my-dev');
  const serverType = await ask(rl, 'Server type (see: hetzner.com/cloud)', 'cpx21');
  const location = await ask(rl, 'Location (nbg1, fsn1, hel1, ash, hil, sin)', 'fsn1');
  const snapshotPrefix = await ask(rl, 'Snapshot prefix', serverName);
  const sshKeysInput = await ask(rl, 'SSH key names (comma-separated, leave empty to skip)', '');
  const sshKeys = sshKeysInput ? sshKeysInput.split(',').map((s) => s.trim()).filter(Boolean) : [];

  console.log('\nCloudflare DNS (optional — press Enter to skip)');
  console.log('------------------------------------------------');
  const cloudflareToken = await ask(rl, 'Cloudflare API token (optional)');

  if (cloudflareToken) {
    const zoneId = await ask(rl, 'Cloudflare Zone ID');
    const recordName = await ask(rl, 'DNS record name (e.g. dev.example.com)');
    rl.close();
    writeConfig(hetznerToken, cloudflareToken, serverName, serverType, location, snapshotPrefix, sshKeys, zoneId, recordName);
  } else {
    rl.close();
    writeConfig(hetznerToken, undefined, serverName, serverType, location, snapshotPrefix, sshKeys);
  }
}

function writeConfig(
  hetznerToken: string,
  cloudflareToken: string | undefined,
  serverName: string,
  serverType: string,
  location: string,
  snapshotPrefix: string,
  sshKeys: string[],
  cfZoneId?: string,
  cfRecordName?: string,
) {
  const cfTokenLine = cloudflareToken ? `\n    cloudflare: "${cloudflareToken}",` : '';
  const cfBlock = cloudflareToken && cfZoneId && cfRecordName
    ? `\ncloudflare: {\n  zoneId: "${cfZoneId}",\n  recordName: "${cfRecordName}",\n},`
    : '';
  const sshKeysJson = JSON.stringify(sshKeys);

  const content = `{
  tokens: {
    hetzner: "${hetznerToken}",${cfTokenLine}
  },
  server: {
    name: "${serverName}",
    serverType: "${serverType}",
    location: "${location}",
    snapshotPrefix: "${snapshotPrefix}",
    sshKeys: ${sshKeysJson},
  },${cfBlock}
}
`;

  writeFileSync(CONFIG_PATH, content, { mode: 0o600 });
  console.log(`\nConfig written to ${CONFIG_PATH}`);
  console.log('File permissions set to 600 (owner read/write only).');
}

function completion() {
  process.stdout.write(`\
#compdef hetzsnap

_hetzsnap() {
  local state

  _arguments \\
    '1: :->command' \\
    '*: :->args'

  case $state in
    command)
      _values 'command' \\
        'start[Start the dev server from the latest snapshot]' \\
        'stop[Snapshot and delete the running server]' \\
        'status[Show whether the server is running and for how long]' \\
        'snapshots[List snapshots]' \\
        'init[Run the interactive setup wizard]' \\
        'completion[Print the zsh completion script]'
      ;;
    args)
      case $words[2] in
        snapshots)
          _values 'subcommand' 'cleanup[Delete all snapshots except the latest]'
          ;;
        snapshots\\ cleanup)
          _arguments '-y[Skip confirmation prompt]'
          ;;
      esac
      ;;
  esac
}

(( $+functions[compdef] )) && compdef _hetzsnap hetzsnap
`);
}

(async () => {
  try {
    if (command === 'start') {
      await start();
    } else if (command === 'stop') {
      await stop();
    } else if (command === 'status') {
      await status();
    } else if (command === 'snapshots') {
      const sub = process.argv[3];
      if (sub === 'cleanup') {
        const yes = process.argv.includes('-y');
        await snapshotsCleanup(yes);
      } else {
        await snapshots();
      }
    } else if (command === 'init') {
      await init();
    } else if (command === 'completion') {
      completion();
    } else {
      console.error('Usage: hetzsnap <start|stop|status|snapshots|init|completion>');
      process.exit(1);
    }
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      console.error(`Error: ${err.method.toUpperCase()} ${err.url} → ${err.status}: ${JSON.stringify(err.body)}`);
    } else {
      console.error('Error:', err instanceof Error ? err.message : String(err));
    }
    process.exit(1);
  }
})();
