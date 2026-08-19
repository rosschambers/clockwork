FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .
RUN bun build src/index.ts --target bun --outdir dist --minify
RUN mkdir -p /data/db /data/repos /data/transcripts /data/artifacts /data/memory
EXPOSE 3000
ENV NODE_ENV=production
ENV CLOCKWORK_DB_PATH=/data/db.sqlite
ENV CLOCKWORK_REPOS=/data/repos
ENV CLOCKWORK_TRANSCRIPTS=/data/transcripts
ENV CLOCKWORK_ARTIFACTS=/data/artifacts
ENTRYPOINT ["bun", "dist/index.js"]
