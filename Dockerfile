# Hedwig: one image that runs the web server and the worker (`npm start`), or either one alone.
# Debian-based Node: the bundler ships native bindings that need glibc; Alpine and Nix-built Node images fail the build.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
COPY --from=build /app/build ./build
COPY --from=build /app/build-worker ./build-worker
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/scripts ./scripts
EXPOSE 3000
# web + worker in one container. Split them with `node build/index.js` and `node build-worker/index.js` (one worker only).
CMD ["node", "scripts/start.js"]
