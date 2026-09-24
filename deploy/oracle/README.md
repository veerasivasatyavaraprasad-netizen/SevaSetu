# Deploy SevaSetu for free on Oracle Cloud (India)

Oracle Cloud's **Always Free** tier gives you a permanent server in India (Mumbai or Hyderabad) at no cost. SevaSetu runs entirely on it:
- the customer and worker app;
- the admin panel on its own address;
- PostgreSQL;
- automatic HTTPS;
- daily backups.

It never sleeps.

> Oracle asks for a card during sign-up **to verify your identity**. Always Free resources are not charged. Keep the account on the free tier and only create resources marked **"Always Free-eligible"**.

## 1. Create your Oracle Cloud account

1. Go to **https://signup.cloud.oracle.com/**.
2. **Home Region:** choose **India West (Mumbai)** or **India South (Hyderabad)**. This can't be changed later, and Always Free servers are only created in your home region.
3. Finish verification (email, phone, card). Then sign in at **https://cloud.oracle.com/**.

## 2. Create the server (about 5 minutes)

1. In the console menu: **Compute → Instances → Create instance**.
2. **Name:** `sevasetu`.
3. **Image:** click *Change image* → **Canonical Ubuntu 24.04**.
4. **Shape:** click *Change shape* → **Ampere** → **VM.Standard.A1.Flex** with **2 OCPUs and 12 GB memory** (Always Free allows up to 4 OCPUs and 24 GB). If Ampere says "out of capacity", pick **VM.Standard.E2.1.Micro** instead (also free, smaller), or try again later.
5. **Networking:** keep the defaults (a new public subnet) and make sure **Assign a public IPv4 address** is on.
6. **SSH keys:** choose **Generate a key pair for me** and click **Save private key**. Keep this file safe; it's how you log in.
7. Click **Create**. When it shows **Running**, copy the **Public IP address**.

## 3. Open the website ports

1. On the instance page, click the **Subnet** link, then the **Default Security List**.
2. **Add Ingress Rules**, twice:
   - Source CIDR `0.0.0.0/0`, IP protocol TCP, destination port **80**.
   - Source CIDR `0.0.0.0/0`, IP protocol TCP, destination port **443**.

## 4. Install SevaSetu (one command)

Connect to the server. Oracle's console has a **Cloud Shell**, or use a terminal:

```bash
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<PUBLIC_IP>
```

On the server:

```bash
sudo git clone https://github.com/veerasivasatyavaraprasad-netizen/SevaSetu.git /opt/sevasetu
cd /opt/sevasetu/deploy/oracle
sudo ./setup.sh
```

If your repository is **private**, `git clone` asks for a username and password. Use your GitHub username and a **personal access token**, not your GitHub password: GitHub → Settings → Developer settings → Fine-grained tokens, with read-only access to this one repository.

The script asks for:
- **Your domain.** Press Enter to use a free one like `app.1-2-3-4.sslip.io`. With your own domain (e.g. `sevasetu.in`), first create DNS **A records** for `app` and `ops` pointing at the server's public IP.
- **Razorpay, MSG91 and Exotel keys.** They're typed on your server only and stored in `/opt/sevasetu/deploy/oracle/.env` (root-only). Never paste them into a chat.
- **Two admin emails and passwords** (operations and finance).

It then:
- generates the encryption keys and database password on the server;
- builds and starts everything;
- turns on HTTPS and schedules daily backups;
- prints your links.

## 5. After install

1. **Back up `.env` now** (`sudo cat /opt/sevasetu/deploy/oracle/.env`) and store it in a password manager. Without `PII_ENCRYPTION_KEY`, encrypted customer data can't be recovered.
2. **Razorpay webhook:** in the Razorpay Dashboard → Webhooks, add `https://app.<your-domain>/api/webhooks/razorpay` for `payment.captured`, `order.paid` and `payout.*` events, with the same webhook secret you typed into the script.
3. **Admin setup:**
   - Open `https://ops.<your-domain>`. Both admins sign in and set up 2FA with an authenticator app.
   - Add your city and PIN codes under **Cities & franchises**, then services and prices under **Services & pricing**.
4. **Mobile app:** set `EXPO_PUBLIC_API_URL` in `mobile/eas.json` to `https://app.<your-domain>` before building.

## Day-to-day

| Task | Command (in `/opt/sevasetu/deploy/oracle`) |
|---|---|
| See status | `sudo docker compose ps` |
| Live logs | `sudo docker compose logs -f app` |
| Update to the latest code | `sudo ./update.sh` (backs up first) |
| Backup now | `sudo /usr/local/bin/sevasetu-backup` |
| Restart | `sudo docker compose restart` |

## Backups

`/var/backups/sevasetu` holds a daily compressed database dump (03:00 IST), kept for 14 days. A backup on the same server doesn't protect against losing the server. Copy them elsewhere regularly, for example to your computer:

```bash
scp -i ssh-key.key 'ubuntu@<PUBLIC_IP>:/var/backups/sevasetu/*' ./sevasetu-backups/
```

**Test a restore** before launch, as the plan requires (§10):

```bash
gunzip -c /var/backups/sevasetu/<file>.sql.gz | sudo docker compose exec -T db psql -U sevasetu -d sevasetu
```

Run it on a spare server, or on a fresh install before real data exists.

## Security notes

- Only ports 22 (SSH), 80 and 443 are open. The database isn't reachable from the internet.
- Containers run as a non-root user; secrets live in a root-only file on your server.
- Keep the OS patched: `sudo apt update && sudo apt upgrade -y` monthly, or enable `unattended-upgrades` (Ubuntu does by default).
- Before launch, get the penetration test the plan calls for (§10).
