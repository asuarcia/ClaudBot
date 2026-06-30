#!/usr/bin/env bash
#
# Claudbot NUC setup — run as root inside a fresh Debian 12 / Ubuntu 24.04 VM.
# Installs Node, clones Claudbot, and registers the `claudbot-night` service so
# dream + briefing + dashboard run 24/7 (so your PC doesn't have to).
#
#   curl -fsSL https://raw.githubusercontent.com/asuarcia/ClaudBot/master/deploy/nuc-setup.sh | sudo bash
#   # …or copy this repo to the VM and run: sudo bash deploy/nuc-setup.sh
#
set -euo pipefail

APP_DIR=/opt/claudbot
REPO=${CLAUDBOT_REPO:-https://github.com/asuarcia/ClaudBot.git}
SERVICE=claudbot-night

echo "==> Installing Node.js 22 + git"
if ! command -v node >/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y git

echo "==> Creating service user + cloning to $APP_DIR"
id claudbot &>/dev/null || useradd -r -m -d "$APP_DIR" -s /usr/sbin/nologin claudbot
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull
else
  git clone "$REPO" "$APP_DIR"
fi

echo "==> Installing dependencies"
( cd "$APP_DIR" && npm run setup )

echo "==> Ensuring .env"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "    !! Edit $APP_DIR/.env and set at least NIM_API_KEY, then: systemctl restart $SERVICE"
fi
chown -R claudbot:claudbot "$APP_DIR"

echo "==> Installing systemd service"
cp "$APP_DIR/deploy/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable --now "$SERVICE"

IP=$(hostname -I | awk '{print $1}')
echo
echo "==> Done. Dashboard: http://$IP:4500"
echo "    Logs:    journalctl -u $SERVICE -f"
echo "    Update:  git -C $APP_DIR pull && systemctl restart $SERVICE"
