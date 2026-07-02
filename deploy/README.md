# Running Claudbot's idle processes on the NUC

Goal: stop leaving your PC on overnight. Run `dream`, `briefing`, and the
`dashboard` on a small VM on the Proxmox NUC (192.168.1.191 / node `nuc11`), then
just open `http://<vm-ip>:4500` in the morning.

All three run under one supervisor (`claudbot night`), which restarts any that
crash. It needs only **Node 22 + a `NIM_API_KEY`** — no Claude Code, no GUI.

## 0. One-time: give the API token permissions

Proxmox tokens start with **no ACLs** (privilege separation). In the Proxmox
web UI (`https://192.168.1.191:8006` → node → Shell) run once:

```bash
pveum acl modify / --tokens 'claudbot@pve!bot' --roles Administrator
```

`node deploy/proxmox-provision.mjs --check` verifies this and prints the exact
command (with your token id) if it's still missing.

## 1. Create the VM

**Option A — fully automatic via the API** (set `PROXMOX_HOST` and
`PROXMOX_API_TOKEN` in `.env` first). No template needed — the script downloads
the Ubuntu 24.04 cloud image, builds the VM from it, configures cloud-init
(user `claudbot`, your `~/.ssh/id_ed25519.pub`, DHCP), starts it, and prints
its IP:

```bash
node deploy/proxmox-provision.mjs --start
# defaults: --node nuc11 --vmid 150 --name claudbot-night --cores 2 --memory 2048
# add --insecure only if the Proxmox cert is self-signed and the host is trusted
```

**Option B — make the VM by hand** in the Proxmox UI: a Debian 12 / Ubuntu 24.04
VM, 2 vCPU / 2 GB / 10 GB is plenty.

## 2. Provision inside the VM

SSH in and run:

```bash
sudo bash deploy/nuc-setup.sh
# (or, fresh box:)
curl -fsSL https://raw.githubusercontent.com/asuarcia/ClaudBot/master/deploy/nuc-setup.sh | sudo bash
```

This installs Node, clones Claudbot to `/opt/claudbot`, runs `npm run setup`,
creates `.env` from the template, and enables the `claudbot-night` systemd
service.

## 3. Configure + go

```bash
sudo -e /opt/claudbot/.env          # set NIM_API_KEY (and any connector keys)
sudo systemctl restart claudbot-night
journalctl -u claudbot-night -f     # watch it run
```

Open `http://<vm-ip>:4500`. Update later with
`git -C /opt/claudbot pull && sudo systemctl restart claudbot-night`.

## Files

| File | Purpose |
|------|---------|
| `claudbot-night.service` | systemd unit running `node night.mjs` |
| `nuc-setup.sh` | one-shot provisioner (run as root in the VM) |
| `proxmox-provision.mjs` | build the night VM from the Ubuntu cloud image via the Proxmox API (no template needed) |

## Reusing for TradeAlgo

Same pattern: TradeAlgo gets its own `night.mjs`/`briefing.mjs` with finance
sources + panels, its own `*-night.service`, and rides this exact NUC flow.
