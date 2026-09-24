#!/usr/bin/env bash
# One-command install of SevaSetu on a fresh Ubuntu server (Oracle Cloud
# Always Free in Mumbai/Hyderabad, or any Ubuntu 22.04/24.04 VM).
#
#   git clone https://github.com/<you>/SevaSetu.git
#   cd SevaSetu/deploy/oracle && sudo ./setup.sh
#
# Safe to re-run: existing secrets in .env are never regenerated (the PII
# encryption key must never change once data exists).
set -euo pipefail

cd "$(dirname "$0")"
ENV_FILE=.env

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo ./setup.sh"; exit 1; }

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
strong_password() {
  local p=$1 classes=0
  [ ${#p} -ge 12 ] || return 1
  [[ $p =~ [a-z] ]] && classes=$((classes + 1))
  [[ $p =~ [A-Z] ]] && classes=$((classes + 1))
  [[ $p =~ [0-9] ]] && classes=$((classes + 1))
  [[ $p =~ [^A-Za-z0-9] ]] && classes=$((classes + 1))
  [ $classes -ge 3 ]
}
ask() { # ask VAR "Prompt" [secret|password]
  local var=$1 prompt=$2 kind=${3:-} val=""
  if grep -q "^${var}=." "$ENV_FILE" 2>/dev/null; then return; fi
  while true; do
    if [ -n "$kind" ]; then read -r -s -p "$prompt: " val; echo; else read -r -p "$prompt: " val; fi
    if [ -z "$val" ]; then continue; fi
    # Stored single-quoted so Docker never expands $ in it; so no ' allowed.
    if [[ $val == *"'"* ]]; then echo "  Please avoid the ' character."; continue; fi
    if [ "$kind" = password ] && ! strong_password "$val"; then
      echo "  Too weak: use 12+ characters mixing at least three of lowercase, uppercase, digits, symbols."; continue
    fi
    break
  done
  printf "%s='%s'\n" "$var" "$val" >> "$ENV_FILE"
}
envval() { # read a value back without executing .env
  grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed "s/^'//; s/'$//"
}
gen() { # gen VAR value — only if not already set
  grep -q "^$1=" "$ENV_FILE" 2>/dev/null || printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
}

say "Installing Docker"
if ! command -v docker >/dev/null; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

say "Opening ports 80 and 443 in the server firewall"
# Oracle's Ubuntu images ship iptables rules that reject everything except SSH.
if command -v iptables >/dev/null; then
  for p in 80 443; do
    iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT
  done
  DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null
  netfilter-persistent save >/dev/null
fi

say "Configuration"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

if ! grep -q '^APP_DOMAIN=' "$ENV_FILE"; then
  IP=$(curl -fsS https://api.ipify.org || true)
  DEFAULT="${IP//./-}.sslip.io"
  echo "Your sites need a domain. If you have one (e.g. sevasetu.in), point two DNS A records"
  echo "(app.<domain> and ops.<domain>) at this server's IP ${IP} first."
  echo "Without a domain, press Enter to use a free one: app.${DEFAULT} / ops.${DEFAULT}"
  read -r -p "Your domain [${DEFAULT}]: " DOMAIN
  DOMAIN=${DOMAIN:-$DEFAULT}
  gen APP_DOMAIN "app.${DOMAIN}"
  gen ADMIN_DOMAIN "ops.${DOMAIN}"
fi

# Secrets generated on this server; they never leave it.
gen POSTGRES_PASSWORD "$(openssl rand -hex 24)"
gen JWT_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
gen PII_ENCRYPTION_KEY "$(openssl rand -base64 32)"
gen LOOKUP_HMAC_KEY "$(openssl rand -base64 32)"
gen PAYMENT_PROVIDER razorpay
gen SMS_PROVIDER msg91
gen CALL_PROVIDER exotel

echo
echo "Now enter your service keys. They are typed only on this server and stored in"
echo "$(pwd)/.env (readable by root only). Secret values are not shown as you type."
ask RAZORPAY_KEY_ID "Razorpay Key ID (rzp_live_...)"
ask RAZORPAY_KEY_SECRET "Razorpay Key Secret" secret
ask RAZORPAY_WEBHOOK_SECRET "Razorpay webhook secret (make one up; use the same in Razorpay's webhook settings)" secret
ask RAZORPAYX_ACCOUNT_NUMBER "RazorpayX account number"
ask MSG91_AUTH_KEY "MSG91 Auth Key" secret
ask MSG91_OTP_TEMPLATE_ID "MSG91 OTP template ID"
ask EXOTEL_SID "Exotel SID"
ask EXOTEL_API_KEY "Exotel API key" secret
ask EXOTEL_API_TOKEN "Exotel API token" secret
ask EXOTEL_CALLER_ID "Exotel ExoPhone number (virtual number)"

echo
echo "First admins (two people, so payouts and refunds always need a second approver)."
echo "Passwords: at least 12 characters mixing upper/lower case, digits and symbols."
ask BOOTSTRAP_OPS_EMAIL "Operations admin email"
ask BOOTSTRAP_OPS_PASSWORD "Operations admin password" password
ask BOOTSTRAP_FINANCE_EMAIL "Finance admin email"
ask BOOTSTRAP_FINANCE_PASSWORD "Finance admin password" password

say "Building and starting SevaSetu (the first build takes a few minutes)"
docker compose build app
docker compose up -d

say "Daily database backups"
install -m 700 backup.sh /usr/local/bin/sevasetu-backup
sed -i "s#^COMPOSE_DIR=.*#COMPOSE_DIR=$(pwd)#" /usr/local/bin/sevasetu-backup
echo "30 21 * * * root /usr/local/bin/sevasetu-backup" > /etc/cron.d/sevasetu-backup   # 03:00 IST

say "Waiting for the app to come up"
for _ in $(seq 1 60); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    break
  fi
  sleep 5
done
docker compose ps

APP_DOMAIN=$(envval APP_DOMAIN)
ADMIN_DOMAIN=$(envval ADMIN_DOMAIN)
cat <<MSG

SevaSetu is running.

  Customer & worker app : https://${APP_DOMAIN}
  Admin panel           : https://${ADMIN_DOMAIN}
  Razorpay webhook URL  : https://${APP_DOMAIN}/api/webhooks/razorpay

HTTPS certificates are issued automatically on the first visit (allow a minute).
IMPORTANT: back up $(pwd)/.env somewhere safe and private. Without
PII_ENCRYPTION_KEY, encrypted customer data cannot be recovered.

Logs:    cd $(pwd) && sudo docker compose logs -f app
Update:  cd $(pwd) && sudo ./update.sh
MSG
