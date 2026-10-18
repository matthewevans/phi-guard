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

# Enforced agent config. The guardrail options are added to phi-guard.json at the end of
# this file. The AWS profile they name comes from the engineer's own ~/.aws/config, which
# devcontainer.json mounts read-only.
COPY .devcontainer/claude-code/phi-guard.json /etc/claude-code/managed-settings.d/phi-guard.json
COPY .devcontainer/codex/requirements.toml .devcontainer/codex/managed_config.toml /etc/codex/
RUN chmod 0644 /etc/claude-code/managed-settings.d/phi-guard.json /etc/codex/*.toml

# Visible sandbox markers: the Claude status line (named in phi-guard.json) and an
# interactive shell banner and prompt prefix, which both system rc files source. Neither
# touches non-interactive shells, where the hook commands run.
COPY .devcontainer/statusline.sh .devcontainer/sandbox-banner.sh /opt/phi-guard/
RUN chmod 0755 /opt/phi-guard/statusline.sh && chmod 0644 /opt/phi-guard/sandbox-banner.sh && \
  echo '. /opt/phi-guard/sandbox-banner.sh' | tee -a /etc/zsh/zshrc /etc/bash.bashrc > /dev/null

# Create workspace and config directories and set permissions
RUN mkdir -p /workspace /home/node/.claude /home/node/.codex && \
  chown -R node:node /workspace /home/node/.claude /home/node/.codex

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

# The guardrail the hooks call, from the host environment through the build args in
# devcontainer.json, so this public repo commits no company values. This block comes last
# so that changing a value rebuilds only these layers. A container keeps the image it was
# created from: after changing a value, recreate it (nophi --rebuild).
ARG PHI_GUARD_GUARDRAIL_ID
ARG PHI_GUARD_GUARDRAIL_VERSION
ARG PHI_GUARD_AWS_REGION
ARG PHI_GUARD_AWS_PROFILE=phi-guard

# Every way of building the image passes through this check, so none ships empty options.
# It prints variable names only, never values.
RUN missing=''; \
  for name in PHI_GUARD_GUARDRAIL_ID PHI_GUARD_GUARDRAIL_VERSION PHI_GUARD_AWS_REGION; do \
    [ -n "$(printenv "$name")" ] || missing="$missing $name"; \
  done; \
  [ -z "$missing" ] || { echo "phi-guard: set these on the host before building:$missing (see README, Testing on a work machine)" >&2; exit 1; }

# Claude reads the options from its managed settings. The --arg names are the plugin's
# userConfig keys. The redirect keeps the file root-owned 0644.
RUN settings=/etc/claude-code/managed-settings.d/phi-guard.json && \
  contents=$(jq \
    --arg guardrail_id "$PHI_GUARD_GUARDRAIL_ID" \
    --arg guardrail_version "$PHI_GUARD_GUARDRAIL_VERSION" \
    --arg aws_region "$PHI_GUARD_AWS_REGION" \
    --arg aws_profile "$PHI_GUARD_AWS_PROFILE" \
    '.pluginConfigs["phi-guard@phi-guard"].options = $ARGS.named' "$settings") && \
  printf '%s\n' "$contents" > "$settings"

# Codex has no plugin options, so it reads the same values from the environment.
ENV PHI_GUARD_GUARDRAIL_ID=$PHI_GUARD_GUARDRAIL_ID
ENV PHI_GUARD_GUARDRAIL_VERSION=$PHI_GUARD_GUARDRAIL_VERSION
ENV PHI_GUARD_AWS_REGION=$PHI_GUARD_AWS_REGION
ENV PHI_GUARD_AWS_PROFILE=$PHI_GUARD_AWS_PROFILE

USER node
