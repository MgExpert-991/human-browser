#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initConfig, readConfig } from '../shared/config.ts';
import { HBError, asStructuredError } from '../shared/errors.ts';
import type { DaemonApiResponse, DaemonConfig, SnapshotOptions, StructuredError } from '../shared/types.ts';
import { startDaemon } from '../daemon/app.ts';

interface GlobalOptions {
  json: boolean;
  configPath?: string;
  timeoutMs: number;
  queueMode: 'hold' | 'fail';
}

interface Parsed {
  command: string;
  args: string[];
  options: GlobalOptions;
}

function parseGlobalArgs(argv: string[]): Parsed {
  const args = [...argv];
  let json = false;
  let configPath: string | undefined;
  let timeoutMs = 10000;
  let queueMode: 'hold' | 'fail' = 'hold';

  while (args.length > 0) {
    const token = args[0];
    if (!token || !token.startsWith('--')) {
      break;
    }

    args.shift();

    if (token === '--json') {
      json = true;
      continue;
    }

    if (token === '--config') {
      const value = args.shift();
      if (!value) {
        throw new HBError('BAD_REQUEST', '--config requires a path');
      }
      configPath = value;
      continue;
    }

    if (token === '--timeout') {
      const value = args.shift();
      if (!value) {
        throw new HBError('BAD_REQUEST', '--timeout requires milliseconds');
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new HBError('BAD_REQUEST', '--timeout must be a positive number');
      }
      timeoutMs = parsed;
      continue;
    }

    if (token === '--queue-mode') {
      const value = args.shift();
      if (value !== 'hold' && value !== 'fail') {
        throw new HBError('BAD_REQUEST', '--queue-mode must be hold or fail');
      }
      queueMode = value;
      continue;
    }

    throw new HBError('BAD_REQUEST', `Unknown option: ${token}`);
  }

  const command = args.shift() ?? 'help';

  return {
    command,
    args,
    options: {
      json,
      configPath,
      timeoutMs,
      queueMode,
    },
  };
}

async function main(): Promise<void> {
  const parsed = parseGlobalArgs(process.argv.slice(2));

  switch (parsed.command) {
    case 'help': {
      printHelp();
      return;
    }
    case 'ws': {
      await commandWs(parsed.args, parsed.options);
      return;
    }
    case 'init': {
      await commandInit(parsed.args, parsed.options);
      return;
    }
    case 'daemon': {
      await commandDaemon(parsed.options);
      return;
    }
    default: {
      await commandDaemonRpc(parsed.command, parsed.args, parsed.options);
    }
  }
}

async function commandInit(args: string[], options: GlobalOptions): Promise<void> {
  let host = '127.0.0.1';
  let port = 18765;
  let maxEvents = 500;
  let force = false;
  let showToken = false;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

    if (token === '--host') {
      const value = args[i + 1];
      if (!value) {
        throw new HBError('BAD_REQUEST', '--host requires a value');
      }
      host = value;
      i += 1;
      continue;
    }

    if (token === '--port') {
      const value = args[i + 1];
      if (!value) {
        throw new HBError('BAD_REQUEST', '--port requires a value');
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new HBError('BAD_REQUEST', '--port must be a positive number');
      }
      port = parsed;
      i += 1;
      continue;
    }

    if (token === '--max-events') {
      const value = args[i + 1];
      if (!value) {
        throw new HBError('BAD_REQUEST', '--max-events requires a value');
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new HBError('BAD_REQUEST', '--max-events must be a positive number');
      }
      maxEvents = parsed;
      i += 1;
      continue;
    }

    if (token === '--force') {
      force = true;
      continue;
    }

    if (token === '--show-token') {
      // Security default: never print secrets unless user explicitly opts in.
      showToken = true;
      continue;
    }

    throw new HBError('BAD_REQUEST', `Unknown init option: ${token}`);
  }

  const { path, config, alreadyExisted } = await initConfig({
    configPath: options.configPath,
    host,
    port,
    maxEvents,
    force,
  });

  const output = {
    config_path: path,
    replaced_existing: alreadyExisted,
    daemon_http_url: `http://${config.daemon.host}:${config.daemon.port}`,
    extension_ws_url: `ws://${config.daemon.host}:${config.daemon.port}/bridge`,
    token: showToken ? config.auth.token : '[hidden]',
    token_hidden: !showToken,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  process.stdout.write(`config_path: ${output.config_path}\n`);
  process.stdout.write(`daemon_http_url: ${output.daemon_http_url}\n`);
  process.stdout.write(`extension_ws_url: ${output.extension_ws_url}\n`);
  process.stdout.write(`token: ${output.token}\n`);
  if (output.token_hidden) {
    process.stdout.write('hint: use `human-browser init --show-token` to print token\n');
  }
}

