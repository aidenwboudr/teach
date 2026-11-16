# Teach in a container: the server, Claude Code (tutors run as `claude -p` inside it) and Chromium (the tutor checks
# its diagrams with it). Your learning folder is mounted at /data; Claude Code's login lives in the /home/node
# volume, so it survives rebuilds. See compose.yaml and the README's Docker section.
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim
ARG CLAUDE_CODE_VERSION=latest
ARG WITH_CHROMIUM=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep $([ "$WITH_CHROMIUM" = 1 ] && echo chromium fonts-dejavu-core) \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force
COPY --chown=node:node . /app
RUN mkdir -p /data /state && chown node:node /data /state
USER node
ENV TEACH_DATA=/data \
    TEACH_STATE=/state \
    TEACH_HOST=0.0.0.0 \
    TEACH_PORT=7800 \
    TEACH_CHROME=/usr/bin/chromium
WORKDIR /data
EXPOSE 7800
VOLUME ["/data", "/state", "/home/node"]
ENTRYPOINT ["/app/docker/entrypoint.sh"]
