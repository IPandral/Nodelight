<p align="center">
  <img src="web/assets/nodelight-logo.png" width="180" alt="Nodelight logo">
</p>

<h1 align="center">Nodelight</h1>

Nodelight is a lightweight, self-hosted dashboard for a headless Ubuntu server. It shows live CPU, memory, per-drive capacity and I/O, network interfaces, temperatures, services, recent host events, processes, operating-system, and hardware information in one responsive page.

It runs as a single Docker container, has no external analytics, and uses read-only host mounts for normal monitoring. Physical-drive SMART access is optional and disabled by default because it requires additional device permissions. Nodelight is open source under the [MIT License](LICENSE).

Highlights include 24-hour and 30-day history, low-space warnings for every mounted filesystem, per-interface network totals and errors, service checks, webhook alerts with cooldowns, SMART health and scheduled self-tests, update checks, and a privacy-safe demo mode.

## Install a published release

Once this repository has a GitHub Release, GitHub Actions automatically publishes a multi-architecture image (x86_64 and ARM64) to GitHub Container Registry. This is the simplest way to install Nodelight on a server without cloning the source code.

1. Create a directory on the server and place `docker-compose.release.yml` and `.env.example` inside it. Rename `.env.example` to `.env`.
2. Set your server name and a strong password in `.env`, then add the published image:

   ```dotenv
   NODELIGHT_IMAGE=ghcr.io/ipandral/computer-usage-dashboard:latest
   ```

3. Pull and run it:

   ```bash
   docker compose -f docker-compose.release.yml pull
   docker compose -f docker-compose.release.yml up -d
   ```

For predictable upgrades, pin a release tag such as `:v1.0.0` rather than `:latest`. After publishing the first release, confirm the package is public in the repository's **Packages** settings so anonymous Docker pulls work.

## Copy-ready Docker Compose

To run the latest published image without cloning this repository, create a `compose.yaml` file on the server with the following contents:

```yaml
services:
  nodelight:
    image: ghcr.io/ipandral/computer-usage-dashboard:latest
    container_name: nodelight
    restart: unless-stopped
    ports:
      - "8080:8080"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      DASHBOARD_NAME: Home Server
      DASHBOARD_USERNAME: admin
      DASHBOARD_PASSWORD: change-this-to-a-strong-password
      TZ: Australia/Perth
      HOST_PROC: /host/proc
      HOST_SYS: /host/sys
      HOST_ETC: /host/etc
      HOST_ROOT: /host/root
      HOST_VAR_LOG: /host/var/log
      DATA_DIR: /data
      SMART_ENABLED: "false"
      SERVICE_CHECKS: "SSH=tcp:host.docker.internal:22;Docker=process:dockerd"
      ALERT_WEBHOOK_URL: ""
      ALERT_WEBHOOK_TYPE: generic
      ALERT_COOLDOWN_MINUTES: "30"
      GITHUB_REPOSITORY: IPandral/Computer-usage-dashboard
      DEMO_MODE: "false"
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /etc:/host/etc:ro
      - /:/host/root:ro
      - /var/log:/host/var/log:ro
      - nodelight-data:/data
    read_only: true
    tmpfs:
      - /tmp:size=16m,mode=1777
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    pids_limit: 100
    mem_limit: 128m
    cpus: 0.50

volumes:
  nodelight-data:
```

Pull the image and start the dashboard:

```bash
docker pull ghcr.io/ipandral/computer-usage-dashboard:latest
docker compose up -d
```

Open `http://YOUR_SERVER_IP:8080` and sign in with the credentials in the Compose file. Replace the example password before starting the container.

## Storage and history

Nodelight lists every non-virtual filesystem the host exposes, not only `/`. A drive becomes a **Watch** warning at 80% full and **Critical** at 95% full.

It records CPU, RAM, root-disk, download, and upload metrics once a minute. The named `nodelight-data` Docker volume keeps that history through container recreation and stores up to 30 days. The dashboard can switch between the last 24 hours and the full 30-day view. A new install starts collecting immediately, so the charts fill in over time. `docker compose down -v` intentionally removes this history volume.

Mounted filesystems and physical disks are different views. Capacity monitoring automatically includes every host mount, including a separately mounted 10 TB Exos. SMART health can also show an unmounted physical disk, but only after that device is explicitly made visible to the container as described below.

## Alerts, services, events, and privacy