async function commandDaemon(options: GlobalOptions): Promise<void> {
  const config = await readConfig(options.configPath);
  const daemon = await startDaemon(config);

  process.stdout.write(
    `[human-browser] daemon listening at http://${daemon.host}:${daemon.port} and ws://${daemon.host}:${daemon.port}/bridge\n`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`[human-browser] received ${signal}, shutting down\n`);
    await daemon.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await new Promise<void>(() => {
    // Keep process alive.
  });
}

async function commandWs(args: string[], options: GlobalOptions): Promise<void> {
  let showToken = false;

  for (const token of args) {
    if (token === '--show-token') {
      // Security default: avoid accidental token leaks in shell history / pasted logs.
      showToken = true;
      continue;
    }
    throw new HBError('BAD_REQUEST', `Unknown ws option: ${token}`);
  }

  const config = await readConfig(options.configPath);
  const data = {
    ws_url: `ws://${config.daemon.host}:${config.daemon.port}/bridge`,
    token: showToken ? config.auth.token : '[hidden]',
    token_hidden: !showToken,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  process.stdout.write(`ws_url: ${data.ws_url}\n`);
  process.stdout.write(`token: ${data.token}\n`);
  if (data.token_hidden) {
    process.stdout.write('hint: use `human-browser ws --show-token` to print token\n');
  }
}

async function commandDaemonRpc(command: string, args: string[], options: GlobalOptions): Promise<void> {
  const config = await readConfig(options.configPath);
  const request = toDaemonRequest(command, args);
  const data = await callDaemon(config, request.command, request.args, options);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  renderText(command, data);
}

export function toDaemonRequest(
  command: string,
  args: string[],
): {
  command: string;
  args: Record<string, unknown>;
} {
  switch (command) {
    case 'status':
    case 'tabs':
    case 'reconnect':
    case 'reset': {
      return { command, args: {} };
    }
    case 'use': {
      const target = args[0];
      if (!target) {
        throw new HBError('BAD_REQUEST', 'use requires <active|tab_id>');
      }
      return {
        command,
        args: {
          target: target === 'active' ? 'active' : Number(target),
        },
      };
    }
    case 'snapshot': {
      const parsed = parseSnapshotArgs(args);
      return {
        command,
        args: {
          target: parsed.target,
          ...parsed.options,
        },
      };
    }
    case 'click': {
      const selectorOrRef = args[0];
      if (!selectorOrRef) {
        throw new HBError('BAD_REQUEST', 'click requires <selector|@ref>');
      }
      const parsed = parseNamedFlags(args.slice(1), ['--snapshot']);
      const ref = parseRefArg(selectorOrRef);

      if (ref) {
        const snapshotId = parsed['--snapshot'];
        if (!snapshotId) {
          throw new HBError('BAD_REQUEST', 'click with ref requires --snapshot <snapshot_id>');
        }
        return {
          command,
          args: {
            ref,
            snapshot_id: snapshotId,
          },
        };
      }

      return {
        command,
        args: {
          selector: selectorOrRef,
        },
      };
    }
    case 'fill': {
      const selectorOrRef = args[0];
      const value = args[1];
      if (!selectorOrRef || value === undefined) {
        throw new HBError('BAD_REQUEST', 'fill requires <selector|@ref> <value>');
      }
      const parsed = parseNamedFlags(args.slice(2), ['--snapshot']);
      const ref = parseRefArg(selectorOrRef);

      if (ref) {
        const snapshotId = parsed['--snapshot'];
        if (!snapshotId) {
          throw new HBError('BAD_REQUEST', 'fill with ref requires --snapshot <snapshot_id>');
        }
        return {
          command,
          args: {
            ref,
            value,
            snapshot_id: snapshotId,
          },
        };
      }

      return {
        command,
        args: {
          selector: selectorOrRef,
          value,
        },
      };
    }
    case 'keypress': {
      const key = args[0];
      if (!key) {
        throw new HBError('BAD_REQUEST', 'keypress requires <key>');
      }
      const parsed = parseNamedFlags(args.slice(1), ['--tab']);
      return {
        command,
        args: {
          key,
          tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
        },
      };
    }
    case 'scroll': {
      const xRaw = args[0];
      const yRaw = args[1];
      if (xRaw === undefined || yRaw === undefined) {
        throw new HBError('BAD_REQUEST', 'scroll requires <x> <y>');
      }
      const x = Number(xRaw);
      const y = Number(yRaw);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new HBError('BAD_REQUEST', 'scroll values must be numeric');
      }
      const parsed = parseNamedFlags(args.slice(2), ['--tab']);
      return {
        command,
        args: {
          x,
          y,
          tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
        },
      };
    }
    case 'navigate': {
      const url = args[0];
      if (!url) {
        throw new HBError('BAD_REQUEST', 'navigate requires <url>');
      }
      const parsed = parseNamedFlags(args.slice(1), ['--tab']);
      return {
        command,
        args: {
          url,
          tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
        },
      };
    }
    case 'diagnose': {
      const parsed = parseNamedFlags(args, ['--limit']);
      const limit = parsed['--limit'];
      return {
        command,
        args: {
          limit: limit === undefined ? 50 : Number(limit),
        },
      };
    }
    default:
      throw new HBError('BAD_REQUEST', `Unknown command: ${command}`);
  }
}

