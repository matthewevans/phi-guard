# Adapted from Anthropic's reference devcontainer:
# https://github.com/anthropics/claude-code/tree/main/.devcontainer
# (c) Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial
# Terms of Service; see LICENSE-anthropic-reference.md.
#
# Changes: Claude Code and Codex CLI are pinned and installed as root into the
# root-owned /usr/local prefix (the agent cannot rewrite its own CLI), phi-guard and
# the managed agent config are copied in root-owned, and the oh-my-zsh and git-delta
# downloads are dropped. Codex runs with danger-full-access (see
# codex/managed_config.toml), so the image carries no bubblewrap.
# Build context is the repo root (see devcontainer.json).
FROM node:20

ARG TZ
ENV TZ="$TZ"

ARG CLAUDE_CODE_VERSION=2.1.296
ARG CODEX_VERSION=0.162.1

# Basic development tools, plus iptables/ipset for the firewall.
RUN apt-get update && apt-get install -y --no-install-recommends \
  aggregate \
  dnsutils \
  gh \
  iproute2 \
  ipset \
  iptables \
  jq \
  less \
  nano \
  procps \
  sudo \
  zsh \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Both CLIs land in the root-owned npm prefix, where user node cannot modify them.
RUN npm install -g \
  @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
  @openai/codex@${CODEX_VERSION} \
  && npm cache clean --force

# The plugin's runtime files only, root-owned and read-only for user node. Claude
# loads it as a directory marketplace; Codex runs its dist/ bundles as managed hooks.
COPY .claude-plugin /opt/phi-guard/.claude-plugin
COPY .codex-plugin /opt/phi-guard/.codex-plugin
COPY hooks /opt/phi-guard/hooks
COPY dist /opt/phi-guard/dist
RUN chmod -R u=rwX,go=rX /opt/phi-guard

# Enforced agent config. Replace the REPLACE_IN_PART_2_ placeholders (here, in
# phi-guard.json and in aws-config) with the real guardrail values.
COPY .devcontainer/claude-code/phi-guard.json /etc/claude-code/managed-settings.d/phi-guard.json
COPY .devcontainer/codex/requirements.toml .devcontainer/codex/managed_config.toml /etc/codex/
RUN chmod 0644 /etc/claude-code/managed-settings.d/phi-guard.json /etc/codex/*.toml

# Create workspace and config directories and set permissions
RUN mkdir -p /workspace /home/node/.claude /home/node/.codex /home/node/.aws && \
  chown -R node:node /workspace /home/node/.claude /home/node/.codex /home/node/.aws
COPY --chown=node:node .devcontainer/aws-config /home/node/.aws/config

# Copy and set up firewall script
COPY .devcontainer/init-firewall.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/init-firewall.sh && \
  echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/node-firewall && \
  chmod 0440 /etc/sudoers.d/node-firewall

WORKDIR /workspace

# Set `DEVCONTAINER` environment variable to help with orientation
ENV DEVCONTAINER=true

# Codex runs each hook command through the passwd login shell of user node with -c
# (observed: bash, whatever SHELL says). `bash -c` reads no startup files. SHELL and
# ZDOTDIR serve interactive terminals: ZDOTDIR points zsh at root-owned /etc/zsh, so
# interactive zsh does not read dotfiles that user node (or the agent) writes. That
# also means ~/.zshrc is ignored and zsh keeps no history (HISTFILE is unset). None
# of this protects the Codex hooks.
ENV SHELL=/bin/zsh
ENV ZDOTDIR=/etc/zsh
ENV EDITOR=nano
ENV VISUAL=nano

# The CLIs are pinned, and nothing optional leaves the container.
ENV DISABLE_AUTOUPDATER=1
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# phi-guard config for Codex, which has no plugin options. Placeholders until Part 2
# (the same values as phi-guard.json, which the Claude hooks read).
ENV PHI_GUARD_GUARDRAIL_ID=REPLACE_IN_PART_2_GuardrailId
ENV PHI_GUARD_GUARDRAIL_VERSION=REPLACE_IN_PART_2_GuardrailVersion
ENV PHI_GUARD_AWS_REGION=REPLACE_IN_PART_2_AwsRegion
ENV PHI_GUARD_AWS_PROFILE=phi-guard

USER node
