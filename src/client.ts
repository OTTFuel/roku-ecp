/**
 * ECP (External Control Protocol) client for Roku devices.
 *
 * Typed API over Roku's HTTP-based ECP on port 8060.
 */

import { XMLParser } from 'fast-xml-parser';
import { createConnection } from 'net';
import { readFile, stat, readdir, access } from 'fs/promises';
import { createHash } from 'crypto';
import { join, relative } from 'path';
import { ZipFile } from 'yazl';
import { EcpHttpError, EcpTimeoutError, EcpAuthError } from './errors.js';
import { digestGet, digestUpload } from './digest.js';
import { ssdpDiscover, ssdpDiscoverAll } from './ssdp.js';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface DeviceInfo {
  // Identity
  udn: string;
  serialNumber: string;
  deviceId: string;
  modelName: string;
  modelNumber: string;
  modelRegion: string;
  vendorName: string;
  friendlyDeviceName: string;
  friendlyModelName: string;
  userDeviceName: string;
  userDeviceLocation: string;

  // Software
  softwareVersion: string;
  softwareBuild: string;
  buildNumber: string;

  // Network
  networkType: string;
  networkName: string;
  wifiMac: string;
  ethernetMac: string;
  supportsEthernet: boolean;
  hasWifi5GSupport: boolean;
  hasWifiExtender: boolean;

  // Display
  uiResolution: string;
  isTv: boolean;
  isStick: boolean;

  // Locale
  language: string;
  country: string;
  locale: string;
  timeZone: string;
  timeZoneOffset: string;

  // Power
  powerMode: string;
  supportsSuspend: boolean;

  // Features
  developerEnabled: boolean;
  keyedDeveloperId: string;
  searchEnabled: boolean;
  voiceSearchEnabled: boolean;
  notificationsEnabled: boolean;
  notificationsFirstUse: boolean;
  supportsPrivateListening: boolean;
  headphonesConnected: boolean;
  supportsFindRemote: boolean;
  supportsAudioGuide: boolean;
  secureDevice: boolean;

  /** Additional fields vary by device model and firmware. */
  [key: string]: string | boolean;
}

export interface ActiveApp {
  id: string;
  type: string;
  version: string;
  name: string;
}

export type PlayerState = 'play' | 'pause' | 'buffering' | 'stopped' | 'error' | 'finished' | 'idle' | 'open' | 'startup' | 'none';

export interface MediaPlayerState {
  state: PlayerState;
  error: boolean;
  plugin?: {
    id: string;
    name: string;
    bandwidth: string;
  };
  format?: {
    audio: string;
    video: string;
    captions: string;
    drm: string;
  };
  /** Playback position in milliseconds. */
  position?: number;
  /** Content duration in milliseconds. */
  duration?: number;
  isLive?: boolean;
}

export interface InstalledApp {
  id: string;
  type: string;
  version: string;
  name: string;
}

export interface ChanperfSample {
  cpuUser: number;
  cpuSystem: number;
  memAnon: number;
  memFile: number;
}

/* ------------------------------------------------------------------ */
/*  Keys                                                              */
/* ------------------------------------------------------------------ */

export const Key = {
  Home: 'Home',
  Rev: 'Rev',
  Fwd: 'Fwd',
  Play: 'Play',
  Select: 'Select',
  Left: 'Left',
  Right: 'Right',
  Down: 'Down',
  Up: 'Up',
  Back: 'Back',
  InstantReplay: 'InstantReplay',
  Info: 'Info',
  Backspace: 'Backspace',
  Search: 'Search',
  Enter: 'Enter',
  VolumeDown: 'VolumeDown',
  VolumeMute: 'VolumeMute',
  VolumeUp: 'VolumeUp',
  PowerOff: 'PowerOff',
  PowerOn: 'PowerOn',
  InputTuner: 'InputTuner',
  InputHDMI1: 'InputHDMI1',
  InputHDMI2: 'InputHDMI2',
  InputHDMI3: 'InputHDMI3',
  InputHDMI4: 'InputHDMI4',
  InputAV1: 'InputAV1',
} as const;

export type KeyName = (typeof Key)[keyof typeof Key];

/* ------------------------------------------------------------------ */
/*  Client options                                                     */
/* ------------------------------------------------------------------ */

