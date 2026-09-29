# Deploying bbbun on a fresh Ubuntu server

The bot and the API are **one process** (`server.js`): the scheduler runs
inside it. That is the whole deployment — no second service, no queue.

Everything below runs as **root**, and the API answers on
`https://api.babybundlecat.meme`. Keep `.env` at mode 600: it holds the wallet
key, and that key is the launch's `creatorFeeRecipient`.

`DRY_RUN=true` is the default. Nothing touches the chain until you set it to
`false` deliberately, in step 11.

---

## 1. Base prep

```bash
apt update && apt -y upgrade
apt -y install git curl ufw nginx
timedatectl set-timezone UTC
```

## 2. Firewall

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
ufw status
```

The API's own port (3000) is never opened: nginx reaches it on localhost.

## 3. Node.js 22 LTS + pm2

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt -y install nodejs
node -v && npm -v          # expect v22.x and npm 10.x
npm i -g pm2
```

**npm 10 is what this lock file is built for.** If you ever regenerate it on a
machine with npm 11, `npm ci` here will refuse to install.

## 4. MongoDB — pick ONE

**A. Hosted (Atlas or similar):** nothing to install. Keep the
`mongodb+srv://…` URI for step 6.

**B. Local:**

```bash
curl -fsSL https://pgp.mongodb.com/server-8.0.asc | gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" > /etc/apt/sources.list.d/mongodb-org-8.0.list
apt update && apt -y install mongodb-org
systemctl enable --now mongod
systemctl status mongod --no-pager | head -5
```

Local URI: `mongodb://127.0.0.1:27017`.

## 5. Clone into /var/www

```bash
mkdir -p /var/www
cd /var/www
git clone https://github.com/blockfile/bbbun.git bbbun
cd /var/www/bbbun
npm ci --omit=dev
```

## 6. Configure

```bash
cd /var/www/bbbun
cp .env.example .env
chmod 600 .env
nano .env
```

What must be set:

| Key | Value |
| --- | --- |
| `WALLET_PRIVATE_KEY` | the key of BABYBUNDLECAT's `creatorFeeRecipient` — nothing can be claimed without it |
| `TOKEN_ADDRESS` | BABYBUNDLECAT, once it is launched on pons v2. Leave blank until then |
| `MONGODB_URI` | from step 4 |
| `API_KEY` | a long random string; it guards `POST /api/run|pause|resume` |
| `CORS_ORIGINS` | `https://babybundlecat.meme,https://www.babybundlecat.meme` |

Already correct in `.env.example`, change only deliberately: `REWARD_TOKEN`
(BUN `0x07EBB29a…90D2`), `REWARD_BUY_PCT=70`, `BURN_PCT=20`,
`TRIGGER_MODE=accumulation`, `CLAIM_EVERY_USD=100`, `MIN_HOLD=100000`.

**Paste the key without it reaching your shell history:**

```bash
read -rs KEY && sed -i "s|^WALLET_PRIVATE_KEY=.*|WALLET_PRIVATE_KEY=$KEY|" .env && unset KEY
grep -c '^WALLET_PRIVATE_KEY=0x' .env      # expect 1
```

## 7. Preflight (still DRY_RUN)

```bash
cd /var/www/bbbun
npm run check
```

It prints the wallet, the launch's phase and fee recipient, what is claimable,
the split and the trigger. **`wallet` must equal `feeRecipient`** — if it does
not, nothing downstream can ever claim.

## 8. Start it with pm2

```bash
cd /var/www/bbbun
pm2 start server.js --name bbbun
pm2 startup systemd        # prints ONE line — run it
pm2 save
pm2 logs bbbun --nostream --lines 30
```

## 9. nginx

```bash
sudo tee /etc/nginx/sites-available/api.babybundlecat.meme >/dev/null <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name api.babybundlecat.meme;

    access_log /var/log/nginx/bbbun.access.log;
    error_log  /var/log/nginx/bbbun.error.log;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;

        # GET /api/stream is Server-Sent Events: no buffering, no early close.
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/api.babybundlecat.meme /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

Point `api.babybundlecat.meme` at this server's IP (an A record) before the
next step — certbot proves the domain over HTTP and needs it resolving here.

## 10. HTTPS

```bash
apt -y install certbot python3-certbot-nginx
certbot --nginx -d api.babybundlecat.meme --agree-tos -m you@example.com --redirect
certbot renew --dry-run
curl -s https://api.babybundlecat.meme/api/status | head -c 200
```

## 11. Going live

Only after `npm run check` looks right and the token is launched:

```bash
cd /var/www/bbbun
sed -i 's/^DRY_RUN=.*/DRY_RUN=false/' .env
grep '^DRY_RUN=' .env
pm2 restart bbbun --update-env
pm2 logs bbbun --nostream --lines 40
```

Fund the wallet with a little ETH for gas first — the dev leg keeps ETH in the
wallet, but the first cycle still has to pay for its own transactions.

Force one cycle without waiting for the $100 gate:

```bash
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2-)
curl -s -X POST -H "x-api-key: $API_KEY" http://127.0.0.1:3000/api/run | head -c 400
```

## Redeploying

```bash
cd /var/www/bbbun
git pull && npm ci --omit=dev && pm2 restart bbbun --update-env
until curl -sf https://api.babybundlecat.meme/api/status >/dev/null; do sleep 1; done
curl -s https://api.babybundlecat.meme/api/stats
```

Chaining with `&&` matters: a failed install must never restart the bot into
missing modules.

## Watch list

- **`wallet` vs `feeRecipient`.** Any mismatch means every cycle claims nothing.
- **The burn step.** `pm2 logs bbbun | grep burn` — "bought … and sent it to
  0x…dead" is the good line. A failed transfer leaves the BBC in the wallet and
  is NOT retried automatically.
- **A quiet stretch is not a fault.** The gate is $100 of claimable fees;
  below it the scheduler logs "below accumulation threshold" and the fees keep
  accruing.
- **Sweeps.** Post-graduation, part of the fees can only be moved by pons's
  operator. `sweep skipped` is normal; the fees reach the escrow later.
