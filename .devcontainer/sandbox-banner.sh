# Sourced from /etc/zsh/zshrc and /etc/bash.bashrc (see the Dockerfile), so it works in
# both shells. Hook commands run in non-interactive shells and must print nothing, which
# would corrupt their JSON, so only interactive shells get the banner and the prompt.
case $- in
  *i*) ;;
  *) return 0 ;;
esac

printf 'NO PHI IN THIS SANDBOX.\n'
printf 'AI agents here use your personal Claude/ChatGPT subscription.\n'
printf 'Do not paste, open or query patient data. Prompts and command output are scanned as a safety net.\n'

# zsh reads no later file that resets PROMPT. Bash's ~/.bashrc, which runs after
# /etc/bash.bashrc, sets PS1 again, so bash adds the prefix before each prompt instead.
if [ -n "$BASH_VERSION" ]; then
  PROMPT_COMMAND='case $PS1 in "[NO PHI] "*) ;; *) PS1="[NO PHI] $PS1" ;; esac'"${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
else
  PS1="[NO PHI] $PS1"
fi