export interface EcpClientOptions {
  /** Port for ECP HTTP API. Default 8060. */
  port?: number;
  /** Developer password for sideload/screenshot. Default "rokudev". */
  devPassword?: string;
  /** Request timeout in ms. Default 10000. */
  timeout?: number;
  /** Minimum delay between key presses in ms. Default 0. */
  keyCooldown?: number;
  /** Minimum delay between web server requests in ms. Default 0. */
  webCooldown?: number;
  /** Number of retries for transient HTTP errors (503, etc). Default 0. */
  retries?: number;
  /** Delay between retries in ms. Default 500. */
  retryDelay?: number;
}

export interface TouchEvent {
  x: number;
  y: number;
  /** Touch operation: 'down', 'up', 'press', or 'move'. Default 'press'. */
  op?: 'down' | 'up' | 'press' | 'move';
}

/* ------------------------------------------------------------------ */
/*  XML parsers                                                        */
/* ------------------------------------------------------------------ */

const flatParser = new XMLParser({
  ignoreAttributes: true,
});

const attrParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

/* ------------------------------------------------------------------ */
/*  Errors                                                            */
/* ------------------------------------------------------------------ */

export class EcpSideloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcpSideloadError';
  }
}

export class EcpScreenshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcpScreenshotError';
  }
}

/* ------------------------------------------------------------------ */
/*  Client                                                            */
/* ------------------------------------------------------------------ */

export class EcpClient {
  readonly baseUrl: string;
  private devPassword: string;
  private timeout: number;
  private keyCooldown: number;
  private webCooldown: number;
  private retries: number;
  private retryDelay: number;
  private lastKeyTime = 0;
  private lastWebTime = 0;
  private lastSideloadHash: string | undefined;

  constructor(readonly deviceIp: string, options?: EcpClientOptions) {
    const port = options?.port ?? 8060;
    this.baseUrl = `http://${deviceIp}:${port}`;
    this.devPassword = options?.devPassword ?? 'rokudev';
    this.timeout = options?.timeout ?? 10000;
    this.keyCooldown = options?.keyCooldown ?? 0;
    this.webCooldown = options?.webCooldown ?? 0;
    this.retries = options?.retries ?? 0;
    this.retryDelay = options?.retryDelay ?? 500;
  }

  /* ---- Key input ---- */

  async keypress(key: KeyName | string): Promise<void> {
    await this.enforceKeyCooldown();
    await this.post(`/keypress/${key}`);
  }

  async keydown(key: KeyName | string): Promise<void> {
    await this.enforceKeyCooldown();
    await this.post(`/keydown/${key}`);

  }

  async keyup(key: KeyName | string): Promise<void> {
    await this.enforceKeyCooldown();
    await this.post(`/keyup/${key}`);

  }

  async press(
    key: KeyName | string,
    options?: { times?: number; delay?: number }
  ): Promise<void> {
    const times = options?.times ?? 1;
    const delay = options?.delay ?? 100;
    for (let i = 0; i < times; i++) {
      await this.keypress(key);
      if (i < times - 1 && delay > 0) {
        await sleep(delay);
      }
    }
  }

  async type(text: string, options?: { delay?: number }): Promise<void> {
    const delay = options?.delay ?? 50;
    for (const char of text) {
      await this.keypress(`Lit_${encodeURIComponent(char)}`);
      if (delay > 0) await sleep(delay);
    }
  }

  async clearText(count: number, options?: { delay?: number }): Promise<void> {
    await this.press('Backspace', { times: count, delay: options?.delay ?? 50 });
  }

  /* ---- App lifecycle ---- */

  async launch(
    channelId: string,
    params?: Record<string, string>
  ): Promise<void> {
    const qs = params
      ? '?' + new URLSearchParams(params).toString()
      : '';
    await this.post(`/launch/${channelId}${qs}`);

  }

  async install(channelId: string): Promise<void> {
    await this.post(`/install/${channelId}`);
  }

  async input(params: Record<string, string>): Promise<void> {
    const qs = new URLSearchParams(params).toString();
    await this.post(`/input?${qs}`);
  }

  async touch(event: TouchEvent): Promise<void> {
    await this.input({
      'touch.0.x': String(event.x),
      'touch.0.y': String(event.y),
      'touch.0.op': event.op ?? 'press',
    });
  }

