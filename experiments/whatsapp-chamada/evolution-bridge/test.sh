#!/usr/bin/env bash
set -euo pipefail
bridge_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$bridge_dir/../../.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf -- "$test_dir"' EXIT

docker build -t omni-evolution:2.3.7-presence.1 "$repo_dir/deploy/evolution"
docker build -t omni-evolution:2.3.7-chamada-poc "$bridge_dir"
docker run --rm --network none --entrypoint node omni-evolution:2.3.7-chamada-poc \
  --test /evolution/node_modules/baileys/lib/omni-chamada/bridge.test.mjs
cd -- "$bridge_dir/.."
CGO_ENABLED=0 "${CHAMADA_GO:-go}" test -c -o "$test_dir/interop-test" .
# Go e Node dentro do mesmo namespace SEM REDE: só loopback, sem credenciais ou
# volumes reais. O teste nunca consegue alcançar WhatsApp ou a Evolution em uso.
docker run --rm --network none \
  --mount "type=bind,source=$test_dir/interop-test,target=/tmp/interop-test,readonly" \
  -e CHAMADA_INTEROP_FIXTURE=on --entrypoint sh omni-evolution:2.3.7-chamada-poc -c '
    node /evolution/node_modules/baileys/lib/omni-chamada/interop.mjs > /tmp/fixture-ready &
    fixture_pid=$!
    trap "kill $fixture_pid 2>/dev/null || true" EXIT
    attempt=0
    until test -s /tmp/fixture-ready; do
      attempt=$((attempt + 1))
      if test "$attempt" -ge 50; then exit 1; fi
      sleep 0.1
    done
    /tmp/interop-test -test.run "^TestShadowInteropWithBaileys$" -test.v -test.timeout=20s
  '
