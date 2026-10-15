#!/bin/sh
# Claude Code status line for the sandbox, set in claude-code/phi-guard.json. Claude pipes
# a JSON session summary to stdin, which this line has no use for.
cat > /dev/null
printf 'NO PHI · personal subscription sandbox · firewall: %s\n' "${PHI_GUARD_FIREWALL:-web}"
