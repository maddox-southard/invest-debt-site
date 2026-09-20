# Base image for Cursor Cloud agents (referenced by .cursor/environment.json).
# Mirrors the local toolchain: Node 22 and npm, Python 3 with venv. Cursor
# clones the repo and layers its own runtime on top, so this image never COPYs
# project files; dependencies are installed by the `install` command in
# environment.json at Build time. git and sudo are required by Cursor (the
# clone runs inside this image); gh, infisical, curl, jq, dig and openssl cover
# GitHub work, the secrets vault (scripts/vault.mjs) and the ops scripts.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    WRANGLER_SEND_METRICS=false \
    INFISICAL_DISABLE_UPDATE_CHECK=true \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git sudo curl ca-certificates gnupg jq dnsutils openssl unzip \
      python3 python3-venv python3-pip \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && curl -1sLf 'https://artifacts-cli.infisical.com/setup.deb.sh' | bash \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh infisical \
 && rm -rf /var/lib/apt/lists/*

# Vercel CLI for deploy inspection and `vercel env` (authenticated per session
# through VERCEL_TOKEN in the environment; never `vercel login`).
RUN npm install -g vercel && npm cache clean --force

# Non-root user with passwordless sudo, the layout Cursor's reference
# Dockerfile uses. environment.json runs everything as this user.
RUN id -u ubuntu >/dev/null 2>&1 || useradd -m -s /bin/bash ubuntu \
 && usermod -aG sudo ubuntu \
 && echo "ubuntu ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ubuntu \
 && chmod 0440 /etc/sudoers.d/ubuntu

RUN corepack enable

USER ubuntu

