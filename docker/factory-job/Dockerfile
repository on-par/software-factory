# syntax=docker/dockerfile:1
# One-shot factory job image (#3902): `factory job --repo <owner/name> --issue <n>` in a disposable container.
# Secrets (GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN) arrive at run time through the environment, never as build args.
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm-slim
ARG FACTORY_VERSION
# Keep in step with CLAUDE_CODE_VERSION in scripts/factory-run.sh.
ARG CLAUDE_CODE_VERSION=2.1.308
ARG GH_VERSION=2.92.0
RUN test -n "$FACTORY_VERSION" \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tini gnupg \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends "gh=${GH_VERSION}" \
 && apt-get purge -y gnupg \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@on-par/factory-cli@${FACTORY_VERSION}" \
 && npm cache clean --force
USER node
WORKDIR /home/node
ENV FACTORY_HEADLESS=1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["factory", "--help"]
