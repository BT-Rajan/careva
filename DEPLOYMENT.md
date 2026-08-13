# Careva — Deployment Guide (Windows & Linux)

This guide covers deploying Careva **without Vercel** — as a plain Node.js API plus a static/served React frontend, on either Windows or Linux. See `software_requirements.md` first for the full list of required software and accounts.

Two paths are covered:

- **A. Native deployment** — install Node.js directly on the machine (Windows or Linux)
- **B. Docker deployment** — use the `Dockerfile`s and `docker-compose.yml` already in the repo (works the same on both OSes)

Pick whichever fits your environment. Both assume you already have:
- A PostgreSQL database and its connection string
- A Cloudinary account and API credentials
- A Gmail account with an App Password

---

## 0. Common first steps (both OS)

```bash
git clone https://github.com/BT-Rajan/careva.git
cd careva
```

You'll be configuring two `.env` files:
- **root `.env`** — frontend API base URLs
- **`api/.env`** — backend secrets and service credentials (copy from `api/.env.example`)

---

## A. Native deployment

### A1. Windows

**1. Install Node.js**

- Download the Node.js 20 LTS installer from [nodejs.org](https://nodejs.org/) and run it (accept defaults — this also installs `npm`).
- Verify in PowerShell:
  ```powershell
  node -v
  npm -v
  ```

**2. Install Git** (if not already installed)

- Download from [git-scm.com](https://git-scm.com/download/win) and install with defaults.

**3. Get a PostgreSQL database**

Either:
- Install PostgreSQL locally: download from [postgresql.org/download/windows](https://www.postgresql.org/download/windows/), run the installer, remember the password you set for the `postgres` user.
- Or use a managed/cloud Postgres provider and just grab the connection string — no local install needed.

**4. Configure and start the backend**

```powershell
cd api
copy .env.example .env
notepad .env
```

Fill in `DATABASE_URL`, `PORT` (default `5050`), `JWT_SCRET`, `JWT_REFRESH_SECRET`, Cloudinary keys, and Gmail credentials (see `software_requirements.md` for the full variable list).

```powershell
npm install
npx prisma generate
npx prisma db push
npm run build
npm run compile
```

`npm run compile` starts the compiled server (`node ./dist/server.js`) on the configured port. Leave this terminal open, or run it as a background service (see **A3** below).

**5. Configure and start the frontend**

Open a **new** PowerShell window:

```powershell
cd careva
copy .env.example .env    REM if no .env.example exists at root, create .env manually
notepad .env
```

Set:
```env
REACT_APP_API_BASE_URL_LOCAL=http://localhost:5050/api/v1
REACT_APP_API_BASE_URL_LIVE=http://YOUR_SERVER_IP_OR_DOMAIN:5050/api/v1
```

```powershell
npm install
npm run build
```

This produces a static `build/` folder. Serve it with any static file server, e.g.:

```powershell
npm install -g serve
serve -s build -l 3000
```

Open `http://localhost:3000` (or your server's IP/domain on port 3000).

### A2. Linux

**1. Install Node.js 20**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
npm -v
```

(For non-Debian distros, use your package manager or [nvm](https://github.com/nvm-sh/nvm).)

**2. Install Git**

```bash
sudo apt-get install -y git
```

**3. Get a PostgreSQL database**

Either install locally:

```bash
sudo apt-get install -y postgresql postgresql-contrib
sudo -u postgres createuser --interactive
sudo -u postgres createdb careva
```

Or use a managed/cloud Postgres provider and use the connection string it gives you.

**4. Configure and start the backend**

```bash
cd careva/api
cp .env.example .env
nano .env
```

Fill in the same variables as the Windows section above.

```bash
npm install
npx prisma generate
npx prisma db push
npm run build
npm run compile
```

**5. Configure and start the frontend**

```bash
cd ~/careva
nano .env
```

```env
REACT_APP_API_BASE_URL_LOCAL=http://localhost:5050/api/v1
REACT_APP_API_BASE_URL_LIVE=http://YOUR_SERVER_IP_OR_DOMAIN:5050/api/v1
```

```bash
npm install
npm run build
```

Serve the static build, e.g. with `serve`:

```bash
sudo npm install -g serve
serve -s build -l 3000
```

Or copy `build/` into an Nginx web root and serve it directly (recommended for production — see **A3**).

### A3. Running as a persistent service (recommended for real deployments)

Manually running `npm run compile` / `serve` in a terminal will die when the terminal closes. For a real server, use one of these:

**Option 1 — PM2 (cross-platform, simplest)**

```bash
npm install -g pm2

# API
cd api
pm2 start dist/server.js --name careva-api

# Frontend (if serving via `serve` instead of Nginx)
cd ..
pm2 start "serve -s build -l 3000" --name careva-frontend

pm2 save
pm2 startup   # follow the printed instructions to enable auto-start on boot
```

**Option 2 — systemd (Linux only)**

Create `/etc/systemd/system/careva-api.service`:

```ini
[Unit]
Description=Careva API
After=network.target

[Service]
WorkingDirectory=/path/to/careva/api
ExecStart=/usr/bin/node dist/server.js
Restart=always
EnvironmentFile=/path/to/careva/api/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now careva-api
```

For the frontend on Linux, prefer serving the `build/` folder directly through **Nginx** rather than `serve`:

```nginx
server {
    listen 80;
    server_name your-domain.com;
    root /path/to/careva/build;
    index index.html;
    location / {
        try_files $uri /index.html;
    }
    location /api/ {
        proxy_pass http://localhost:5050/;
    }
}
```

**Option 3 — Windows Service**

Use [NSSM](https://nssm.cc/) to wrap `node dist/server.js` (API) and `serve -s build -l 3000` (frontend) as native Windows services, so they start automatically on boot and restart on failure.

---

## B. Docker deployment (Windows or Linux)

The repo already includes a `Dockerfile` for the frontend, one for the API (`api/Dockerfile`), and a `docker-compose.yml` that builds both.

**1. Install Docker**

- Windows: install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (includes Compose).
- Linux: install [Docker Engine](https://docs.docker.com/engine/install/) and the Compose plugin.

**2. Set up environment files**

```bash
cd careva
cp api/.env.example api/.env
# edit api/.env with your DB, Cloudinary, and Gmail credentials
```

Also create/edit the root `.env` for the frontend build (`REACT_APP_API_BASE_URL_LOCAL` / `_LIVE`).

**3. Build and run**

```bash
docker compose up --build
```

This starts:
- `backend` on port `5050`
- `frontend` on port `3000`

Your PostgreSQL database is **not** included in `docker-compose.yml** — point `DATABASE_URL` in `api/.env` at your existing Postgres instance (local, managed, or a separate container you run yourself).

**4. Run in the background**

```bash
docker compose up --build -d
docker compose logs -f     # view logs
docker compose down        # stop everything
```

**5. Apply the database schema**

Run this once against your database (from your host machine, with the same `DATABASE_URL` set, or by exec-ing into the backend container):

```bash
docker compose exec backend npx prisma db push
```

---

## 6. Post-deployment checklist

- [ ] Visit the frontend URL and confirm the homepage loads
- [ ] Sign up as a patient and confirm the verification/notification emails arrive
- [ ] Upload a profile image and confirm it lands in Cloudinary
- [ ] Create an admin row directly in the `Auth` table (`role = admin`) — admins are not created via the sign-up form (see `README.md`)
- [ ] Confirm `REACT_APP_API_BASE_URL_LIVE` on the frontend matches wherever the API actually ends up running
- [ ] If deploying behind a domain, set up HTTPS (e.g. via [Let's Encrypt](https://letsencrypt.org/) + Nginx/Certbot on Linux, or IIS/Cloudflare on Windows)
