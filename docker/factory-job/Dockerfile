# syntax=docker/dockerfile:1
# One-shot factory job image (#3902): `factory job --repo <owner/name> --issue <n>` in a disposable container.
# Built by the `image` job in .github/workflows/publish.yml; no secret is ever an ARG or ENV here.
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm-slim
ARG FACTORY_VERSION
# Keep in step with CLAUDE_CODE_VERSION in scripts/factory-run.sh (scripts/factory-job-image.test.ts checks).
ARG CLAUDE_CODE_VERSION=2.1.308
# gh comes from its GitHub release .deb, not the cli.github.com apt repo: that repo keeps only the
# newest gh, so an apt version pin breaks as soon as gh ships a release. Bump all three ARGs together
# (hashes from gh_<version>_checksums.txt on the release).
ARG GH_VERSION=2.76.2
ARG GH_SHA256_AMD64=2958aa0cf0a2a82790913058667bf5a8b67fe0ecdd0d13d5ffe78d90adb04602
ARG GH_SHA256_ARM64=8a4728b3619fc4b21ad74334a9642776a45afe3a473364141d31c09b0452e40d
RUN test -n "$FACTORY_VERSION" \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tini \
 && arch="$(dpkg --print-architecture)" \
 && case "$arch" in amd64) sha="$GH_SHA256_AMD64" ;; arm64) sha="$GH_SHA256_ARM64" ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac \
 && curl -fsSL -o /tmp/gh.deb "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.deb" \
 && echo "${sha}  /tmp/gh.deb" | sha256sum -c - \
 && apt-get install -y --no-install-recommends /tmp/gh.deb \
 && test "$(gh --version | head -1 | cut -d' ' -f3)" = "$GH_VERSION" \
 && rm -f /tmp/gh.deb \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@on-par/factory-cli@${FACTORY_VERSION}" \
 && npm cache clean --force
USER node
WORKDIR /home/node
ENV FACTORY_HEADLESS=1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["factory", "--help"]
