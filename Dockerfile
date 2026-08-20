# clockwork: Bun server/worker + the pi CLI (the worker spawns `pi`).
# pi is a Node CLI (@earendil-works/pi-coding-agent), so the image needs Node too.
FROM oven/bun:1-debian

# git/openssh (the worker clones/commits the project repo) + curl for the Node setup.
RUN apt-get update && apt-get install -y --no-install-recommends \
	git openssh-client ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*

# pi 0.84.2 needs a MODERN Node (its bundled undici calls markAsUncloneable, which
# debian's apt nodejs is too old for). Install Node 22 LTS from nodesource.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
	&& apt-get install -y --no-install-recommends nodejs \
	&& rm -rf /var/lib/apt/lists/*

# Install the pi CLI globally so `pi` is on PATH for the worker.
RUN npm install -g @earendil-works/pi-coding-agent@0.84.2

WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .

# pi provider config: point clockwork at frame's arbiter LOW ports so its work is
# background/preemptible (a Hugo request preempts it). Written to the container
# user's HOME where pi reads it. frame-dense-low -> :8185 (qwen3.8 dense).
RUN mkdir -p /root/.pi/agent && cp docker/pi-models.json /root/.pi/agent/models.json

RUN mkdir -p /data/db /data/repos /data/transcripts /data/artifacts /data/memory

EXPOSE 3000
ENV NODE_ENV=production
ENV HOME=/root
ENV CLOCKWORK_DB_PATH=/data/db/clockwork.sqlite
ENV CLOCKWORK_REPOS=/data/repos
ENV CLOCKWORK_TRANSCRIPTS=/data/transcripts
ENV CLOCKWORK_ARTIFACTS=/data/artifacts

ENTRYPOINT ["bun", "run", "src/index.ts"]
