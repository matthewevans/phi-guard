#!/bin/bash
# Adapted from Anthropic's reference devcontainer:
# https://github.com/anthropics/claude-code/tree/main/.devcontainer/init-firewall.sh
# (c) Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial
# Terms of Service; see LICENSE-anthropic-reference.md.
#
# Changes: the first argument selects a mode, and any other value exits before a rule
# changes. "web" allows every public IPv4 address and rejects the private and internal
# ranges, and keeps the reference DNS and SSH accepts. "strict" is the reference
# allowlist, which adds Codex/OpenAI and the Bedrock endpoint of the configured phi-guard
# region and drops the Sentry, Statsig and VS Code hosts. Strict mode also drops the
# blanket SSH accept (SSH reaches only allowlisted addresses) and binds DNS to the
# nameservers in /etc/resolv.conf. In strict mode the region comes from the root-owned
# managed settings (sudo resets the caller's environment), and it is validated, with the
# nameservers, before any rule is flushed. Hosts that share an IP no longer abort the
# script (ipset add -exist). Optional hosts are derived from the mounted ~/.npmrc
# (CodeArtifact npm registries) and the comma-separated list passed as $2
# (PHI_GUARD_EXTRA_HOSTS). Nothing in the container performs SSO or calls STS, so neither
# has a host. The first run pins both arguments in a root-owned file, and a later run
# with different ones exits before a rule changes, because the agent can run this script
# through sudo with any argv. Sourcing this file defines the functions only, so tests can
# call them.
#
# Usage: init-firewall.sh web|strict [extra-hosts]
set -euo pipefail  # Exit on error, undefined vars, and pipeline failures
IFS=$'\n\t'       # Stricter word splitting

SETTINGS=/etc/claude-code/managed-settings.d/phi-guard.json
NPMRC=/home/node/.npmrc
# The two overrides exist for the unit tests. They are safe in the container because
# sudo's env_reset (the node:20 Debian default) drops them and the sudoers rule has no
# SETENV, so the agent cannot pass them.
PIN=${FIREWALL_ARGS:-/etc/phi-guard/firewall-args}
RESOLV_CONF=${RESOLV_CONF:-/etc/resolv.conf}
REGION_RE='^[a-z]{2}(-[a-z]+)+-[0-9]+$'
IPV4_RE='^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'
HOST_RE='^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$'
CODEARTIFACT_HOST_RE='^[a-z0-9][a-z0-9-]*-[0-9]{12}\.d\.codeartifact\.[a-z0-9-]+\.amazonaws\.com$'

# Prints the IPv4 addresses of the A records for a host.
resolve_a() {
    dig +noall +answer A "$1" | awk '$4 == "A" {print $5}'
}

# Adds the A records of a host to the allowlist. Returns 1 if the host has none.
allow_host() {
    local host=$1 ips ip
    echo "Resolving $host..."
    ips=$(resolve_a "$host")
    [ -n "$ips" ] || return 1
    while read -r ip; do
        if [[ ! "$ip" =~ $IPV4_RE ]]; then
            echo "ERROR: Invalid IP from DNS for $host: $ip"
            exit 1
        fi
        echo "Adding $ip for $host"
        ipset add allowed-domains "$ip" -exist
    done <<<"$ips"
}

# The two functions below print one validated hostname per line and warn on stderr
# about entries they skip. A missing or unreadable file yields nothing.

