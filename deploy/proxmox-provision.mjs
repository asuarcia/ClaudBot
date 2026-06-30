#!/usr/bin/env node
/**
 * Provision a Claudbot VM on the Proxmox NUC by cloning a cloud-init template.
 *
 * This CREATES A VM on your Proxmox host — review the params before running.
 * It does not run automatically. After the VM boots, run deploy/nuc-setup.sh
 * inside it (or bake that into the cloud-init template).
 *
 * Env (from .env): PROXMOX_HOST (e.g. 192.168.1.191), PROXMOX_API_TOKEN
 *   (the "USER@REALM!TOKENID=SECRET" string).
 *
 * Usage:
 *   node deploy/proxmox-provision.mjs --template 9000 --vmid 150 --name claudbot \
 *        [--node nuc11] [--cores 2] [--memory 2048] [--start]
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const line of existsSync(path.join(ROOT, ".env")) ? readFileSync(path.join(ROOT, ".env"), "utf8").split("\n") : []) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const HOST  = process.env.PROXMOX_HOST;
const TOKEN = process.env.PROXMOX_API_TOKEN;
if (!HOST || !TOKEN) { console.error("Set PROXMOX_HOST and PROXMOX_API_TOKEN in .env"); process.exit(1); }

const arg = (flag, def) => { const i = process.argv.indexOf(flag); return i !== -1 ? process.argv[i + 1] : def; };
const node     = arg("--node", "nuc11");
const template = arg("--template");
const vmid     = arg("--vmid");
const name     = arg("--name", "claudbot");
const cores    = arg("--cores", "2");
const memory   = arg("--memory", "2048");
const start    = process.argv.includes("--start");

if (!template || !vmid) { console.error("Required: --template <vmid> --vmid <new vmid>"); process.exit(1); }

const base = `https://${HOST}:8006/api2/json`;
const headers = { Authorization: `PVEAPIToken=${TOKEN}`, "Content-Type": "application/x-www-form-urlencoded" };

// Proxmox ships a self-signed cert. Keep TLS verification ON by default; only
// skip it when the user explicitly opts in for their trusted LAN host. The right
// long-term fix is to add the Proxmox CA to the trust store or issue a real cert.
if (process.argv.includes("--insecure") || process.env.PROXMOX_TLS_INSECURE === "1") {
  console.warn("⚠  TLS verification disabled (--insecure). Only use this for a trusted LAN host.");
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

async function api(method, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method, headers,
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathname} → HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  console.log(`Cloning template ${template} → VM ${vmid} ("${name}") on ${node}…`);
  await api("POST", `/nodes/${node}/qemu/${template}/clone`, {
    newid: vmid, name, full: 1,
  });
  console.log("Clone requested. Setting cores/memory…");
  await api("POST", `/nodes/${node}/qemu/${vmid}/config`, { cores, memory });

  if (start) {
    console.log("Starting VM…");
    await api("POST", `/nodes/${node}/qemu/${vmid}/status/start`, {});
  }
  console.log(`✓ Done. ${start ? "VM starting." : "Start it from the Proxmox UI when ready."}`);
  console.log(`Next: SSH in and run  sudo bash deploy/nuc-setup.sh`);
}

main().catch((e) => { console.error("Provision failed:", e.message); process.exit(1); });
