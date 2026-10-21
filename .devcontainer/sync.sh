#!/usr/bin/env bash
# Moves the repo between the host and the sandbox as git bundles, so neither side ever
# runs git against a repository the other side controls.
#   sync.sh in <branch-or-commit>  builds or refreshes the clone from /nophi/in/host.bundle
#   sync.sh out                    writes /nophi/out/sandbox.bundle from the clone
# Runs as the unprivileged user inside the container, through `devcontainer exec`, from bin/nophi.
set -euo pipefail

# The overrides serve the host-side unit tests.
workspace=${WORKSPACE:-/workspace}
in=${NOPHI_IN:-/nophi/in}
out=${NOPHI_OUT:-/nophi/out}

git_ws() { git -C "$workspace" "$@"; }

sync_in() {
  local ref=$1 first=0 before moved
  [ -e "$workspace/.git" ] || git init -q "$workspace"
  # Branch tracking needs a configured remote: a fetch from a bare bundle path sets none up.
  git_ws remote set-url host "$in/host.bundle" 2>/dev/null || git_ws remote add host "$in/host.bundle"
  git_ws rev-parse -q --verify HEAD >/dev/null || first=1
  before=$(git_ws for-each-ref --format='%(refname) %(objectname)' refs/remotes/host)
  # HEAD is fetched explicitly so a detached host checkout arrives too.
  git_ws fetch -q host '+refs/heads/*:refs/remotes/host/*' '+refs/tags/*:refs/tags/*' '+HEAD:refs/remotes/host/HEAD'
  if [ "$first" = 1 ]; then
    if git_ws show-ref -q --verify "refs/remotes/host/$ref"; then
      git_ws checkout -q -b "$ref" --track "host/$ref"
    else
      git_ws checkout -q "$ref"
    fi
    return
  fi
  # Later runs leave the checkout and the local branches alone: that is where the sandbox work lives.
  moved=$(comm -13 <(printf '%s\n' "$before") \
    <(git_ws for-each-ref --format='%(refname) %(objectname)' refs/remotes/host) |
    awk '{ sub("refs/remotes/host/", "", $1) } $1 != "HEAD" { print $1 }' | tr '\n' ' ')
  [ -z "$moved" ] || echo "nophi: the host moved: ${moved% }"
}

sync_out() {
  # HEAD is listed so work on a detached checkout comes back too.
  if git_ws bundle create -q "$out/sandbox.bundle.tmp" --branches --tags HEAD; then
    mv "$out/sandbox.bundle.tmp" "$out/sandbox.bundle"
  else
    rm -f "$out/sandbox.bundle.tmp"
    echo "nophi: warning: nothing in $workspace to send back to the host" >&2
  fi
}

case ${1:-} in
  in) sync_in "${2:?usage: sync.sh in <branch-or-commit>}" ;;
  out) sync_out ;;
  *) echo "usage: sync.sh in <branch-or-commit> | out" >&2; exit 2 ;;
esac
