#!/bin/sh
# Installed as /usr/local/bin/claude in place of npm's link to the CLI, so every start
# goes through it. Server-managed settings from a Team or Enterprise login replace the
# managed settings file that enables phi-guard (ARCHITECTURE, "Org logins"), so the plugin
# and its options are loaded from the command line as well. Under the managed file the two
# load as one plugin and the hooks run once.
exec /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe \
  --plugin-dir /opt/phi-guard --settings /opt/phi-guard/claude-settings.json "$@"
