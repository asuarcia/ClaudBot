# Running Claudbot's idle processes on the NUC

Goal: stop leaving your PC on overnight. Run `dream`, `briefing`, and the
`dashboard` on a small VM on the Proxmox NUC (192.168.1.191 / node `nuc11`), then
just open `http://<vm-ip>:4500` in the morning.

All three run under one supervisor (`claudbot night`), which restarts any that
crash. It needs only **Node 22 + a `NIM_API_KEY`** — no Claude Code, no GUI.

## 1. Create the VM

**Option A — clone a cloud-init template via the API** (set `PROXMOX_HOST` and
`PROXMOX_API_TOKEN` in `.env` first):

```bash
node deploy/proxmox-provision.mjs --template <template-vmid> --vmid 150 \
     --name claudbot --cores 2 --memory 2048 --start
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
| `proxmox-provision.mjs` | optional: clone a template into a new VM via the Proxmox API |

## Reusing for TradeAlgo

Same pattern: TradeAlgo gets its own `night.mjs`/`briefing.mjs` with finance
sources + panels, its own `*-night.service`, and rides this exact NUC flow.
