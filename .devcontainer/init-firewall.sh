#!/bin/bash
# Adapted from Anthropic's reference devcontainer:
# https://github.com/anthropics/claude-code/tree/main/.devcontainer/init-firewall.sh
# (c) Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial
# Terms of Service; see LICENSE-anthropic-reference.md.
#
# Changes: the allowlist adds Codex/OpenAI and the Bedrock and STS endpoints of the
# configured phi-guard region, and drops the Sentry and Statsig telemetry hosts. The
# region comes from the root-owned managed settings (sudo resets the caller's
# environment), and it is validated before any rule is flushed. Hosts that share
# an IP no longer abort the script (ipset add -exist).
set -euo pipefail  # Exit on error, undefined vars, and pipeline failures
IFS=$'\n\t'       # Stricter word splitting

SETTINGS=/etc/claude-code/managed-settings.d/phi-guard.json

# Prints the IPv4 addresses of the A records for a host.
resolve_a() {
    dig +noall +answer A "$1" | awk '$4 == "A" {print $5}'
}

# 0. Validate the region BEFORE touching any rule: a placeholder or typo must not
# leave the container with a flushed or half-built firewall.
REGION=$(jq -er '.pluginConfigs["phi-guard@phi-guard"].options.aws_region' "$SETTINGS") || {
    echo "ERROR: cannot read aws_region from $SETTINGS"
    exit 1
}
if [[ ! "$REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]]; then
    echo "ERROR: aws_region '$REGION' in $SETTINGS is not an AWS region name (still a placeholder?)"
    exit 1
fi
BEDROCK_HOST="bedrock-runtime.${REGION}.amazonaws.com"
STS_HOST="sts.${REGION}.amazonaws.com"
for host in "$BEDROCK_HOST" "$STS_HOST"; do
    if [ -z "$(resolve_a "$host")" ]; then
        echo "ERROR: $host does not resolve, check aws_region in $SETTINGS"
        exit 1
    fi
done

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
# Allow outbound DNS
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
# Allow inbound DNS responses
iptables -A INPUT -p udp --sport 53 -j ACCEPT
# Allow outbound SSH
iptables -A OUTPUT -p tcp --dport 22 -j ACCEPT
# Allow inbound SSH responses
iptables -A INPUT -p tcp --sport 22 -m state --state ESTABLISHED -j ACCEPT
# Allow localhost
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

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
# only here, so restart the container when Bedrock or STS calls start failing:
# postStartCommand re-runs this script in a fresh network namespace.
for domain in \
    "registry.npmjs.org" \
    "api.anthropic.com" \
    "claude.ai" \
    "claude.com" \
    "platform.claude.com" \
    "api.openai.com" \
    "chatgpt.com" \
    "auth.openai.com" \
    "$BEDROCK_HOST" \
    "$STS_HOST" \
    "marketplace.visualstudio.com" \
    "vscode.blob.core.windows.net" \
    "update.code.visualstudio.com"; do
    echo "Resolving $domain..."
    ips=$(resolve_a "$domain")
    if [ -z "$ips" ]; then
        echo "ERROR: Failed to resolve $domain"
        exit 1
    fi

    while read -r ip; do
        if [[ ! "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
            echo "ERROR: Invalid IP from DNS for $domain: $ip"
            exit 1
        fi
        echo "Adding $ip for $domain"
        ipset add allowed-domains "$ip" -exist
    done < <(echo "$ips")
done

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

# Set default policies to DROP first
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

# First allow established connections for already approved traffic
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Then allow only specific outbound traffic to allowed domains
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

# Explicitly REJECT all other outbound traffic for immediate feedback
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

echo "Firewall configuration complete"
echo "Verifying firewall rules..."
if curl --connect-timeout 5 https://example.com >/dev/null 2>&1; then
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
if ! curl --connect-timeout 5 -s -o /dev/null "https://$BEDROCK_HOST"; then
    echo "ERROR: Firewall verification failed - unable to reach https://$BEDROCK_HOST"
    exit 1
else
    echo "Firewall verification passed - able to reach https://$BEDROCK_HOST as expected"
fi
