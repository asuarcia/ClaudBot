# device-control MCP

Lets Claude connect to and troubleshoot physical devices plugged into this
machine.

Registered automatically — `patchSettings()` in `claudbot.mjs` writes it into
`.claudbot/.mcp.json` and `enabledMcpjsonServers` on every launch. (Claude Code
ignores `settings.json.mcpServers`; that path does not work.)

## Tools

| Tool | What it does |
|---|---|
| `list_devices` | Android + iOS inventory. Start here. |
| `adb_shell` | Any shell command on the device — `dumpsys`, `getprop`, `pm list packages` |
| `adb_screencap` | Screenshot to a PNG; read the file to see the screen |
| `adb_input` | tap / swipe / text / keyevent |
| `adb_logcat` | Recent log lines, optionally cleared first and tag-filtered |
| `adb_install` / `adb_uninstall` | APK lifecycle |
| `adb_push` / `adb_pull` | Move files on and off |
| `ios_info` | Name, model, iOS version, serial, battery |
| `ios_syslog` | Timed capture of the live system log |
| `serial_ports` | COM ports / `/dev/cu.*` / `/dev/ttyUSB*` |

## iOS is read-mostly, and that's the ceiling

There is no iOS equivalent of `adb_input`. Apple does not expose UI automation
to a desktop without a paid developer profile and a signed test runner on the
device. What libimobiledevice gives you — device info, live syslog, backups — is
genuinely useful for diagnosis, and it is where the honest limit sits. Anything
promising more is either jailbreak-only or requires an Xcode project you'd have
to build and sign yourself.

## Refused operations

These are blocked inside the server, in `assertAllowed`:

factory reset / `MASTER_CLEAR` · `pm clear` · recovery and data wipes ·
`fastboot` and any flashing · bootloader unlock · reboot into
bootloader/recovery/fastboot/EDL · `disable-verity` · `rm -rf` of device storage
· `mkfs`/`dd` · root shells · `idevicerestore`

`.claudbot/restrictions.yaml` denies the same verbs at the Bash-tool layer, so a
raw shell attempt is caught too. Two layers, because one of them is a config
file that can be edited by accident. If you genuinely want to wipe a phone, run
the command yourself.

## Prerequisites

Neither is bundled; the tools report exactly what's missing and how to get it.

**Android** — SDK Platform Tools:
```
winget install Google.PlatformTools     # Windows
brew install android-platform-tools     # macOS
sudo apt install android-tools-adb      # Linux
```
Then enable Developer Options -> USB debugging on the phone and accept the
authorization prompt. `list_devices` will say `unauthorized` until you do.

**iOS** — libimobiledevice:
```
brew install libimobiledevice                              # macOS
sudo apt install libimobiledevice-utils                    # Linux
# Windows: github.com/libimobiledevice-win32/imobiledevice-net/releases
```
Tap Trust on the phone when prompted.

Installed somewhere unusual? `ADB_PATH` / `IDEVICE_PATH` in `.env`.