  async closeApp(): Promise<void> {
    await this.keypress('Home');
  }

  async deepLink(
    channelId: string,
    contentId: string,
    mediaType?: string
  ): Promise<void> {
    const params: Record<string, string> = { contentId };
    if (mediaType) params.mediaType = mediaType;
    await this.launch(channelId, params);
  }

  /* ---- Sideload ---- */

  async sideload(pathOrDir: string, options?: { force?: boolean }): Promise<string> {
    const info = await stat(pathOrDir);
    let fileData: Buffer;

    if (info.isDirectory()) {
      fileData = await zipDirectory(pathOrDir);
    } else {
      fileData = await readFile(pathOrDir);
    }

    // Skip if build hasn't changed
    if (!options?.force) {
      const hash = createHash('md5').update(fileData).digest('hex');
      if (hash === this.lastSideloadHash) {
        return 'Sideload skipped — build unchanged';
      }
      this.lastSideloadHash = hash;
    }

    const html = await digestUpload(
      `http://${this.deviceIp}/plugin_install`,
      'rokudev',
      this.devPassword,
      { mysubmit: 'Install' },
      { archive: { filename: 'sideload.zip', data: fileData } },
    );

    if (html.includes('Install Success')) return 'Install Success';
    if (html.includes('Install Failure')) {
      throw new EcpSideloadError('Sideload failed — check the package');
    }
    return 'Sideload completed';
  }

  /* ---- Console / Debug (port 8085) ---- */

  async readConsole(options?: {
    duration?: number;
    filter?: string;
  }): Promise<string> {
    const duration = options?.duration ?? 2000;
    const output = await tcpRead(this.deviceIp, 8085, '\n', duration);
    if (!options?.filter) return output;
    return output
      .split('\n')
      .filter((line) =>
        line.toLowerCase().includes(options.filter!.toLowerCase())
      )
      .join('\n');
  }

  async sendConsoleCommand(
    command: string,
    options?: { duration?: number }
  ): Promise<string> {
    const duration = options?.duration ?? 2000;
    return tcpRead(this.deviceIp, 8085, command + '\n', duration);
  }

  /* ---- Queries ---- */

  async queryDeviceInfo(): Promise<DeviceInfo> {
    const xml = await this.get('/query/device-info');
    const parsed = flatParser.parse(xml);
    const raw = parsed['device-info'];
    const info: Record<string, string | boolean> = {};
    for (const [key, value] of Object.entries(raw)) {
      const v = String(value);
      if (v === 'true') info[toCamelCase(key)] = true;
      else if (v === 'false') info[toCamelCase(key)] = false;
      else info[toCamelCase(key)] = v;
    }
    return info as unknown as DeviceInfo;
  }

  async queryActiveApp(): Promise<ActiveApp> {
    const xml = await this.get('/query/active-app');
    const parsed = attrParser.parse(xml);
    const app = parsed['active-app']?.app;
    if (!app || typeof app === 'string') {
      return { id: '', type: 'home', version: '', name: app ?? 'Roku' };
    }
    return {
      id: String(app['@_id'] ?? ''),
      type: String(app['@_type'] ?? 'home'),
      version: String(app['@_version'] ?? ''),
      name: String(app['#text'] ?? 'Roku'),
    };
  }

  async queryInstalledApps(): Promise<InstalledApp[]> {
    const xml = await this.get('/query/apps');
    const parsed = attrParser.parse(xml);
    const apps = parsed.apps?.app;
    if (!apps) return [];
    const list = Array.isArray(apps) ? apps : [apps];
    return list.map((app: Record<string, unknown>) => ({
      id: String(app['@_id']),
      type: String(app['@_type']),
      version: String(app['@_version']),
      name: String(app['#text']),
    }));
  }

