# roku-ecp

[![npm version](https://img.shields.io/npm/v/@danecodes/roku-ecp)](https://www.npmjs.com/package/@danecodes/roku-ecp)
[![CI](https://github.com/danecodes/roku-ecp/actions/workflows/ci.yml/badge.svg)](https://github.com/danecodes/roku-ecp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

TypeScript client for the Roku [External Control Protocol (ECP)](https://developer.roku.com/docs/developer-program/dev-tools/external-control-api.md). Companion to [@danecodes/roku-mcp](https://github.com/danecodes/roku-mcp).

HTTP to port 8060. No WebDriver, no Appium, no Selenium, no Java, no native deps.

## Install

```bash
npm install @danecodes/roku-ecp
```

## Quick start

```typescript
import { EcpClient, Key, parseUiXml, findElement, findFocused } from '@danecodes/roku-ecp';

// Connect by IP
const roku = new EcpClient('192.168.0.30');

// Or discover on the network
// const roku = await EcpClient.discover();
// const allDevices = await EcpClient.discoverAll();

// Send remote control input
await roku.press(Key.Down, { times: 3 });
await roku.press(Key.Select);

// Type into a search field
await roku.type('one piece');

// Inspect the SceneGraph UI tree
const xml = await roku.queryAppUi();
const tree = parseUiXml(xml);
const button = findElement(tree, 'AppButton#play_button');
console.log(button?.attrs.text); // "Play"

// Check what's focused
const focused = findFocused(tree);
console.log(focused?.tag, focused?.attrs.name);

// Query device state
const info = await roku.queryDeviceInfo();
const app = await roku.queryActiveApp();
const player = await roku.queryMediaPlayer();
const apps = await roku.queryInstalledApps();
```

## API

### `EcpClient.discover(options?)`

Finds Rokus on the local network via SSDP.

```typescript
const roku = await EcpClient.discover();                    // 5s timeout
const roku = await EcpClient.discover({ timeout: 10000 });  // custom timeout
const all = await EcpClient.discoverAll();                   // find all devices
```

### `new EcpClient(ip, options?)`

| Option | Default | Description |
|--------|---------|-------------|
| `port` | `8060` | ECP HTTP port |
| `devPassword` | `"rokudev"` | Developer password for sideload/screenshot |
| `timeout` | `10000` | Request timeout in ms |
| `keyCooldown` | `0` | Min delay between key presses in ms |
| `webCooldown` | `0` | Min delay between web server requests in ms |

### Key input

```typescript
await roku.keypress(Key.Select);           // single press
await roku.keydown(Key.Right);             // key down
await roku.keyup(Key.Right);               // key up
await roku.press(Key.Down, { times: 5, delay: 100 }); // repeated press
await roku.type('search text', { delay: 50 });        // character-by-character
```

The `Key` object has all standard Roku keys: `Home`, `Back`, `Select`, `Up`, `Down`, `Left`, `Right`, `Play`, `Rev`, `Fwd`, `Info`, `Search`, `Enter`, `Backspace`, `InstantReplay`, `VolumeUp`, `VolumeDown`, `VolumeMute`, `PowerOn`, `PowerOff`, `InputHDMI1`-`4`, `InputAV1`, `InputTuner`.

### Touch input

```typescript
await roku.touch({ x: 100, y: 200 });                    // tap at coordinates
await roku.touch({ x: 100, y: 200, op: 'down' });       // touch down
await roku.touch({ x: 150, y: 250, op: 'move' });       // drag
await roku.touch({ x: 150, y: 250, op: 'up' });         // release
```

Coordinate origin is bottom-left. Operations: `'press'` (default), `'down'`, `'up'`, `'move'`.

### App lifecycle

```typescript
await roku.launch('12345');                              // launch by channel ID
await roku.launch('dev', { contentId: 'abc', mediaType: 'episode' }); // with params
await roku.deepLink('dev', 'abc', 'episode');            // shorthand
await roku.install('12345');                             // install from store
await roku.input({ key: 'value' });                      // send input params
await roku.closeApp();                                   // press Home
```

### Queries

```typescript
const info = await roku.queryDeviceInfo();       // DeviceInfo
const app = await roku.queryActiveApp();         // ActiveApp
const apps = await roku.queryInstalledApps();    // InstalledApp[]
const player = await roku.queryMediaPlayer();    // MediaPlayerState
const xml = await roku.queryAppUi();             // raw XML string
const perf = await roku.queryChanperf();         // ChanperfSample
```

### Sideload and screenshot

```typescript
await roku.sideload('./build.zip');              // deploy dev channel (zip file)
await roku.sideload('./my-roku-app');            // deploy dev channel (directory)
const image = await roku.takeScreenshot();       // PNG or JPEG Buffer
```

Both require developer mode. Digest auth uses the configured `devPassword`.

### Debug console (port 8085)

```typescript
const output = await roku.readConsole({ duration: 3000, filter: 'error' });
const response = await roku.sendConsoleCommand('bt'); // backtrace
```

## UI tree

Parse the SceneGraph XML and query with CSS selectors:

```typescript
import { parseUiXml, findElement, findElements, findFocused, formatTree } from '@danecodes/roku-ecp';

const tree = parseUiXml(await roku.queryAppUi());

// Basic selectors
findElement(tree, 'AppButton#play');                    // tag#name
findElement(tree, '#titleLabel');                        // name only
findElement(tree, '*');                                  // universal (all nodes)

// Combinators
findElement(tree, 'HomePage BannerWidget');              // descendant
findElement(tree, 'LayoutGroup > AppLabel');             // direct child
findElement(tree, 'ContentRow + ContentRow');            // adjacent sibling
findElement(tree, 'NavMenu ~ LayoutGroup');              // general sibling (all following)
findElements(tree, 'PosterCard, ThumbnailCard');         // comma groups (union)

// Attributes
findElement(tree, '[focused="true"]');                   // exact value
findElement(tree, '[visible]');                          // existence
findElement(tree, '[text*="Log"]');                      // substring (contains)
findElement(tree, '[text^="Episode"]');                  // starts with
findElement(tree, '[uri$=".png"]');                      // ends with
findElement(tree, 'AppButton#play[focused="true"]');     // combined

// Pseudo-classes
findElement(tree, 'AppButton:nth-child(1)');             // nth-child (number)
findElements(tree, 'AppButton:nth-child(odd)');          // nth-child (odd/even)
findElements(tree, 'AppButton:nth-child(2n+1)');         // nth-child (formula)
findElement(tree, 'AppButton:first-child');              // first child
findElement(tree, 'AppButton:last-child');               // last child
findElement(tree, 'AppButton:only-child');               // sole child
findElement(tree, 'LayoutGroup:empty');                  // no children
findElement(tree, 'AppButton:not([focused="true"])');     // negation
findElement(tree, 'AppButton:has(AppLabel[text="Log Out"])'); // has matching descendant

findElements(tree, 'AppButton');  // all matches
findFocused(tree);                // deepest focused node (leaf of focus chain)

console.log(formatTree(tree, { maxDepth: 3 }));
```

Both single and double quotes work in attribute values: `[text="hello"]` and `[text='hello']`.

### `UiNode`

```typescript
interface UiNode {
  tag: string;                        // SceneGraph component name
  name?: string;                      // name or id attribute
  attrs: Record<string, string>;      // all XML attributes
  children: UiNode[];
  parent?: UiNode;
}
```

### `getRect(node)`

Computes absolute screen position by walking parent translations. Roku's `bounds` attribute is local to the parent container, so raw bounds are wrong for any node inside a translated container.

```typescript
import { getRect } from '@danecodes/roku-ecp';

const rect = getRect(node); // { x, y, width, height } or undefined
```

Accumulates each parent's `translation` offset. Stops at `inheritParentTransform="false"`. Returns `undefined` if the node has no bounds or is null/undefined.

## Wait helpers

Poll the device until a condition is met:

```typescript
import {
  waitFor, waitForElement, waitForFocus, waitForApp, waitForText, waitForStable,
} from '@danecodes/roku-ecp';

const getTree = async () => parseUiXml(await roku.queryAppUi());

// Wait for an element to appear
const el = await waitForElement(getTree, '#loginBtn');

// Wait for a specific element to gain focus
await waitForFocus(getTree, 'AppButton#play');

// Wait for any element to be focused (no selector)
const focused = await waitForFocus(getTree);

// Wait for an app to become active
await waitForApp(roku, '12345');

// Wait for text content to appear
await waitForText(getTree, '#title', 'Now Playing');

// Wait for UI to stabilize after animation (e.g. after a key press)
await roku.keypress(Key.Down);
await waitForStable(getTree, { interval: 150, timeout: 3000 });

// Generic: poll any custom condition
const state = await waitFor(async () => {
  const p = await roku.queryMediaPlayer();
  return p.state === 'play' ? p : undefined;
}, { timeout: 5000, label: 'waitForPlayback' });
```

| Option | Default | Description |
|--------|---------|-------------|
| `timeout` | `10000` | Max wait in ms (`waitForStable` defaults to `3000`) |
| `interval` | `200` | Poll interval in ms (`waitForStable` defaults to `150`) |

Transient errors (`EcpTimeoutError`, `EcpHttpError`) during polling are swallowed and retried until the deadline. Everything else throws immediately.

## Typed errors

```typescript
import { EcpHttpError, EcpTimeoutError, EcpAuthError, EcpSideloadError, EcpScreenshotError } from '@danecodes/roku-ecp';

try {
  await roku.queryDeviceInfo();
} catch (err) {
  if (err instanceof EcpTimeoutError) // device unreachable
  if (err instanceof EcpHttpError)    // non-ok HTTP status { method, path, status, statusText }
  if (err instanceof EcpAuthError)    // digest auth failure { status }
}
```

## Console and log parsing

Log parsing comes from [@danecodes/roku-log](https://github.com/danecodes/roku-log), re-exported here. Quick error scan:

```typescript
import { parseConsoleForIssues } from '@danecodes/roku-ecp';

const output = await roku.readConsole({ duration: 5000 });
const { errors, crashes, exceptions } = parseConsoleForIssues(output);
```

For structured parsing (file, line, function, error class):

```typescript
import { LogParser, LogStream, LogSession, LogFormatter } from '@danecodes/roku-ecp';

// Parse raw text into structured entries
const parser = new LogParser();
const entries = parser.parse(output);  // LogEntry[] with type, source, message

// Stream logs in real time
const stream = new LogStream('192.168.0.30');
stream.on('error', (err) => console.log(err.errorClass, err.source));
stream.on('crash', (bt) => console.log(bt.frames));
stream.on('beacon', (b) => console.log(b.event, b.duration));
await stream.connect();

// Aggregate and analyze
const session = new LogSession();
session.addAll(entries);
console.log(session.summary());  // { errorCount, crashCount, ... }

// Color-coded terminal output
const fmt = new LogFormatter({ color: true });
entries.forEach(e => console.log(fmt.format(e)));
```

## Recipes

### Sideload and verify the home screen loads

```typescript
import { EcpClient, parseUiXml, waitForElement } from '@danecodes/roku-ecp';

const roku = new EcpClient('192.168.0.30');
await roku.sideload('./my-roku-app');

const getTree = async () => parseUiXml(await roku.queryAppUi());
const home = await waitForElement(getTree, 'HomePage', { timeout: 15000 });
console.log('Home screen loaded:', home.tag);
```

### Navigate and check focus

Don't `sleep()` after key presses. Use `waitForFocus` or `waitForStable` instead.

```typescript
import { EcpClient, Key, parseUiXml, waitForFocus, waitForStable } from '@danecodes/roku-ecp';

const roku = new EcpClient('192.168.0.30');
const getTree = async () => parseUiXml(await roku.queryAppUi());

await roku.press(Key.Down, { times: 3 });
await waitForStable(getTree);

const focused = await waitForFocus(getTree, 'AppButton#settings');
console.log('Settings button focused:', focused.attrs.name);
```

### Wait for a loading spinner to disappear

```typescript
import { waitForElementGone } from '@danecodes/roku-ecp';

await waitForElementGone(getTree, 'LoadingSpinner', { timeout: 10000 });
// content is loaded, safe to interact
```

### Use with vitest

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { EcpClient, Key, parseUiXml, findFocused, waitForElement } from '@danecodes/roku-ecp';

const roku = new EcpClient(process.env.ROKU_IP ?? '192.168.0.30');
const getTree = async () => parseUiXml(await roku.queryAppUi());

beforeAll(async () => {
  await roku.sideload('./my-roku-app');
  await waitForElement(getTree, 'HomePage', { timeout: 15000 });
});

describe('home screen', () => {
  it('starts with the first button focused', async () => {
    const focused = findFocused(parseUiXml(await roku.queryAppUi()));
    expect(focused?.tag).toBe('AppButton');
  });

  it('navigates down to the content rail', async () => {
    await roku.press(Key.Down);
    const rail = await waitForElement(getTree, 'ContentRow');
    expect(rail).toBeDefined();
  });
});
```

### Check device is reachable before running tests

```typescript
const online = await roku.ping();
if (!online) {
  console.error('Roku not reachable at', roku.deviceIp);
  process.exit(1);
}
```

## Requirements

- Roku in developer mode, same network
- Node 22+

## License

MIT
