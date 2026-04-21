import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import JSON5 from 'json5';

export interface hetzsnapConfig {
  tokens: {
    hetzner: string;
    cloudflare?: string;
  };
  server: {
    name: string;
    serverType: string;
    location: string;
    snapshotPrefix: string;
    sshKeys: string[];
    baseImage?: string; // used when no snapshot exists yet, defaults to ubuntu-24.04
  };
  cloudflare?: {
    zoneId: string;
    recordName: string;
  };
}

export const CONFIG_PATH = join(homedir(), '.hetzsnap.json5');

export function loadConfig(): hetzsnapConfig {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`Config file not found: ${CONFIG_PATH}`);
    console.error('Run "hetzsnap init" to create it.');
    process.exit(1);
  }

  let raw: unknown;
  try {
    raw = JSON5.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    console.error(`Failed to parse config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const config = raw as hetzsnapConfig;

  if (!config.tokens?.hetzner) {
    console.error('Config is missing tokens.hetzner');
    process.exit(1);
  }
  if (!config.server?.name) {
    console.error('Config is missing server.name');
    process.exit(1);
  }

  return config;
}