function parseNamedFlags(args: string[], allowedFlags: string[]): Record<string, string> {
  const allowed = new Set(allowedFlags);
  const map: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!allowed.has(token)) {
      throw new HBError('BAD_REQUEST', `Unknown flag: ${token}`);
    }

    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new HBError('BAD_REQUEST', `Flag requires a value: ${token}`);
    }

    map[token] = value;
    i += 1;
  }

  return map;
}

function parseSnapshotArgs(args: string[]): { target?: number | 'active'; options: SnapshotOptions } {
  const options: SnapshotOptions = {};
  let target: number | 'active' | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

    if (token === '--interactive') {
      options.interactive = true;
      continue;
    }

    if (token === '--cursor') {
      options.cursor = true;
      continue;
    }

    if (token === '--compact') {
      options.compact = true;
      continue;
    }

    if (token === '--tab') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new HBError('BAD_REQUEST', 'Flag requires a value: --tab');
      }
      target = parseTab(value);
      i += 1;
      continue;
    }

    if (token === '--depth') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new HBError('BAD_REQUEST', 'Flag requires a value: --depth');
      }
      const depth = Number(value);
      if (!Number.isInteger(depth) || depth < 0) {
        throw new HBError('BAD_REQUEST', '--depth must be a non-negative integer');
      }
      options.depth = depth;
      i += 1;
      continue;
    }

    if (token === '--selector') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new HBError('BAD_REQUEST', 'Flag requires a value: --selector');
      }
      options.selector = value;
      i += 1;
      continue;
    }

    throw new HBError('BAD_REQUEST', `Unknown flag: ${token}`);
  }

  return { target, options };
}

