FROM node:22-slim

# System deps
RUN apt-get update && apt-get install -y \
    curl \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI (Linux binary via npm global — avoids PATH conflicts)
RUN npm install -g @anthropic-ai/claude-code

# Copy Claudbot
WORKDIR /claudbot
COPY package.json .
COPY claudbot.mjs .
COPY providers/ ./providers/
COPY .claudbot/ ./.claudbot/
COPY mcp-servers/ ./mcp-servers/

# Install MCP server dependencies
RUN cd mcp-servers/claudbot-exec && npm install --omit=dev

# Workspace: isolated directory Claude operates in
RUN mkdir /workspace

# Default working directory for user files
WORKDIR /workspace

ENTRYPOINT ["node", "/claudbot/claudbot.mjs"]
