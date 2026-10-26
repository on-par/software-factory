# factoryd image (#3685). Secrets are runtime-only (compose env_file); none are baked here.
FROM node:24-slim
ARG FACTORY_VERSION
RUN test -n "$FACTORY_VERSION" || (echo "FACTORY_VERSION build arg is required (pin a release)" && exit 1)
RUN apt-get update && apt-get install -y --no-install-recommends git gh ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@on-par/factory-cli@${FACTORY_VERSION}" && npm cache clean --force
USER node
WORKDIR /home/node
ENV FACTORYD_HOST=127.0.0.1
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FACTORYD_PORT||8787)+'/capabilities').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["sh", "-c", "exec factory daemon run --port \"${FACTORYD_PORT:-8787}\" --update-mode manual"]
