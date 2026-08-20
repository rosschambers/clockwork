# clockwork: Bun server/worker + the pi CLI (the worker spawns `pi`).
# pi is a Node CLI (@earendil-works/pi-coding-agent), so the image needs Node too.
FROM oven/bun:1-debian

# git/openssh (worker clones/commits) + curl (Node setup) + xvfb & the Vulkan loader
# so the worker can RENDER Godot locally on the host GPU (studio's RTX 3060 via the
# nvidia-container-toolkit CDI passthrough). The NVIDIA ICD/driver libs are injected
# at runtime by the CDI spec; we set VK_ICD_FILENAMES to point the loader at them.
RUN apt-get update && apt-get install -y --no-install-recommends \
	git openssh-client ca-certificates curl \
	xvfb libvulkan1 vulkan-tools libgl1 \
	&& rm -rf /var/lib/apt/lists/*

# pi 0.84.2 needs a MODERN Node (its bundled undici calls markAsUncloneable, which
# debian's apt nodejs is too old for). Install Node 22 LTS from nodesource.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
	&& apt-get install -y --no-install-recommends nodejs \
	&& rm -rf /var/lib/apt/lists/*

# Install the pi CLI globally so `pi` is on PATH for the worker.
RUN npm install -g @earendil-works/pi-coding-agent@0.84.2

# Godot 4 (headless) so Implementation/QA cards can validate the game: open headless,
# run the test suite. This is the HEADLESS binary for logic/build checks — it does NOT
# render (rendering runs on studio's GPU via harness/render-on-studio.sh over SSH).
# unzip to fetch the official Linux build.
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
	&& curl -fsSL -o /tmp/godot.zip \
	   https://github.com/godotengine/godot/releases/download/4.3-stable/Godot_v4.3-stable_linux.x86_64.zip \
	&& unzip -q /tmp/godot.zip -d /usr/local/bin \
	&& mv /usr/local/bin/Godot_v4.3-stable_linux.x86_64 /usr/local/bin/godot \
	&& chmod +x /usr/local/bin/godot \
	&& rm /tmp/godot.zip \
	&& apt-get purge -y unzip && rm -rf /var/lib/apt/lists/*

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
