# node-meross-sdk

[![CI](https://github.com/Doekse/node-meross-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/Doekse/node-meross-sdk/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/node-meross-sdk/alpha.svg)](https://www.npmjs.com/package/node-meross-sdk)
[![npm downloads](https://img.shields.io/npm/dm/node-meross-sdk.svg)](https://www.npmjs.com/package/node-meross-sdk)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-included-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/github/license/Doekse/node-meross-sdk.svg)](./LICENSE)
[![status](https://img.shields.io/badge/status-alpha-orange.svg)](#status)

[![GitHub issues](https://img.shields.io/github/issues/Doekse/node-meross-sdk.svg)](https://github.com/Doekse/node-meross-sdk/issues)
[![GitHub stars](https://img.shields.io/github/stars/Doekse/node-meross-sdk?style=social)](https://github.com/Doekse/node-meross-sdk/stargazers)

Control Meross devices from Node.js using a **session**, **endpoints**, and **traits**. One endpoint is one device you would expose to a user: a plug, a strip outlet, a bulb, a thermostat, a hub sensor, and so on.

This fork also includes [Meross Connect for Homey](./homey-app/README.md), an
independent MSG100 garage-opener app with MFA pairing, token-only session restore,
and a Docker installer for self-hosted Homey. Existing SDK methods remain
compatible; this fork adds a read-only garage `poll()` and an opt-in MSG100 state
polling profile.

Meross products do not share a simple device model. Firmware speaks in protocol namespaces, channels, hub subdevices, and Ability / System.All payloads, and you have to choose LAN HTTP versus cloud MQTT yourself. This package hides that. You log in, walk inventory, and call trait methods. Transports, MQTT, and codecs stay inside the package.

It was built to power a [Homey](https://homey.app) integration, and to give other Node.js hosts the same surface: another smart-home platform, a gateway, or a script that should not have to know how Meross structures its products.

## Table of contents

- [Status](#status)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Concepts](#concepts)
- [Usage](#usage)
- [Logging](#logging)
- [Traits](#traits)
- [Errors](#errors)
- [Development](#development)
- [Changelog](#changelog)
- [Contributing](#contributing)
- [Credits](#credits)
- [License](#license)
- [Disclaimer](#disclaimer)



## Status

Session, LAN/MQTT transports, enrollment, polling, and traits are implemented. The public API is **alpha**: expect breaking changes until `1.0.0`.

The first published release is `0.1.0-alpha`.

## Features

- Cloud login with optional MFA, plus token restore without storing the password
- Ability-based enrollment: traits attach from firmware `Ability` + `System.All`, not a hardcoded model list
- One `Endpoint` per user-visible device (strip outlets and hub children included)
- LAN HTTP preferred automatically, with MQTT failover
- PUSH updates plus background polling; hosts listen on endpoint `availability`, `change`, and `protocol`, and session `connection`, `ratelimit`, and `warning`
- The cloud publish window is respected per device: one publish per poll cycle, packed into `Appliance.Control.Multiple`, with publishes held back so polling cannot starve a user command
- TypeScript types shipped next to CommonJS `dist/` so `require()` hosts (including Homey) load without a bundler



## Requirements

- Node.js **>= 22**



## Installation

```bash
npm install node-meross-sdk@alpha
```

This is a prerelease on the `alpha` dist-tag. The package emits CommonJS from `dist/` and includes TypeScript declarations.

## Quick start

```javascript
const { Session } = require('node-meross-sdk');

(async () => {
  const session = await Session.login({
    email: 'you@example.com',
    password: 'secret'
    // mfaCode: '123456'
  });

  await session.connect();
  await session.enroll();

  for (const row of session.inventory.endpoints()) {
    const endpoint = session.endpoint(row.id);

    endpoint.on('availability', (online) => {
      console.log(row.name, online ? 'online' : 'offline');
    });

    endpoint.on('change', ({ trait, values }) => {
      console.log(row.name, trait, values);
    });

    if (endpoint.switch) {
      await endpoint.switch.setOn(true);
    }
  }
})();
```

TypeScript can import the same surface:

```typescript
import { Session } from 'node-meross-sdk';
```



## Concepts


| Piece         | Role                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Session**   | Cloud credentials, live inventory, and connect/enroll/disconnect. Persist `[TokenData](#reuse-a-token)` and rebuild with `Session.restore`. |
| **DeviceList** | Account rows from HTTP `devList` via `listDevices()` (`uuid`, `name`, `model`, `subType`, `onlineStatus`, `channels`). Not enrolled; no MQTT. |
| **Inventory** | User-visible rows after enrollment (`id`, `name`, `model`, `classHint`, `traits`, optional `parentId`). Live availability is on Endpoint. |
| **Endpoint**  | One device you would show a user. Traits live here. Channel and subdevice id are bound at enrollment; they are not method arguments. |
| **Trait**     | Capability on that endpoint (`switch`, `light`, `energy`, ...). Absent traits are `undefined`; check before calling.                   |


A 4-gang strip is a **master** endpoint (switch + energy) plus four switch children with `parentId`. Hub children use the same `Endpoint` type (`parentId` is metadata). Hosts group by `parentId`; they do not merge children into the parent.

## Usage



### Reuse a token

`Session.login` does not keep the password. Persist `getToken()` and restore later:

```javascript
const session = await Session.login({
  email: 'you@example.com',
  password: 'secret'
});
await session.connect();
await session.enroll();
const token = session.getToken();
// persist JSON.stringify(token)

const restored = Session.restore(token);
await restored.connect();
await restored.enroll();
```



### List cloud devices without enrolling

`listDevices()` is HTTP `devList` only. Each `DeviceList` row has a physical `uuid`, plus `name` and `model` (the same field names as inventory), `onlineStatus`, and `channels`. It does not open MQTT, run Ability / System.All, or mutate `session.inventory`. Pairing UIs use this; runtime uses inventory after `enroll`.

```javascript
const account = await session.listDevices();
for (const row of account) {
  console.log(row.uuid, row.name, row.model, row.onlineStatus);
}
```

### Enroll and unenroll devices

Membership is additive. After `connect()` opens transports:

```javascript
await session.connect();
const { enrolled, skipped, failed } = await session.enroll([uuid]);
await session.enroll();         // every online device not yet enrolled
await session.unenroll(uuid);   // stop its runtime and drop its rows
await session.disconnect();
```

`enroll` is idempotent per uuid: an already-enrolled or in-flight uuid does not list the account or contact the device again. Concurrent callers share one in-flight `devList` and one Ability / System.All pass per uuid; passes are bounded by `ENROLL_CONCURRENCY` across calls. Pass `[]` to enroll nothing.

The promise fulfills with `{ enrolled, skipped, failed }`. Offline rows (`onlineStatus !== 1`) and uuids absent from the account are `skipped` (`offline` / `unknown`) with no event. A reachable device that fails is in `failed` and on `warning` (error plus uuid); the rest continue. Already-enrolled uuids are in `enrolled`. `session.endpoint(id)` still throws `ENDPOINT_NOT_FOUND` for anything that did not enroll.

Hosts that pair devices one at a time (for example Homey `onInit` per outlet) call `enroll([uuid])` from each device and `unenroll(uuid)` when the last sibling for that physical plug is deleted. There is no need to resubmit the whole paired set. An `Endpoint` already returned for that uuid rejects commands with `ENDPOINT_NOT_FOUND` until the uuid is enrolled again.

`connect()` only opens transports. A second call while already connected joins an in-flight handshake, then returns. `disconnect()` closes transports and clears inventory; the stored token remains valid for `restore`.

### Log out of the cloud account

Call `logout()` when removing a stored profile or replacing a token so Meross stops counting it against the account token limit. It runs `disconnect()` first, then POSTs `/v1/Profile/logout`. Afterward, `getToken()` and `connect()` throw `AuthError`, and you must not persist the old token or pass it to `Session.restore`.

```javascript
await session.logout();
// drop persisted token from disk
```

### Recover from an expired token

A long-running host will eventually see `AuthError` with code `TOKEN_EXPIRED`. `reauthenticate()` swaps in fresh credentials without discarding inventory, so every `Endpoint` and its listeners stay valid:

```javascript
try {
  await session.enroll();
} catch (error) {
  if (error.code === 'TOKEN_EXPIRED') {
    await session.reauthenticate({ email: 'you@example.com', password: 'secret' });
    // persist session.getToken() again
    await session.enroll();
  }
}
```

Transports are only rebuilt when the device key, user id, or broker domain actually changed, and the old connection stays live until the new one is up.

### Events

Attach session listeners before `connect()`. Endpoint listeners can be attached once inventory is ready.

```javascript
session.on('connection', (connected) => {
  // MQTT broker up/down, including reconnect after a drop
});

session.on('ratelimit', (uuid, dropped) => {
  // cloud publish dropped for this device; dropped is the cumulative count
});

session.on('warning', (error, uuid) => {
  // a reachable device that enroll() could not finish, e.g. an Ability /
  // System.All timeout, or a hub whose cloud subdevice list failed (digest
  // children still enroll). uuid is the physical device when known.
  // Cloud-level failures reject enroll() itself instead of arriving here.
});

const endpoint = session.endpoint(row.id);

endpoint.on('availability', (online) => {
  // boolean; current value is endpoint.isOnline()
});

endpoint.on('protocol', (protocol) => {
  // 'http' | 'mqtt'; current value is endpoint.protocol()
});

endpoint.on('change', (change) => {
  // Narrow on trait before reading fields — values is a per-trait union.
  if (change.trait === 'energy') {
    // change.values.power, .current, .voltage, …
  }
});

// Same shape as `change`, for state that was seeded or polled before this listener existed.
for (const change of endpoint.snapshot()) {
  // change.trait / change.values
}
```



### Look up by inventory row

```javascript
for (const row of session.inventory.endpoints()) {
  if (row.classHint !== 'socket') continue;
  const endpoint = session.endpoint(row.id);
  if (row.parentId) {
    // Child outlet on a strip, or a hub subdevice
  }
  await endpoint.switch?.setOn(true);
}
```

Unknown ids throw `MerossError` with code `ENDPOINT_NOT_FOUND`. Commands on a session that is not connected throw `NOT_CONNECTED`.

## Logging

Pass `logger` on `SessionOptions` to receive MQTT, LAN, and cloud traffic. The SDK never reads `DEBUG` or any env flag — omit the sink to stay silent. Session `connection`, `ratelimit`, and `warning` stay events; they are not mirrored through the logger.

`logLevel` is the floor when `logger` is set (default `debug`):

| `logLevel` | Emits |
| --- | --- |
| `error` | Swallowed faults only (e.g. malformed MQTT). JSON `data` is redacted; other dumps are omitted |
| `debug` (default) | Errors plus one-line traffic summaries — **no** `data` |
| `trace` | Errors plus one traffic record per frame **with** `data` |

```javascript
const { Session } = require('node-meross-sdk');

const session = await Session.login(
  { email: 'you@example.com', password: 'secret' },
  {
    logLevel: 'trace', // omit or 'debug' for summaries without bodies
    logger: (record) => {
      console.log(record.message);
      if (record.data) console.log(record.data);
    }
  }
);
```

Cloud records redact `password`, `token`, `key`, and `mfaCode`. Treat dumps as sensitive anyway: topics, device payloads, and account email still appear in plaintext.

## Traits

Traits are present only when the device advertised the matching ability. Use optional chaining or an `if` guard.


| Trait            | Typical devices                    | Host API                                                                              |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| `switch`         | Plugs, strips, wall switches       | `isOn()`, `setOn(boolean)`                                                            |
| `light`          | Bulbs and light strips             | `setOn`, `setBrightness` / `setTemperature` (`0..1`), `setRgb`, `setEffect`           |
| `energy`         | Metered plugs and strips           | `poll()` (power / current / voltage), `getHourlyConsumption()`, `deleteConsumption()` |
| `cover`          | Garage doors, roller shutters      | Narrow `kind` (`garage` / `shutter`). Shared: `open`, `close`. Shutter: `stop`, `setPosition`, `calibrate`. Garage: `setConfig`. Missing Ability throws `NAMESPACE_NOT_ADVERTISED`. |
| `climate`        | Thermostats and hub valves         | Narrow `kind` (`mode` / `modeB` / `modeC` / `hub`). Shared: `setOn`, `setTargetTemperature`. ModeC: `setFanSpeed` (`null` hold disables); `setTargetTemperature` only in heat/cool. Hub: `setConfig` / `setSuperCtl`. Missing Ability throws `NAMESPACE_NOT_ADVERTISED`. |
| `sensor`         | Hub temp/hum, contact, leak, motion, smoke | Narrow `kind` (`tempHum` / `contact` / `leak` / `motion` / `smoke`). Live values on `change`. TempHum: `setCalibration`, `setAlerts`. Smoke: `mute` / `test`. Missing Ability throws `NAMESPACE_NOT_ADVERTISED`. |
| `presence`       | Wi-Fi presence sensors             | `change` values; `getConfig()`, `setConfig()`, `startStudy()`                         |
| `fan`            | Fans                               | `setOn`, `setSpeed`, `getButtonConfig` / `setButtonConfig`                            |
| `spray`          | Humidifiers                        | `getMode()`, `setMode('off'                                                           |
| `diffuser`       | Diffusers                          | Light + spray mode, brightness, RGB                                                   |
| `sprinkler`      | Hub sprinkler valves               | `setOn`, `setDuration`, `getSchedule`; last cycle on `change`                         |
| `media`          | Speakers                           | `setMuted`, `setVolume`, `setSong`                                                    |
| `alarm`          | Hub sirens, board chimes           | `setOn(on, durationSeconds?)`, `setLinked`, `setBeep`                                 |
| `dnd`            | Status LED on the device           | `isOn()`, `setOn(boolean)`, `poll()`                                                  |
| `overtemp`       | Plugs with Config.OverTemp         | `poll()`, `set({ enabled, type? })`; Control.OverTemp PUSH updates `active` / `timestamp` / `type` |
| `alert`          | EM06 / MTS300 AlertConfig          | `poll()`, `set({ type?, value? })`; AlertReport PUSH updates `report` (not polled)    |
| `standbykiller`  | Plugs with Config.StandbyKiller    | `poll()`, `set({ enabled?, power?, time?, alert? })` (power in watts)                 |
| `system`         | Device firmware, time, diagnostics | `getFirmware` / `getHardware` / `getTime`, `setTimezone`, `getDebug`, `hasRuntime()` / `getRuntime()` (signal %), `getPosition` / `setPosition`, `clockSkewSeconds` |
| `timer`          | Toggle / ToggleX clock schedules   | `list()`, `set()`, `setEnabled()`, `remove()`                                         |
| `trigger`        | Toggle / ToggleX countdown rules   | `list()`, `set()`, `setEnabled()`, `remove()`                                         |


Readings such as energy and sensors update from PUSH and the internal poller. Listen on `change`; call a trait's `poll()` when you need an on-demand sample. `dnd`, `overtemp`, `alert`, and `standbykiller` are independent of `energy`.

## Errors

Catch by class. Each error has a string `code`. Trait commands such as `setOn`, and on-demand energy reads (`energy.poll()`, `getHourlyConsumption()`), reject with `CommandError`, `TransportError`, or `ProtocolError` — not `AuthError` / `CloudError`. When `poll()` fails partway through, earlier GETs may already be in `change` / `last`; the call still rejects.


| Class            | When                                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `CommandError`   | `COMMAND_TIMEOUT`, device `ERROR` (`COMMAND_FAILED` + `deviceCode`), `COMMAND_CANCELLED`, wrong key (`INVALID_KEY`, `deviceCode` 5001)   |
| `TransportError` | MQTT/LAN connect or publish failure after failover (`MQTT_RATE_LIMITED`, …)                                                             |
| `ProtocolError`  | Malformed envelope, `SIGNATURE_ERROR`, or a LAN body that is not a pending reply                                                          |
| `MerossError`    | `NOT_CONNECTED`, `ENDPOINT_NOT_FOUND`, `TIMER_NOT_FOUND`, `TRIGGER_NOT_FOUND`, `NAMESPACE_NOT_ADVERTISED`, and other operational failures |
| `AuthError`      | Login, `listDevices()`, `enroll()`, `connect()` after logout, or `reauthenticate()` — bad credentials, MFA, or an incomplete / expired token |
| `CloudError`     | Login, `listDevices()`, `enroll()`, or `reauthenticate()` — cloud HTTP failure, region redirect exhaustion, or a non-auth `apiStatus`       |


```javascript
const {
  AuthError,
  CloudError,
  MerossError,
  CommandError,
  TransportError,
  ProtocolError
} = require('node-meross-sdk');
```



## Development

```bash
npm install
npm test
npm run lint
npm run typecheck
npm run build
```

Tests use Node's built-in `node:test` runner. CI lints, typechecks, and runs tests on Node 22 and 24. Bumping `version` in `package.json` on `main` creates a GitHub Release from `CHANGELOG.md` and publishes to npm.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## Contributing

Bug reports and device traces are welcome in [GitHub Issues](https://github.com/Doekse/node-meross-sdk/issues). Include the model name, what failed, and (if you can) sniffed Ability / System.All payloads.

## Credits

Protocol knowledge draws on:

- [meross_lan](https://github.com/krahabb/meross_lan) by @krahabb
- [MerossIot (Python)](https://github.com/albertogeniola/MerossIot) by Alberto Geniola



## License

[MIT](./LICENSE)

## Disclaimer

All product and company names or logos are trademarks™ or registered® trademarks of their respective holders. Use of them does not imply any affiliation with or endorsement by them or any associated subsidiaries. This personal project is maintained in spare time and has no business goal.

**MEROSS** is a trademark of Chengdu Meross Technology Co., Ltd.