# The hosts of CodeArtifact registry= and @scope:registry= URLs in an npmrc. Only those
# lines are read, because the file also holds auth tokens.
codeartifact_hosts_from_npmrc() {
    local file=$1 url host
    [ -r "$file" ] || return 0
    while read -r url; do
        url=${url//[\"\']/}
        if [[ "$url" =~ ^https://([^/:]+)(:[0-9]+)?(/|$) ]]; then
            host=${BASH_REMATCH[1]}
            if [[ "$host" =~ $CODEARTIFACT_HOST_RE ]]; then
                echo "$host"
            fi
        fi
    done < <(sed -n -E 's/^[[:space:]]*(@[^:=[:space:]]+:)?registry[[:space:]]*=[[:space:]]*//p' "$file" | tr -d '\r' | sort -u)
}

# A comma-separated list of hostnames (PHI_GUARD_EXTRA_HOSTS). Only plain hostnames
# pass: no scheme, port, path or wildcard.
extra_hosts_from_list() {
    local entry
    while IFS=$' \t' read -r entry; do
        [ -n "$entry" ] || continue
        if [[ "$entry" =~ $HOST_RE ]]; then
            echo "$entry"
        else
            echo "WARNING: ignoring invalid PHI_GUARD_EXTRA_HOSTS entry '$entry'" >&2
        fi
    done < <(printf '%s\n' "$1" | tr ',' '\n')
}

# The IPv4 nameserver addresses of a resolv.conf file, one per line.
resolvers_from_resolv_conf() {
    local ns
    while read -r ns; do
        if [[ "$ns" =~ $IPV4_RE ]]; then
            echo "$ns"
        fi
    done < <(awk '$1 == "nameserver" {print $2}' "$1" 2>/dev/null)
}

[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0

# 0a. Validate the mode BEFORE touching any rule: an unknown value must fail closed.
MODE=${1:-}
if [[ "$MODE" != web && "$MODE" != strict ]]; then
    echo "ERROR: firewall mode '$MODE' is not web or strict"
    exit 1
fi

# 0a'. Pin the arguments. The first run records them, and a later run with different
# ones exits before any rule changes, so neither the mode nor the allowlist can be
# widened through sudo. Identical arguments continue and refresh the allowlist.
ARGS=$(printf '%s\n%s' "$MODE" "${2:-}")
if [ -e "$PIN" ]; then
    if [ "$(cat "$PIN")" != "$ARGS" ]; then
        echo "ERROR: firewall arguments differ from the ones this container was created with"
        exit 1
    fi
else
    printf '%s\n' "$ARGS" >"$PIN"
    chmod 0644 "$PIN"
fi

# 0b. Strict mode validates the region BEFORE touching any rule: a typo must not leave
# the container with a flushed or half-built firewall. The image build writes the region
# into $SETTINGS and refuses an empty one. Web mode reads no region.
if [ "$MODE" = strict ]; then
    REGION=$(jq -er '.pluginConfigs["phi-guard@phi-guard"].options.aws_region' "$SETTINGS") || {
        echo "ERROR: cannot read aws_region from $SETTINGS"
        exit 1
    }
    if [[ ! "$REGION" =~ $REGION_RE ]]; then
        echo "ERROR: aws_region '$REGION' in $SETTINGS is not an AWS region name"
        exit 1
    fi
    BEDROCK_HOST="bedrock-runtime.${REGION}.amazonaws.com"
    if [ -z "$(resolve_a "$BEDROCK_HOST")" ]; then
        echo "ERROR: $BEDROCK_HOST does not resolve, check aws_region in $SETTINGS"
        exit 1
    fi

    # DNS is allowed only to the resolvers in resolv.conf. Finding none after the flush
    # would leave egress open, so this too happens before any rule.
    RESOLVERS=$(resolvers_from_resolv_conf "$RESOLV_CONF")
    if [ -z "$RESOLVERS" ]; then
        echo "ERROR: no IPv4 nameserver in $RESOLV_CONF"
        exit 1
    fi

    # Optional hosts are derived here too, so a bad entry is reported before any rule
    # changes. They are best effort: one that fails to resolve is skipped with a warning.
    optional_hosts=$({
        codeartifact_hosts_from_npmrc "$NPMRC"
        extra_hosts_from_list "${2:-}"
    } | sort -u)
fi

# 1. Extract Docker DNS info BEFORE any flushing
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

# Flush existing rules and delete existing ipsets
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X
ipset destroy allowed-domains 2>/dev/null || true

# 2. Selectively restore ONLY internal Docker DNS resolution
if [ -n "$DOCKER_DNS_RULES" ]; then
    echo "Restoring Docker DNS rules..."
    iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
    iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
    echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
else
    echo "No Docker DNS rules to restore"
fi

# First allow DNS and localhost before any restrictions
if [ "$MODE" = strict ]; then
    # DNS only to the container's resolvers (replies ride on ESTABLISHED). No blanket SSH:
    # SSH reaches only the allowlist and the host network.
    while read -r ns; do
        iptables -A OUTPUT -p udp --dport 53 -d "$ns" -j ACCEPT
        iptables -A OUTPUT -p tcp --dport 53 -d "$ns" -j ACCEPT
    done <<<"$RESOLVERS"
else
    # Allow outbound DNS
    iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
    # Allow inbound DNS responses
    iptables -A INPUT -p udp --sport 53 -j ACCEPT
    # Allow outbound SSH
    iptables -A OUTPUT -p tcp --dport 22 -j ACCEPT
    # Allow inbound SSH responses
    iptables -A INPUT -p tcp --sport 22 -m state --state ESTABLISHED -j ACCEPT
fi
# Allow localhost
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

if [ "$MODE" = strict ]; then
    # Create ipset with CIDR support
    ipset create allowed-domains hash:net

    # Fetch GitHub meta information and aggregate + add their IP ranges
    echo "Fetching GitHub IP ranges..."
    gh_ranges=$(curl -s https://api.github.com/meta)
    if [ -z "$gh_ranges" ]; then
        echo "ERROR: Failed to fetch GitHub IP ranges"
        exit 1
    fi

    if ! echo "$gh_ranges" | jq -e '.web and .api and .git' >/dev/null; then
        echo "ERROR: GitHub API response missing required fields"
        exit 1
    fi

    echo "Processing GitHub IPs..."
    while read -r cidr; do
        if [[ ! "$cidr" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]]; then
            echo "ERROR: Invalid CIDR range from GitHub meta: $cidr"
            exit 1
        fi
        echo "Adding GitHub range $cidr"
        ipset add allowed-domains "$cidr"
    done < <(echo "$gh_ranges" | jq -r '(.web + .api + .git)[]' | aggregate -q)

    # Resolve and add other allowed domains. AWS endpoint IPs rotate and DNS is resolved
    # only here, so restart the container when Bedrock calls start failing:
    # postStartCommand re-runs this script in a fresh network namespace. Web mode has no
    # such list, so this applies to strict mode only.
    for domain in \
        "registry.npmjs.org" \
        "api.anthropic.com" \
        "claude.ai" \
        "claude.com" \
        "platform.claude.com" \
        "api.openai.com" \
        "chatgpt.com" \
        "auth.openai.com" \
        "$BEDROCK_HOST"; do
        allow_host "$domain" || {
            echo "ERROR: Failed to resolve $domain"
            exit 1
        }
    done

    while read -r host; do
        [ -n "$host" ] || continue
        allow_host "$host" || echo "WARNING: optional host $host does not resolve, skipping"
    done <<<"$optional_hosts"
fi

# Get host IP from default route
HOST_IP=$(ip route | grep default | cut -d" " -f3)
if [ -z "$HOST_IP" ]; then
    echo "ERROR: Failed to detect host IP"
    exit 1
fi

HOST_NETWORK=$(echo "$HOST_IP" | sed "s/\.[0-9]*$/.0\/24/")
echo "Host network detected as: $HOST_NETWORK"

# Set up remaining iptables rules
iptables -A INPUT -s "$HOST_NETWORK" -j ACCEPT
iptables -A OUTPUT -d "$HOST_NETWORK" -j ACCEPT

if [ "$MODE" = web ]; then
    # Reject the private and internal ranges. These come AFTER the host-network accepts
    # above, because Docker's host network usually sits inside 172.16.0.0/12.
    # 169.254.0.0/16 holds the cloud metadata service.
    for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
        iptables -A OUTPUT -d "$cidr" -j REJECT --reject-with icmp-admin-prohibited
    done
fi

# Set default policies to DROP first
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

# First allow established connections for already approved traffic
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

if [ "$MODE" = web ]; then
    # Everything that is not a private range above is public.
    iptables -A OUTPUT -j ACCEPT
else
    # Then allow only specific outbound traffic to allowed domains
    iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

    # Explicitly REJECT all other outbound traffic for immediate feedback
    iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited
fi

echo "Firewall configuration complete"
echo "Verifying firewall rules..."
if [ "$MODE" = web ]; then
    if curl --connect-timeout 3 http://169.254.169.254/ >/dev/null 2>&1; then
        echo "ERROR: Firewall verification failed - was able to reach the metadata address 169.254.169.254"
        exit 1
    else
        echo "Firewall verification passed - unable to reach 169.254.169.254 as expected"
    fi
elif curl --connect-timeout 5 https://example.com >/dev/null 2>&1; then
    echo "ERROR: Firewall verification failed - was able to reach https://example.com"
    exit 1
else
    echo "Firewall verification passed - unable to reach https://example.com as expected"
fi

# Verify GitHub API access
if ! curl --connect-timeout 5 https://api.github.com/zen >/dev/null 2>&1; then
    echo "ERROR: Firewall verification failed - unable to reach https://api.github.com"
    exit 1
else
    echo "Firewall verification passed - able to reach https://api.github.com as expected"
fi

# Verify Bedrock access. Any HTTP status counts: the request is unsigned, so the
# service answers 403 instead of timing out.
if [ "$MODE" = strict ]; then
    if ! curl --connect-timeout 5 -s -o /dev/null "https://$BEDROCK_HOST"; then
        echo "ERROR: Firewall verification failed - unable to reach https://$BEDROCK_HOST"
        exit 1
    else
        echo "Firewall verification passed - able to reach https://$BEDROCK_HOST as expected"
    fi
fi