function parseTab(raw: string): number | 'active' {
  if (raw === 'active') {
    return 'active';
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    throw new HBError('BAD_REQUEST', `tab must be numeric or active: ${raw}`);
  }

  return numeric;
}

function parseRefArg(raw: string): string | null {
  if (/^@e\d+$/.test(raw)) {
    return raw.slice(1);
  }

  if (/^ref=e\d+$/.test(raw)) {
    return raw.slice(4);
  }

  if (/^e\d+$/.test(raw)) {
    return raw;
  }

  return null;
}

async function callDaemon(
  config: DaemonConfig,
  command: string,
  args: Record<string, unknown>,
  options: GlobalOptions,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`http://${config.daemon.host}:${config.daemon.port}/v1/command`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hb-token': config.auth.token,
      },
      body: JSON.stringify({
        command,
        args,
        queue_mode: options.queueMode,
        timeout_ms: options.timeoutMs,
      }),
    });
  } catch (error) {
    throw new HBError(
      'DISCONNECTED',
      'Daemon is not reachable',
      {
        daemon_http_url: `http://${config.daemon.host}:${config.daemon.port}`,
        cause: error instanceof Error ? error.message : String(error),
      },
      {
        next_command: 'human-browser daemon',
      },
    );
  }

  let payload: DaemonApiResponse;
  try {
    payload = (await response.json()) as DaemonApiResponse;
  } catch {
    throw new HBError('INTERNAL', 'Daemon returned invalid JSON');
  }

  if (!payload.ok) {
    throw new HBError(payload.error.code, payload.error.message, payload.error.details, payload.error.recovery);
  }

  return payload.data as Record<string, unknown>;
}

function renderText(command: string, data: Record<string, unknown>): void {
  switch (command) {
    case 'snapshot': {
      process.stdout.write(`snapshot_id=${String(data.snapshot_id)} tab_id=${String(data.tab_id)}\n`);
      process.stdout.write(`${String(data.tree)}\n`);
      return;
    }
    case 'status':
    case 'diagnose': {
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      return;
    }
    default: {
      process.stdout.write(`${JSON.stringify(data)}\n`);
    }
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      'human-browser CLI',
      '',
      'Usage:',
      '  human-browser [--json] [--config <path>] [--timeout <ms>] [--queue-mode hold|fail] <command> [args]',
      '',
      'Commands:',
      '  ws [--show-token]',
      '  init [--host 127.0.0.1] [--port 18765] [--max-events 500] [--force] [--show-token]',
      '  daemon',
      '  status',
      '  tabs',
      '  use <active|tab_id>',
      '  snapshot [--tab <active|tab_id>] [--interactive] [--cursor] [--compact] [--depth <N>] [--selector <css>]',
      '  click <selector|@ref> [--snapshot <snapshot_id>]',
      '  fill <selector|@ref> <value> [--snapshot <snapshot_id>]',
      '  keypress <key> [--tab <active|tab_id>]',
      '  scroll <x> <y> [--tab <active|tab_id>]',
      '  navigate <url> [--tab <active|tab_id>]',
      '  reconnect',
      '  reset',
      '  diagnose [--limit <N>]',
      '',
    ].join('\n'),
  );
}

try {
  if (isCliEntryPoint()) {
    await main();
  }
} catch (error) {
  if (isCliEntryPoint()) {
    const structured = asStructuredError(error) as StructuredError;
    process.stderr.write(`${JSON.stringify({ ok: false, error: structured }, null, 2)}\n`);
    process.exit(1);
  }
  throw error;
}

function isCliEntryPoint(): boolean {
  const argvEntry = process.argv[1];
  if (!argvEntry) {
    return false;
  }
  try {
    const currentPath = realpathSync(fileURLToPath(import.meta.url));
    const invokedPath = realpathSync(argvEntry);
    return currentPath === invokedPath;
  } catch {
    return import.meta.url === pathToFileURL(argvEntry).href;
  }
}