Set `SERVICE_CHECKS` to semicolon-separated named checks. A `process` check matches an exact executable name, `tcp` attempts a connection, and `http` performs an HTTP(S) request and accepts a 2xx or 3xx response:

```dotenv
SERVICE_CHECKS=SSH=tcp:host.docker.internal:22;Nginx=process:nginx;Site=http:http://host.docker.internal/health
```

The supplied Compose files map `host.docker.internal` to Ubuntu's host gateway. `127.0.0.1` inside a check means the Nodelight container itself, not the Ubuntu host. To monitor a selected Docker workload, point a TCP or HTTP check at its published port or health endpoint. Nodelight performs these checks without mounting `/var/run/docker.sock`; it never needs control of the Docker daemon. The read-only `/var/log` mount supplies recent boot, shutdown, out-of-memory, and failed-service events when Ubuntu records them in the standard host logs. Log availability varies with the Ubuntu logging configuration and rotation policy.

To send alerts, place a webhook URL in your private `.env` file and leave it out of Git:

```dotenv
ALERT_WEBHOOK_URL=https://alerts.example.invalid/nodelight
ALERT_WEBHOOK_TYPE=generic
ALERT_COOLDOWN_MINUTES=30
```

Choose `generic`, `discord`, or `slack` for `ALERT_WEBHOOK_TYPE`. Generic receivers get a JSON `nodelight.alert` event; Discord and Slack receive their native text-message shape. An empty URL disables outbound alerts. The cooldown prevents a continuing fault from generating a message every polling cycle. Use `DEMO_MODE=true` before a public demonstration or screenshot; it hides identifying details such as the hostname, IP addresses, serial numbers, mount paths, and process names. Demo mode is a display/privacy feature, not an authentication boundary.

`GITHUB_REPOSITORY=IPandral/Computer-usage-dashboard` selects the repository used by the version panel. Published images embed their source tag or branch and commit SHA, while locally built images use `APP_VERSION` from `.env`.

## SMART health for every physical disk

The image includes `smartctl`, but `SMART_ENABLED` defaults to `false`. The normal Compose configuration has no raw-device access and continues to drop every Linux capability. This is the safest mode when you only need capacity and performance monitoring.

For SMART data and scheduled self-tests, first identify whole-disk device names on Ubuntu. Map the disk itself (`/dev/sdb`), not one of its partitions (`/dev/sdb1`):

```bash
lsblk -d -o NAME,SIZE,MODEL,SERIAL,TRAN
```

For example, if the Exos is `/dev/sdb` and the system disk is `/dev/sda`, copy [`compose.smart.example.yaml`](compose.smart.example.yaml) to `compose.smart.yaml` and edit its device list. Its contents are:

```yaml
services:
  nodelight:
    # SMART mode uses root with the image's normal data group so history stays
    # writable if SMART mode is later disabled. Every capability remains
    # dropped except SYS_RAWIO, and the filesystem stays read-only.
    user: "0:1000"
    group_add:
      - "${SMART_DISK_GID:-6}"
    environment:
      SMART_ENABLED: "true"
      SMARTCTL_PATH: smartctl
      SMART_DEVICE_ROOT: /host/dev
    cap_add:
      - SYS_RAWIO
    devices:
      - /dev/sda:/host/dev/sda:rwm
      - /dev/sdb:/host/dev/sdb:rwm
      # Add each additional whole disk, for example:
      # - /dev/nvme0n1:/host/dev/nvme0n1:rwm
```

Confirm the numeric group in `.env` before starting the override:

```bash
getent group disk
```

For example, `disk:x:6:` means `SMART_DISK_GID=6` is correct.

Start both files, then verify that `smartctl` can open the mapped disks:

```bash
docker compose -f compose.yaml -f compose.smart.yaml up -d
docker compose -f compose.yaml -f compose.smart.yaml exec nodelight smartctl -a /host/dev/sdb
```

If you use this repository's published Compose file, replace `compose.yaml` above with `docker-compose.release.yml`. Add a new `devices:` entry whenever a new physical disk is installed. Docker's device mapping makes each selected `/dev` node visible and grants its device-cgroup permissions; `SYS_RAWIO` permits the required disk-control operations. This is intentionally narrower than mounting the Docker socket or setting `privileged: true`, but raw-disk access is still sensitive. Only enable it for a trusted image on a trusted network.

The dashboard reports model, serial, health result, temperature, power-on time, wear/remaining life when the drive exposes it, and SMART error indicators. SATA, SAS, and NVMe drives expose different fields, so a missing attribute does not necessarily mean a fault. Some USB bridges and hardware RAID controllers hide SMART data or require controller-specific `smartctl` options that Nodelight cannot infer.

