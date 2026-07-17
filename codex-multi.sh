#!/usr/bin/env bash
set -uo pipefail

home_root="${CODEX_MULTI_HOME:-$HOME/.codex-accounts}"
default_accounts=(zxc aiasio)

usage() {
  cat <<'EOF'
Codex multi-account launcher (Linux/macOS/WSL)

Usage:
  ./codex-multi.sh init [account ...]
  ./codex-multi.sh login <account>
  ./codex-multi.sh logout <account>
  ./codex-multi.sh status [account]
  ./codex-multi.sh list
  ./codex-multi.sh path <account>
  ./codex-multi.sh doctor
  ./codex-multi.sh run <account> [codex arguments ...]
  ./codex-multi.sh remote-start <account>
  ./codex-multi.sh remote-stop <account>
  ./codex-multi.sh remote-pair <account>
  ./codex-multi.sh <account> [codex arguments ...]
EOF
}

validate_account() {
  local account="${1:-}"
  if [[ ! "$account" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ || "$account" == "." || "$account" == ".." ]]; then
    printf "Invalid account name '%s'.\n" "$account" >&2
    return 1
  fi
}

account_home() {
  validate_account "$1" || return 1
  printf '%s/%s\n' "$home_root" "$1"
}

init_account() {
  local account="$1" path
  path="$(account_home "$account")" || return 1
  if [[ ! -d "$path" ]]; then
    mkdir -p -- "$path"
    printf 'Created %s at %s\n' "$account" "$path" >&2
  fi
}

list_account_names() {
  local path
  [[ -d "$home_root" ]] || return 0
  for path in "$home_root"/*; do
    [[ -d "$path" ]] || continue
    basename -- "$path"
  done | sort
}

require_account() {
  local action="$1" account="${2:-}"
  if [[ -z "$account" ]]; then
    printf "'%s' requires an account name.\n" "$action" >&2
    return 1
  fi
  validate_account "$account"
}

run_for_account() {
  local account="$1"
  shift
  local path
  path="$(account_home "$account")" || return 1
  init_account "$account" >/dev/null || return 1
  CODEX_HOME="$path" codex "$@"
}

has_pair_command() {
  codex remote-control --help 2>&1 | grep -Eq '^[[:space:]]+pair[[:space:]]+'
}

action="${1:-help}"
if (($# > 0)); then shift; fi

case "$action" in
  help|-h|--help)
    usage
    ;;
  init)
    accounts=("$@")
    if ((${#accounts[@]} == 0)); then accounts=("${default_accounts[@]}"); fi
    for account in "${accounts[@]}"; do init_account "$account" || exit 1; done
    ;;
  list)
    if [[ ! -d "$home_root" ]]; then
      printf 'No accounts initialized under %s\n' "$home_root"
      exit 0
    fi
    while IFS= read -r account; do
      printf '%s\t%s/%s\n' "$account" "$home_root" "$account"
    done < <(list_account_names)
    ;;
  path)
    require_account "$action" "${1:-}" || exit 1
    account_home "$1"
    ;;
  login)
    require_account "$action" "${1:-}" || exit 1
    run_for_account "$1" login --device-auth
    ;;
  logout)
    require_account "$action" "${1:-}" || exit 1
    run_for_account "$1" logout
    ;;
  status)
    if (($# > 0)); then
      accounts=("$1")
    elif [[ -d "$home_root" ]]; then
      accounts=()
      while IFS= read -r account; do
        accounts+=("$account")
      done < <(list_account_names)
    else
      accounts=()
    fi
    if ((${#accounts[@]} == 0)); then
      printf 'No accounts initialized. Run: ./codex-multi.sh init\n'
      exit 0
    fi
    result=0
    for account in "${accounts[@]}"; do
      printf '[%s]\n' "$account"
      run_for_account "$account" login status || result=$?
    done
    exit "$result"
    ;;
  doctor)
    command -v codex >/dev/null 2>&1 || { printf 'Codex CLI was not found.\n' >&2; exit 1; }
    printf 'CLI:          %s\n' "$(codex --version)"
    printf 'Executable:   %s\n' "$(command -v codex)"
    printf 'Account root: %s\n' "$home_root"
    printf 'Platform:     %s\n' "$(uname -srm)"
    printf 'Remote host:  Unix host detected\n'
    if has_pair_command; then
      printf 'Pair command: available\n'
    else
      printf 'Pair command: not available in this CLI version\n'
    fi
    ;;
  run)
    require_account "$action" "${1:-}" || exit 1
    account="$1"
    shift
    run_for_account "$account" "$@"
    ;;
  remote-start)
    require_account "$action" "${1:-}" || exit 1
    run_for_account "$1" remote-control start --json
    ;;
  remote-stop)
    require_account "$action" "${1:-}" || exit 1
    run_for_account "$1" remote-control stop --json
    ;;
  remote-pair)
    require_account "$action" "${1:-}" || exit 1
    if ! has_pair_command; then
      printf "This Codex CLI does not provide 'remote-control pair'. Update Codex and retry.\n" >&2
      exit 1
    fi
    run_for_account "$1" remote-control pair
    ;;
  *)
    validate_account "$action" || exit 1
    run_for_account "$action" "$@"
    ;;
esac
