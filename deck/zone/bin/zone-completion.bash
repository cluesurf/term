# Shell completion for zone, for bash and zsh.
#
#   source /path/to/zone/bin/zone-completion.bash
#
# Paths come from `zone deep`, which reads the declaration in force for the
# current directory, so completion is always what this project actually
# declares rather than a list somebody has to keep in step.
#
# A path is the one thing that gets mistyped and the one thing the tool can
# complete perfectly.

_zone_complete() {
  local commands="bind lift load list read save send files seal code show test toss deep"
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  if [ "$COMP_CWORD" = 1 ]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return
  fi

  case "${COMP_WORDS[1]}" in
    load|list|read|save|test)
      # Only the first argument after the command is a zone path.
      if [ "$COMP_CWORD" = 2 ]; then
        COMPREPLY=( $(compgen -W "$(zone deep 2>/dev/null)" -- "$cur") )
      fi
      ;;
    seal)
      [ "$COMP_CWORD" = 2 ] && COMPREPLY=( $(compgen -W "make show toss" -- "$cur") )
      ;;
    code)
      [ "$COMP_CWORD" = 2 ] && COMPREPLY=( $(compgen -W "save show list toss" -- "$cur") )
      ;;
    send)
      [ "$COMP_CWORD" = 2 ] && COMPREPLY=( $(compgen -W "wrangler digitalocean" -- "$cur") )
      ;;
  esac
}

if [ -n "${ZSH_VERSION:-}" ]; then
  autoload -U +X bashcompinit && bashcompinit
fi

complete -F _zone_complete zone
