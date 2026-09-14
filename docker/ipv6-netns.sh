#!/bin/sh
# Holder of the network namespace that natsumi shares (network_mode: service:<this>), for the fixed-IPv6 layout.
#
# The network gets its IPv6 prefix from a router's advertisements, so Docker cannot assign a fixed address.
# Setting the interface token makes the address formed from that prefix end in NATSUMI_IPV6_TOKEN.
#
#   natsumi-ipv6-netns        set the token, wait for the address, then hold the namespace until stopped
#   natsumi-ipv6-netns check  exit 0 only while the address with the token is usable (for the healthcheck)
#
# Failures exit non-zero with a message instead of carrying on without the address.
set -eu

token="${NATSUMI_IPV6_TOKEN:-}"
dev="${NATSUMI_IPV6_DEVICE:-eth0}"
timeout="${NATSUMI_IPV6_TIMEOUT:-60}"

fail() {
  echo "natsumi-ipv6: $*" >&2
  exit 1
}

# The lower 64 bits of an IPv6 address (prefix length allowed), as 16 lowercase hex digits.
interface_id() {
  printf '%s\n' "$1" | awk -F/ '{
    n = split($1, halves, "::")
    nl = (halves[1] == "") ? 0 : split(halves[1], l, ":")
    nr = (n < 2 || halves[2] == "") ? 0 : split(halves[2], r, ":")
    out = ""
    for (i = 1; i <= nl; i++) out = out sprintf("%4s", l[i])
    for (i = 0; i < 8 - nl - nr; i++) out = out "0000"
    for (i = 1; i <= nr; i++) out = out sprintf("%4s", r[i])
    gsub(/ /, "0", out)
    print tolower(substr(out, 17, 16))
  }'
}

# Global addresses on the device ending in the token. Pass "-tentative" to skip ones still under DAD, or "dadfailed".
addresses_with_token() {
  want="$(interface_id "$token")"
  ip -6 -o addr show dev "$dev" scope global "$@" | awk '{ print $4 }' | while read -r address; do
    if [ "$(interface_id "$address")" = "$want" ]; then echo "$address"; fi
  done
}

case "$token" in
  ::*) ;;
  *) fail "NATSUMI_IPV6_TOKEN must be an interface identifier such as ::10" ;;
esac

if [ "${1:-hold}" = check ]; then
  [ -n "$(addresses_with_token -tentative)" ]
  exit
fi

[ "$(cat "/proc/sys/net/ipv6/conf/$dev/disable_ipv6" 2>/dev/null || echo 1)" = 0 ] \
  || fail "IPv6 is disabled on $dev; attach the network with driver option com.docker.network.endpoint.sysctls=net.ipv6.conf.IFNAME.disable_ipv6=0"
ip token set "$token" dev "$dev" || fail "cannot set the token on $dev (this container needs NET_ADMIN)"
[ "$(ip token get dev "$dev" | awk '{ print $2 }')" = "$token" ] || fail "the token on $dev did not take effect"

waited=0
while [ -z "$(addresses_with_token -tentative)" ]; do
  [ -z "$(addresses_with_token dadfailed)" ] || fail "the address ending in $token on $dev is already in use (duplicate address detection failed)"
  waited=$((waited + 1))
  [ "$waited" -lt "$timeout" ] || fail "no global address ending in $token on $dev after ${timeout}s; is a router advertising a prefix on this network?"
  sleep 1
done
echo "natsumi-ipv6: $(addresses_with_token -tentative | head -n 1) is ready on $dev"

trap 'exit 0' TERM INT
while :; do
  sleep 3600 &
  wait $!
done
