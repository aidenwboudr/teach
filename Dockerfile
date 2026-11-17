# Teach in a container: the server, Claude Code (tutors run as `claude -p` inside it) and Chromium (the tutor checks
# its diagrams with it). WITH_CODEX=1 / WITH_GEMINI=1 add OpenAI's Codex CLI / Google's Gemini CLI for TEACH_PROVIDER
# codex, local or gemini. Your learning folder is mounted at /data; the CLIs' logins live in the /home/node volume,
# so they survive rebuilds. See compose.yaml and the README's Docker section.
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim
ARG CLAUDE_CODE_VERSION=latest
ARG WITH_CHROMIUM=1
ARG WITH_CODEX=0
ARG WITH_GEMINI=0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep $([ "$WITH_CHROMIUM" = 1 ] && echo chromium fonts-dejavu-core) \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" $([ "$WITH_CODEX" = 1 ] && echo @openai/codex) $([ "$WITH_GEMINI" = 1 ] && echo @google/gemini-cli) \
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
