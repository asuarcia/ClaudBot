#!/usr/bin/env node
/**
 * Provision the Claudbot night VM on the Proxmox NUC — fully self-sufficient.
 *
 * No template needed: downloads the Ubuntu 24.04 cloud image straight into a
 * Proxmox storage, builds a VM from it with cloud-init (SSH key + DHCP), and
 * optionally starts it and waits for its IP.
 *
 * This CREATES A VM on your Proxmox host. It is never run automatically.
 *
 * Env (from .env): PROXMOX_HOST (e.g. 192.168.1.191), PROXMOX_API_TOKEN
 *   (the "USER@REALM!TOKENID=SECRET" string).
 *
 * Usage:
 *   node deploy/proxmox-provision.mjs --check            # verify token perms only
 *   node deploy/proxmox-provision.mjs --start            # provision with defaults
 *   node deploy/proxmox-provision.mjs --vmid 150 --name claudbot-night \
 *        [--node nuc11] [--cores 2] [--memory 2048] [--ciuser claudbot] \
 *        [--sshkey-file ~/.ssh/id_ed25519.pub] [--start] [--insecure]
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// ─── env + args ──────────────────────────────────────────────────────────────

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(path.join(ROOT, ".env"))) {
  for (const line of readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const HOST  = process.env.PROXMOX_HOST;
const TOKEN = process.env.PROXMOX_API_TOKEN;
if (!HOST || !TOKEN) { console.error("Set PROXMOX_HOST and PROXMOX_API_TOKEN in .env"); process.exit(1); }

const arg = (flag, def) => { const i = process.argv.indexOf(flag); return i !== -1 ? process.argv[i + 1] : def; };
const has = (flag) => process.argv.includes(flag);

const node    = arg("--node", "nuc11");
const vmid    = arg("--vmid", "150");
const name    = arg("--name", "claudbot-night");
const cores   = arg("--cores", "2");
const memory  = arg("--memory", "2048");
const ciuser  = arg("--ciuser", "claudbot");
const keyFile = arg("--sshkey-file", path.join(os.homedir(), ".ssh", "id_ed25519.pub"));

// Proxmox ships a self-signed cert. TLS verification stays ON unless the user
// explicitly opts out for a trusted LAN host.
if (has("--insecure") || process.env.PROXMOX_TLS_INSECURE === "1") {
  console.warn("⚠  TLS verification disabled (--insecure). Only use this for a trusted LAN host.");
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const IMG_URL  = "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img";
const IMG_NAME = "noble-server-cloudimg-amd64.qcow2";

// ─── API helper ──────────────────────────────────────────────────────────────

const base = `https://${HOST}:8006/api2/json`;

async function api(method, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      Authorization: `PVEAPIToken=${TOKEN}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathname} → HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

// Poll an async Proxmox task (UPID) until it stops; fail unless exitstatus OK.
async function pollTask(upid, label) {
  const enc = encodeURIComponent(upid);
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const { data } = await api("GET", `/nodes/${node}/tasks/${enc}/status`);
    if (data.status !== "running") {
      if (data.exitstatus !== "OK") throw new Error(`${label} task failed: ${data.exitstatus}`);
      return;
    }
    process.stdout.write(".");
  }
}

// ─── permissions preflight ───────────────────────────────────────────────────

async function checkPermissions() {
  const { data } = await api("GET", "/access/permissions");
  const paths = Object.keys(data ?? {});
  const ok = paths.length > 0 &&
    paths.some((p) => Object.keys(data[p] ?? {}).some((priv) => priv.startsWith("VM.") || priv === "Datastore.AllocateSpace"));
  if (ok) return true;

  const tokenId = TOKEN.split("=")[0]; // USER@REALM!TOKENID
  console.error(`
✗  The API token authenticates but has NO permissions (empty ACL).
   Proxmox tokens are created with "privilege separation" — they get no access
   until you grant them a role. One-time fix, in the Proxmox host shell
   (Datacenter → nuc11 → Shell in the web UI at https://${HOST}:8006):

     pveum acl modify / --tokens '${tokenId}' --roles Administrator

   (Or, to make the token inherit the user's own permissions instead:
     pveum user token modify ${tokenId.split("!")[0]} ${tokenId.split("!")[1]} --privsep 0 )

   Then re-run this script.
`);
  return false;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`1. Checking API token permissions on ${HOST}…`);
  if (!(await checkPermissions())) process.exit(1);
  console.log("   ✓ token has VM/storage permissions");
  if (has("--check")) { console.log("   --check requested — stopping here."); return; }

  console.log(`2. Checking whether VM ${vmid} already exists…`);
  try {
    await api("GET", `/nodes/${node}/qemu/${vmid}/status/current`);
    console.log(`   VM ${vmid} already exists — nothing to do. (Delete it in the UI to re-provision.)`);
    return;
  } catch { /* good — does not exist */ }

  console.log("3. Discovering storage…");
  const { data: storages } = await api("GET", `/nodes/${node}/storage`);
  const withContent = (kind) => storages.filter((s) => (s.content ?? "").split(",").includes(kind) && s.active !== 0);
  const imgStorage =
    withContent("images").find((s) => s.storage === "local-lvm") ?? withContent("images")[0];
  const dlStorage =
    withContent("import").find((s) => s.storage === "local") ?? withContent("import")[0];
  if (!imgStorage) throw new Error("No storage with 'images' content found on the node.");
  if (!dlStorage) {
    throw new Error(
      "No storage accepts 'import' content. In the Proxmox UI: Datacenter → Storage → local → " +
      "Content → add 'Import', then re-run."
    );
  }
  console.log(`   ✓ disks on '${imgStorage.storage}', image download to '${dlStorage.storage}'`);

  console.log("4. Ensuring the Ubuntu 24.04 cloud image is on the node…");
  const { data: contents } = await api("GET", `/nodes/${node}/storage/${dlStorage.storage}/content`);
  const volid = `${dlStorage.storage}:import/${IMG_NAME}`;
  if (contents.some((c) => c.volid === volid)) {
    console.log("   ✓ image already downloaded");
  } else {
    console.log(`   downloading ${IMG_URL} (…this takes a few minutes)`);
    const { data: upid } = await api("POST", `/nodes/${node}/storage/${dlStorage.storage}/download-url`, {
      content: "import", url: IMG_URL, filename: IMG_NAME,
    });
    await pollTask(upid, "image download");
    console.log("\n   ✓ image downloaded");
  }

  console.log(`5. Creating VM ${vmid} ("${name}") — ${cores} cores / ${memory} MB…`);
  const { data: createUpid } = await api("POST", `/nodes/${node}/qemu`, {
    vmid, name, cores, memory,
    cpu: "host",
    net0: "virtio,bridge=vmbr0",
    scsihw: "virtio-scsi-pci",
    scsi0: `${imgStorage.storage}:0,import-from=${volid}`,
    ide2: `${imgStorage.storage}:cloudinit`,
    boot: "order=scsi0",
    serial0: "socket",
    vga: "serial0",
    agent: "1",
    ostype: "l26",
  });
  await pollTask(createUpid, "VM create");
  console.log("\n   ✓ VM created");

  console.log("6. Growing the disk (+8G → ~11G total)…");
  const resize = await api("PUT", `/nodes/${node}/qemu/${vmid}/resize`, { disk: "scsi0", size: "+8G" });
  if (typeof resize.data === "string" && resize.data.startsWith("UPID")) await pollTask(resize.data, "resize");
  console.log("   ✓ disk resized");

  console.log(`7. Configuring cloud-init (user '${ciuser}', SSH key, DHCP)…`);
  let sshkeys;
  try {
    // Proxmox wants the sshkeys *value* itself url-encoded (double-encoded on
    // the wire, since URLSearchParams encodes once more).
    sshkeys = encodeURIComponent(readFileSync(keyFile, "utf8").trim());
  } catch {
    console.warn(`   ⚠ could not read ${keyFile} — VM will be created without an SSH key (use the console).`);
  }
  await api("POST", `/nodes/${node}/qemu/${vmid}/config`, {
    ciuser, ipconfig0: "ip=dhcp", ...(sshkeys ? { sshkeys } : {}),
  });
  console.log("   ✓ cloud-init configured");

  if (!has("--start")) {
    console.log(`\n✓ Done. Start VM ${vmid} from the Proxmox UI, then run deploy/nuc-setup.sh inside it.`);
    return;
  }

  console.log("8. Starting the VM…");
  const { data: startUpid } = await api("POST", `/nodes/${node}/qemu/${vmid}/status/start`, {});
  await pollTask(startUpid, "VM start");
  console.log("\n   ✓ VM started");

  console.log("9. Waiting for an IP (via qemu guest agent — may take a few minutes)…");
  const deadline = Date.now() + 4 * 60 * 1000;
  let ip = null;
  while (Date.now() < deadline && !ip) {
    await new Promise((r) => setTimeout(r, 10_000));
    try {
      const { data } = await api("GET", `/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`);
      for (const iface of data?.result ?? []) {
        if (iface.name === "lo") continue;
        ip = (iface["ip-addresses"] ?? []).find((a) => a["ip-address-type"] === "ipv4")?.["ip-address"] ?? ip;
      }
    } catch { process.stdout.write("."); /* agent not up yet (cloud image installs it on first boot only if configured) */ }
  }

  if (ip) {
    console.log(`\n✓ VM is up at ${ip}`);
    console.log(`  Next: ssh ${ciuser}@${ip}  then  curl -fsSL https://raw.githubusercontent.com/asuarcia/ClaudBot/master/deploy/nuc-setup.sh | sudo bash`);
  } else {
    console.log("\n✓ VM started, but the guest agent didn't report an IP — check the Proxmox UI (VM → Summary) for it.");
    console.log(`  Then: ssh ${ciuser}@<ip>  and run deploy/nuc-setup.sh`);
  }
}

main().catch((e) => { console.error("\nProvision failed:", e.message); process.exit(1); });
