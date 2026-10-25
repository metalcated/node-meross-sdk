FROM node:24-bookworm-slim AS sdk
WORKDIR /sdk
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY test ./test
COPY scripts ./scripts
COPY tsconfig.json eslint.config.mjs LICENSE README.md CHANGELOG.md ./
RUN npm run lint \
    && npm run build \
    && npm run typecheck \
    && node scripts/run-tests.cjs \
    && mkdir /sdk-package \
    && npm pack --ignore-scripts --pack-destination /sdk-package

FROM sdk AS runtime-dependencies
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim AS installer
# The installer is intentionally outside the Homey runtime dependency tree.
RUN npm install --prefix /opt/homey-cli --ignore-scripts --no-audit --no-fund homey@4.6.1
ENV NODE_PATH=/opt/homey-cli/node_modules
ENV PATH=/opt/homey-cli/node_modules/.bin:${PATH}
WORKDIR /app
COPY --from=runtime-dependencies /sdk/node_modules ./node_modules
COPY --from=sdk /sdk-package /sdk-package
RUN mkdir node_modules/node-meross-sdk \
    && tar -xzf /sdk-package/node-meross-sdk-0.6.0-alpha.tgz --strip-components=1 -C node_modules/node-meross-sdk
COPY homey-app/ ./
# Retain the compiled checkout outside /app for a byte-for-byte package check.
COPY --from=sdk /sdk/dist /sdk/dist
COPY --from=sdk /sdk/package.json /sdk/package.json
RUN npm run lint \
    && npm test \
    && npm run validate \
    && npm run build \
    && MEROSS_SDK_BUILD_ROOT=/sdk npm run check:package
ENV HOMEY_HOME=/auth
CMD ["sh", "-c", "if [ -n \"${HOMEY_ID:-}\" ]; then homey select --id \"$HOMEY_ID\"; else homey select; fi && node scripts/install-app.cjs"]