  async queryMediaPlayer(): Promise<MediaPlayerState> {
    const xml = await this.get('/query/media-player');
    const parsed = attrParser.parse(xml);
    const player = parsed.player;
    const plugin = player?.plugin;
    const format = player?.format;
    return {
      state: String(player['@_state'] ?? 'none') as PlayerState,
      error: player['@_error'] === 'true',
      plugin: plugin
        ? {
            id: String(plugin['@_id']),
            name: String(plugin['@_name']),
            bandwidth: String(plugin['@_bandwidth']),
          }
        : undefined,
      format: format
        ? {
            audio: String(format['@_audio']),
            video: String(format['@_video']),
            captions: String(format['@_captions']),
            drm: String(format['@_drm']),
          }
        : undefined,
      position: player.position ? parseInt(String(player.position), 10) : undefined,
      duration: player.duration ? parseInt(String(player.duration), 10) : undefined,
      isLive: (() => {
        const v = player.is_live?.['#text'] ?? player.is_live;
        if (v === true || v === 'true') return true;
        if (v === false || v === 'false') return false;
        return undefined;
      })(),
    };
  }

  async queryAppUi(): Promise<string> {
    return this.get('/query/app-ui');
  }

  async queryChanperf(): Promise<ChanperfSample> {
    const xml = await this.get('/query/chanperf');
    const parsed = flatParser.parse(xml);
    const plugin = parsed.chanperf?.plugin;
    if (!plugin) {
      return { cpuUser: 0, cpuSystem: 0, memAnon: 0, memFile: 0 };
    }
    const cpu = plugin['cpu-percent'] ?? {};
    const mem = plugin.memory ?? {};
    return {
      cpuUser: parseFloat(cpu.user ?? '0'),
      cpuSystem: parseFloat(cpu.sys ?? '0'),
      memAnon: parseInt(String(mem.anon ?? '0'), 10),
      memFile: parseInt(String(mem.file ?? '0'), 10),
    };
  }

  /* ---- SceneGraph debug ---- */

  async querySGNodesAll(): Promise<string> {
    return this.get('/query/sgnodes/all');
  }

  async querySGNodesRoots(): Promise<string> {
    return this.get('/query/sgnodes/roots');
  }

  async querySGNodesNodes(nodeId: string): Promise<string> {
    return this.get(`/query/sgnodes/nodes/${nodeId}`);
  }

  /* ---- Performance debug ---- */

  async queryGraphicsFrameRate(): Promise<string> {
    return this.get('/query/graphics-frame-rate');
  }

  async queryAppObjectCounts(): Promise<string> {
    return this.get('/query/r2d2-bitmaps');
  }

  /* ---- Rendezvous tracking ---- */

  async trackSGRendezvous(): Promise<void> {
    await this.post('/sgrendezvous/track');
  }

  async untrackSGRendezvous(): Promise<void> {
    await this.post('/sgrendezvous/untrack');
  }

  async querySGRendezvous(): Promise<string> {
    return this.get('/query/sgrendezvous');
  }

  /* ---- App state ---- */

  async queryAppState(): Promise<string> {
    return this.get('/query/app-state');
  }

  /* ---- Screenshot ---- */

  async takeScreenshot(): Promise<Buffer> {
    const devUrl = `http://${this.deviceIp}`;

    const response = await digestUpload(
      `${devUrl}/plugin_inspect`,
      'rokudev',
      this.devPassword,
      { mysubmit: 'Screenshot' },
      {},
    );

    // Prefer the image named by this capture, rather than a possibly stale
    // image left behind under the other extension. Only accept known local
    // screenshot paths; never follow a host supplied in the response.
    const match = response.match(
      /(?:src|href)\s*=\s*["'](?:https?:\/\/[^/"']+)?(\/?pkgs\/dev\.(?:png|jpe?g)(?:\?[^"'<>]*)?)["']/i,
    );
    const reportedPath = match?.[1].replace(/&amp;/g, '&');
    const candidates = reportedPath
      ? [reportedPath.startsWith('/') ? reportedPath : `/${reportedPath}`]
      : ['/pkgs/dev.png', '/pkgs/dev.jpg'];

    for (const [index, candidate] of candidates.entries()) {
      const url = new URL(candidate, devUrl);
      url.searchParams.set('time', String(Date.now()));
      let image: Buffer;

      try {
        image = await digestGet(url.href, 'rokudev', this.devPassword);
      } catch (error) {
        if (error instanceof EcpAuthError && error.status === 404
          && index < candidates.length - 1) {
          continue;
        }
        throw error;
      }

      const isPng = image.subarray(0, 8).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      const isJpeg = image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
      if (!isPng && !isJpeg) {
        throw new EcpScreenshotError('Screenshot response is not a PNG or JPEG image');
      }
      return image;
    }

