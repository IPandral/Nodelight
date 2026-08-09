# Security Policy

## Supported versions

The latest release on the default branch is supported with security fixes. Older releases may not receive patches.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use the repository's **Security** tab and choose **Report a vulnerability** to send a private GitHub security advisory to the maintainers.

Include a clear description, affected version, reproduction steps, and the potential impact. Please allow reasonable time for a fix before public disclosure.

Nodelight intentionally avoids the Docker socket and uses read-only host mounts. Changes that expand host access, networking exposure, or credentials handling receive particular scrutiny.