After SMART is working, use the dashboard to schedule short tests daily or weekly and extended tests monthly. Automatic tests start disabled so enabling SMART access cannot unexpectedly begin a lengthy scan. The form is prefilled with Sunday at 02:00 for short tests and day 1 at 03:00 for extended tests; enable and save the schedules you want. A scheduled run applies to every discovered SMART-capable disk. The schedule is stored in `/data/settings.json`, survives container recreation through `nodelight-data`, and uses the container's `TZ` setting. Saving or changing a schedule requires dashboard authentication.

An extended self-test on a large HDD such as a 10 TB Seagate Exos can take many hours and adds disk activity. Check the drive's estimate with `smartctl -c /dev/sdX`, keep the server powered on, and schedule the test outside backups, scrubs, CCTV recording peaks, or other heavy I/O. A SMART **PASSED** result is useful evidence, but it is not a replacement for backups.

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
| `DATA_DIR` | `/data` | Internal path for persistent metric history; keep this at `/data` with the named volume mounted |
| `APP_VERSION` | `development` | Version shown for a local build; GitHub builds embed the source ref and commit SHA |
| `SERVICE_CHECKS` | none | Semicolon-separated named `process`, `tcp`, or `http` checks |
| `ALERT_WEBHOOK_URL` | none | Private webhook destination; an empty value disables outbound alerts |
| `ALERT_WEBHOOK_TYPE` | `generic` | Webhook payload format: `generic`, `discord`, or `slack` |
| `ALERT_COOLDOWN_MINUTES` | `30` | Minimum interval before repeating the same alert |
| `GITHUB_REPOSITORY` | `IPandral/Computer-usage-dashboard` | Public GitHub repository checked for available releases |
| `DEMO_MODE` | `false` | Redact identifying host information in the dashboard and API |
| `SMART_ENABLED` | `false` | Enable physical-drive SMART polling and self-test schedules; raw-device permissions are also required |
| `SMARTCTL_PATH` | `smartctl` | Path to the `smartctl` executable inside the container |
| `SMART_DEVICE_ROOT` | `/host/dev` | Container directory containing explicitly mapped host disks |
| `SMART_DISK_GID` | `6` | Numeric Ubuntu `disk` group used by the optional SMART override; confirm it with `getent group disk` |
| `NODELIGHT_IMAGE` | not set | Published image to pull with `docker-compose.release.yml`, for example `ghcr.io/OWNER/REPOSITORY:v1.0.0` |

## What it reads

The Compose file mounts `/proc`, `/sys`, `/etc`, `/var/log`, and `/` into the container as read-only paths. Nodelight uses them to report real host metrics and recent host events instead of the container's own limits. The container drops Linux capabilities, runs as an unprivileged user, uses a read-only filesystem, and does **not** mount the Docker socket.

The SMART override is the one exception: it opts selected physical device nodes into the container and adds `SYS_RAWIO`. Review that section before enabling it. Nodelight never needs `privileged: true`.

Some virtual machines do not expose temperature sensors. In that case the dashboard displays "Not exposed" and continues normally.

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

The [publish-image workflow](.github/workflows/publish-image.yml) automatically builds and publishes a new multi-architecture `:latest` image whenever a change reaches `main`. It uses the same proven pattern as the RustyDB project: build, test, publish, then retain a commit-specific image tag.

To create a versioned GitHub Release as well, create a semantic version tag from the current `main` commit and push it:

```bash
git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

The workflow publishes these images to GitHub Container Registry:

| Release | Published image tags |
| --- | --- |
| Push to `main` | `latest`, `main`, and a commit-specific `sha-...` tag |
| `v1.2.3` tag | `v1.2.3`, `1.2.3`, `1.2`, and `1`, plus a GitHub Release |
| `v1.2.3-rc.1` | `v1.2.3-rc.1`, `1.2.3-rc.1` (never `latest`) |

Images include an SBOM and, when the repository is public, a GitHub build-provenance attestation. A GitHub Release is created only after the versioned image build and publication succeed, so users never see a release pointing to a failed container build.

If the first publishing run is denied, check the repository's **Settings > Actions > General > Workflow permissions** and allow workflows to read and write packages. Organizations can also restrict package publishing centrally.

## Contributing and support

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md), rather than in public issues. Bug reports and feature requests are welcome through the GitHub issue templates.

