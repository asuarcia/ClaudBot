#!/usr/bin/env node
/**
 * device-control MCP server
 *
 * Lets Claude connect to and troubleshoot physical devices plugged into this
 * machine: Android over ADB, iOS over libimobiledevice, and generic USB/serial
 * enumeration.
 *
 * Schemas are hand-written on purpose. zodToJsonSchema + zod v4 silently emits
 * empty schemas, which makes every tool look argument-less to the model — that
 * bug cost us real time once already.
 *
 * Destructive verbs (factory reset, wipe, bootloader/fastboot flashing) are
 * blocked here in `assertAllowed`, independently of the deny rules in
 * .claudbot/restrictions.yaml. Two layers, because one of them is a config file
 * the user can edit by accident.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import * as tools from "./tools.mjs";

// ─── tool definitions ────────────────────────────────────────────────────────

const SERIAL = {
  type: "string",
  description: "Device serial from list_devices. Omit when only one device is connected.",
};

const TOOLS = [
  {
    name: "list_devices",
    description:
      "List every connected device: Android over ADB, iOS over libimobiledevice, " +
      "with model and state. Start here — every other tool takes a serial from this.",
    inputSchema: {
      type: "object",
      properties: {
        includeIos: {
          type: "boolean",
          description: "Also probe for iOS devices (default true).",
        },
      },
      required: [],
    },
  },
  {
    name: "adb_shell",
    description:
      "Run a shell command on a connected Android device and return its output. " +
      "This is the main troubleshooting tool: getprop, dumpsys, pm list packages, " +
      "settings get, df, top, and so on. Destructive verbs are refused.",
    inputSchema: {
      type: "object",
      properties: {
        serial: SERIAL,
        command: {
          type: "string",
          description: "The shell command to run on the device, e.g. \"dumpsys battery\".",
        },
        timeout: {
          type: "number",
          description: "Milliseconds before giving up (default 30000, max 300000).",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "adb_screencap",
    description:
      "Take a screenshot of an Android device and save it as a PNG. Returns the " +
      "file path — read that file to actually see the screen.",
    inputSchema: {
      type: "object",
      properties: {
        serial: SERIAL,
        outPath: {
          type: "string",
          description: "Where to write the PNG. Defaults to a timestamped file in the temp dir.",
        },
      },
      required: [],
    },
  },
  {
    name: "adb_input",
    description:
      "Drive an Android device's UI: tap, swipe, type text, or send a key event. " +
      "Pair with adb_screencap to see the result.",
    inputSchema: {
      type: "object",
      properties: {
        serial: SERIAL,
        action: {
          type: "string",
          enum: ["tap", "swipe", "text", "keyevent"],
          description: "What to do.",
        },
        x: { type: "number", description: "X coordinate (tap, swipe start)." },
        y: { type: "number", description: "Y coordinate (tap, swipe start)." },
        x2: { type: "number", description: "Swipe end X." },
        y2: { type: "number", description: "Swipe end Y." },
        durationMs: { type: "number", description: "Swipe duration in milliseconds." },
        text: { type: "string", description: "Text to type (action=text)." },
        keycode: {
          type: "string",
          description: "Key to send, e.g. KEYCODE_HOME, KEYCODE_BACK, or a numeric code.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "adb_logcat",
    description:
      "Read recent Android logcat output. Use this to see why an app is crashing.",
    inputSchema: {
      type: "object",
      properties: {
        serial: SERIAL,
        filter: {
          type: "string",
          description: "Logcat tag spec, e.g. \"ActivityManager:E *:S\".",
        },
        lines: { type: "number", description: "How many recent lines (default 200, max 2000)." },
        clear: { type: "boolean", description: "Clear the buffer first, to capture only what happens next." },
      },
      required: [],
    },
  },
  {
    name: "adb_install",
    description: "Install an APK onto a connected Android device.",
    inputSchema: {
      type: "object",
      properties: {
        serial: SERIAL,
        apkPath: { type: "string", description: "Absolute path to the .apk on this machine." },
        reinstall: { type: "boolean", description: "Keep data and reinstall over an existing copy (-r)." },
      },
      required: ["apkPath"],
    },
  },
  {
    name: "adb_uninstall",
    description: "Uninstall an app from a connected Android device by package name.",
    inputSchema: {
      type: "object",
      properties: {
        serial: SERIAL,
        package: { type: "string", description: "Package name, e.g. com.example.app." },
        keepData: { type: "boolean", description: "Keep app data and cache (-k)." },
      },
      required: ["package"],
    },
  },
  {
    name: "adb_push",
    description: "Copy a file from this machine onto a connected Android device.",
    inputSchema: {
      type: "object",
      properties: {
        serial: SERIAL,
        localPath: { type: "string", description: "Source path on this machine." },
        remotePath: { type: "string", description: "Destination path on the device, e.g. /sdcard/Download/x.txt." },
      },
      required: ["localPath", "remotePath"],
    },
  },
  {
    name: "adb_pull",
    description: "Copy a file off a connected Android device onto this machine.",
    inputSchema: {
      type: "object",
      properties: {
        serial: SERIAL,
        remotePath: { type: "string", description: "Source path on the device." },
        localPath: { type: "string", description: "Destination path on this machine." },
      },
      required: ["remotePath", "localPath"],
    },
  },
  {
    name: "ios_info",
    description:
      "Device info for a connected iPhone or iPad (name, model, iOS version, " +
      "serial, battery). iOS is read-mostly — Apple does not expose UI automation " +
      "to a desktop without a paid developer profile.",
    inputSchema: {
      type: "object",
      properties: {
        udid: { type: "string", description: "Device UDID from list_devices. Omit if only one is connected." },
      },
      required: [],
    },
  },
  {
    name: "ios_syslog",
    description:
      "Capture the live system log from a connected iOS device for a few seconds. " +
      "This is the main iOS troubleshooting signal available without Xcode.",
    inputSchema: {
      type: "object",
      properties: {
        udid: { type: "string", description: "Device UDID. Omit if only one is connected." },
        seconds: { type: "number", description: "How long to capture (default 10, max 60)." },
        filter: { type: "string", description: "Case-insensitive substring to keep." },
      },
      required: [],
    },
  },
  {
    name: "serial_ports",
    description:
      "Enumerate serial and USB devices attached to this machine (COM ports on " +
      "Windows, /dev/cu.* on macOS, /dev/ttyUSB* and friends on Linux).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

const HANDLERS = {
  list_devices: tools.listDevices,
  adb_shell: tools.adbShell,
  adb_screencap: tools.adbScreencap,
  adb_input: tools.adbInput,
  adb_logcat: tools.adbLogcat,
  adb_install: tools.adbInstall,
  adb_uninstall: tools.adbUninstall,
  adb_push: tools.adbPush,
  adb_pull: tools.adbPull,
  ios_info: tools.iosInfo,
  ios_syslog: tools.iosSyslog,
  serial_ports: tools.serialPorts,
};

// ─── server ──────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "device-control", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  try {
    return await handler(args ?? {});
  } catch (err) {
    // Surface the reason as tool output rather than a protocol error, so the
    // model can read it and adapt instead of just seeing a failed call.
    return {
      isError: true,
      content: [{ type: "text", text: `${name} failed: ${err?.message ?? String(err)}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