    throw new EcpScreenshotError('Screenshot failed — is a dev channel sideloaded?');
  }

  /* ---- SSDP Discovery ---- */

  static async discover(options?: { timeout?: number }): Promise<EcpClient> {
    return ssdpDiscover((ip, opts) => new EcpClient(ip, opts), options);
  }

  static async discoverAll(options?: { timeout?: number }): Promise<EcpClient[]> {
    return ssdpDiscoverAll((ip, opts) => new EcpClient(ip, opts), options);
  }

  /* ---- Cooldown ---- */

  private async enforceKeyCooldown(): Promise<void> {
    if (this.keyCooldown > 0) {
      const elapsed = Date.now() - this.lastKeyTime;
      if (elapsed < this.keyCooldown) {
        await sleep(this.keyCooldown - elapsed);
      }
      this.lastKeyTime = Date.now();
    }
  }

  private async enforceWebCooldown(): Promise<void> {
    if (this.webCooldown > 0) {
      const elapsed = Date.now() - this.lastWebTime;
      if (elapsed < this.webCooldown) {
        await sleep(this.webCooldown - elapsed);
      }
      this.lastWebTime = Date.now();
    }
  }

  /** Check if the device is reachable. Returns true/false, never throws. */
  async ping(timeoutMs = 3000): Promise<boolean> {
    try {
      await fetch(`${this.baseUrl}/`, {
        headers: { Connection: 'close' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return true;
    } catch {
      return false;
    }
  }

  /* ---- HTTP helpers ---- */

  private async get(path: string): Promise<string> {
    return this.requestWithRetry('GET', path) as Promise<string>;
  }

  private async post(path: string): Promise<void> {
    await this.requestWithRetry('POST', path);
  }

  private async requestWithRetry(method: 'GET' | 'POST', path: string, attempt = 0): Promise<string | void> {
    await this.enforceWebCooldown();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Connection: 'close' },
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        if (attempt < this.retries) {
          await sleep(this.retryDelay);
          return this.requestWithRetry(method, path, attempt + 1);
        }
        throw new EcpTimeoutError(`ECP ${method} ${path} timed out after ${this.timeout}ms`, this.timeout);
      }
      throw err;
    }
    if (!res.ok) {
      if (attempt < this.retries && res.status >= 500) {
        await sleep(this.retryDelay);
        return this.requestWithRetry(method, path, attempt + 1);
      }
      throw new EcpHttpError(method, path, res.status, res.statusText);
    }
    if (method === 'GET') return res.text();
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toCamelCase(str: string): string {
  return str.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function tcpRead(host: string, port: number, input: string, duration: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host, port }, () => {
      socket.write(input);
    });

    const timer = setTimeout(() => {
      socket.destroy();
      resolve(Buffer.concat(chunks).toString('utf-8'));
    }, duration);

    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      if (chunks.length > 0) {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      } else {
        reject(err);
      }
    });
  });
}

/* ---- Zip helper ---- */

const DEFAULT_IGNORES = new Set(['.git', 'node_modules', '.DS_Store', '.env', '.roku-dev-ignore', '.rokudevignore']);

async function loadIgnorePatterns(dir: string): Promise<Set<string>> {
  const patterns = new Set(DEFAULT_IGNORES);
  for (const name of ['.rokudevignore', '.roku-dev-ignore']) {
    try {
      await access(join(dir, name));
      const content = await readFile(join(dir, name), 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          patterns.add(trimmed);
        }
      }
      break;
    } catch { /* file doesn't exist */ }
  }
  return patterns;
}

async function zipDirectory(dir: string): Promise<Buffer> {
  const ignores = await loadIgnorePatterns(dir);
  const zipfile = new ZipFile();
  await addDirToZip(zipfile, dir, dir, ignores);
  zipfile.end();

  const chunks: Buffer[] = [];
  for await (const chunk of zipfile.outputStream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function addDirToZip(zipfile: ZipFile, baseDir: string, currentDir: string, ignores: Set<string>): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (ignores.has(entry.name)) continue;
    const fullPath = join(currentDir, entry.name);
    const archivePath = relative(baseDir, fullPath);
    if (entry.isDirectory()) {
      await addDirToZip(zipfile, baseDir, fullPath, ignores);
    } else {
      zipfile.addFile(fullPath, archivePath);
    }
  }
}
