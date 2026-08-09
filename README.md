# Nodelight

Nodelight is a lightweight, self-hosted dashboard for a headless Ubuntu server. It shows live CPU, memory, storage, network, temperature, uptime, process, operating-system, and hardware information in one responsive page.

It runs as a single Docker container, has no external services or analytics, and only receives read-only access to the host information it needs. Nodelight is open source under the [MIT License](LICENSE).

## Install a published release

Once this repository has a GitHub Release, GitHub Actions automatically publishes a multi-architecture image (x86_64 and ARM64) to GitHub Container Registry. This is the simplest way to install Nodelight on a server without cloning the source code.

1. Create a directory on the server and place `docker-compose.release.yml` and `.env.example` inside it. Rename `.env.example` to `.env`.
2. Set your server name and a strong password in `.env`, then add the published image. Replace the placeholders with the GitHub repository owner and repository name:

   ```dotenv
   NODELIGHT_IMAGE=ghcr.io/OWNER/REPOSITORY:latest
   ```

3. Pull and run it:

   ```bash
   docker compose -f docker-compose.release.yml pull
   docker compose -f docker-compose.release.yml up -d
   ```

For predictable upgrades, pin a release tag such as `:v1.0.0` rather than `:latest`. After publishing the first release, confirm the package is public in the repository's **Packages** settings so anonymous Docker pulls work.

## Start it on Ubuntu

1. Copy the project folder to your server and enter it.
2. Create your settings file:

   ```bash
   cp .env.example .env
   nano .env
   ```

3. Set a strong `DASHBOARD_PASSWORD`, then start the dashboard:

   ```bash
   docker compose up -d --build
   ```

4. Find the server's address with `hostname -I`, then open:

   ```text
   http://YOUR_SERVER_IP:8080
   ```

Your browser will ask for the username and password from `.env`.

## Everyday commands

```bash
# See whether it is healthy
docker compose ps

# Follow logs
docker compose logs -f nodelight

# Restart it
docker compose restart nodelight

# Stop and remove the container
docker compose down

# Rebuild after updating the project
docker compose up -d --build

# Pull the published image selected in .env and restart with it
docker compose -f docker-compose.release.yml pull && docker compose -f docker-compose.release.yml up -d
```

## Settings

Edit `.env` before running Docker Compose.

| Setting | Default | Purpose |
| --- | --- | --- |
| `DASHBOARD_NAME` | `Home Server` | Friendly name shown in the dashboard |
| `DASHBOARD_USERNAME` | `admin` | Browser sign-in username |
| `DASHBOARD_PASSWORD` | none | Browser sign-in password; set this before exposing the port |
| `DASHBOARD_PORT` | `8080` | Port used to reach the dashboard |
| `TZ` | `UTC` | Time zone used by the container, such as `Australia/Perth` |
| `NODELIGHT_IMAGE` | not set | Published image to pull with `docker-compose.release.yml`, for example `ghcr.io/OWNER/REPOSITORY:v1.0.0` |

## What it reads

The Compose file mounts `/proc`, `/sys`, `/etc`, and `/` into the container as read-only paths. Nodelight uses them to report real host metrics instead of the container's own limits. The container drops Linux capabilities, runs as an unprivileged user, uses a read-only filesystem, and does **not** mount the Docker socket.

Some virtual machines do not expose temperature sensors. In that case the dashboard displays “Not exposed” and continues normally.

## Network safety

Keep the dashboard on your trusted home or office network. Do not forward port 8080 directly from the public internet. For remote access, place it behind HTTPS with a reverse proxy or access it through a VPN such as WireGuard or Tailscale.

If Ubuntu's firewall is enabled, you can allow only your local network (adjust the subnet first):

```bash
sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp
```

## Development

Nodelight uses only Node.js built-ins, so no package installation is needed.

```bash
npm test
npm start
```

Open `http://localhost:8080`. When host Linux files are unavailable, development mode falls back to metrics for the current machine.

## Publishing a release

The [publish-image workflow](.github/workflows/publish-image.yml) starts whenever a GitHub Release is published. Create a release with a semantic version tag such as `v1.0.0`; it publishes these tags to GitHub Container Registry:

| Release | Published image tags |
| --- | --- |
| `v1.2.3` | `v1.2.3`, `1.2.3`, `1.2`, `1`, `latest` |
| `v1.2.3-rc.1` | `v1.2.3-rc.1`, `1.2.3-rc.1` (never `latest`) |

Images include an SBOM and build provenance attestation. The workflow can also be started manually from the Actions tab when needed; manual runs only update `latest` when the **Also move the latest tag** option is selected.

If the first publishing run is denied, check the repository's **Settings → Actions → General → Workflow permissions** and allow workflows to read and write packages. Organizations can also restrict package publishing centrally.

## Contributing and support

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md), rather than in public issues. Bug reports and feature requests are welcome through the GitHub issue templates.
