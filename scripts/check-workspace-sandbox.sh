#!/usr/bin/env bash
# Measures the confinement of the natsumi-workspace container (ADR 0011, ADR 0019) on throwaway containers and volumes.
#
#   NATSUMI_CHECK_PROJECT=natsumi-check NATSUMI_CHECK_OVERRIDE=path/to/override.yaml scripts/check-workspace-sandbox.sh
#
# The override must give both services image names of their own (never the :local tags a deployment uses) and the
# images must already be built with it. The script starts natsumi and natsumi-workspace under its own project name
# with a throwaway self-signed certificate and fictional memory, sends commands to the runner from inside natsumi
# (the path the model's tool uses), prints PASS or FAIL per check, and removes the project's containers and volumes
# at the end. Nothing here reaches outside the host.
#
# ADR 0019 did away with the list of allowed commands, so this checks the shape of the container rather than its
# contents: what it can reach, what it may write, what it is limited to, and that a command outlives its answer.
set -euo pipefail

project="${NATSUMI_CHECK_PROJECT:?set NATSUMI_CHECK_PROJECT to a project name used only for this check}"
override="${NATSUMI_CHECK_OVERRIDE:?set NATSUMI_CHECK_OVERRIDE to a compose file that renames the images}"
[ "$project" != natsumi ] || { echo "refusing the project name natsumi" >&2; exit 2; }
command -v openssl >/dev/null || { echo "openssl is required for the throwaway certificate" >&2; exit 2; }

cd "$(dirname "$0")/.."
work="$(mktemp -d "$PWD/.local/workspace-check.XXXXXX")"
cat > "$work/check.yaml" <<'YAML'
services:
  natsumi:
    ports: !reset []
YAML
compose=(docker compose -p "$project" -f compose.yaml -f "$override" -f "$work/check.yaml")

if "${compose[@]}" config --images | grep -q ':local$'; then
  echo "refusing: an image would use a :local tag; rename every image in the override" >&2
  exit 2
fi

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=natsumi.example.net \
  -keyout "$work/tls-key.pem" -out "$work/tls-cert.pem" >/dev/null 2>&1
printf 'fictional-client-secret\n' > "$work/github-client-secret"
chmod 0644 "$work"/*.pem "$work/github-client-secret"
export NATSUMI_TLS_CERT="$work/tls-cert.pem" NATSUMI_TLS_KEY="$work/tls-key.pem" NATSUMI_GITHUB_CLIENT_SECRET_FILE="$work/github-client-secret"
export NATSUMI_CONFIG="$PWD/config.example.json"

"${compose[@]}" up -d --no-build --wait --wait-timeout 180 natsumi natsumi-workspace >/dev/null

# Fictional memory, written by natsumi as it would be.
"${compose[@]}" exec -T natsumi node -e '
  const { writeFileSync } = require("node:fs");
  writeFileSync("/data/memory/合言葉.md", "# 合言葉\n\n- 2026-01-01: 合言葉は SYNTHETIC-HERON-208\n", { mode: 0o600 });'

failures=0
report() { if [ "$2" = pass ]; then echo "PASS $1"; else echo "FAIL $1: $3"; failures=$((failures + 1)); fi; }

# Sends a command to the runner from inside natsumi and judges the raw answer `r` with a JavaScript expression.
probe='
import { createConnection } from "node:net";
const [command, predicate] = process.argv.slice(1);
const socket = createConnection("/run/natsumi-workspace/runner.sock");
let text = "";
socket.on("connect", () => socket.write(JSON.stringify({ command }) + "\n"));
socket.on("data", chunk => { text += chunk; });
socket.on("error", error => { console.log("fail", "no runner: " + error.code); });
socket.on("close", () => {
  if (!text) return;
  const r = JSON.parse(text);
  const ok = Function("r", "return (" + predicate + ");")(r);
  console.log(ok ? "pass" : "fail", JSON.stringify({ ...r, stdout: r.stdout.slice(0, 300), stderr: r.stderr.slice(0, 300) }));
});'
check() {
  local name="$1" command="$2" predicate="$3" verdict detail
  read -r verdict detail < <("${compose[@]}" exec -T natsumi node --input-type=module -e "$probe" "$command" "$predicate")
  report "$name" "$verdict" "$detail"
}

inspect() { docker inspect -f "$1" "$("${compose[@]}" ps -q natsumi-workspace)"; }
host_check() {
  local name="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then report "$name" pass; else report "$name" fail "got [$actual], want [$expected]"; fi
}

# The shape of the container, as the host has it.
host_check "network mode is none" "$(inspect '{{.HostConfig.NetworkMode}}')" none
host_check "root filesystem is read-only" "$(inspect '{{.HostConfig.ReadonlyRootfs}}')" true
host_check "every capability is dropped" "$(inspect '{{json .HostConfig.CapDrop}}')" '["ALL"]'
host_check "no-new-privileges is set" "$(inspect '{{json .HostConfig.SecurityOpt}}')" '["no-new-privileges:true"]'
host_check "pids are limited" "$(inspect '{{.HostConfig.PidsLimit}}')" 256
host_check "memory is limited, with no swap" "$(inspect '{{.HostConfig.Memory}}:{{.HostConfig.MemorySwap}}')" "1073741824:1073741824"
host_check "cpu is limited" "$(inspect '{{.HostConfig.NanoCpus}}')" 2000000000
host_check "only the four writable places, the list of agents and the socket are mounted" \
  "$(inspect '{{range .Mounts}}{{.Destination}}:{{.RW}} {{end}}' | tr ' ' '\n' | sed '/^$/d' | sort | tr '\n' ' ')" \
  "/home/natsumi:true /manual/agents:false /memory/.git:false /memory:true /run/natsumi-workspace:true /work:true "
host_check "the container itself is given no environment beyond PATH" \
  "$(inspect '{{range .Config.Env}}{{.}} {{end}}' | tr ' ' '\n' | sed '/^$/d;s/=.*//' | sort | tr '\n' ' ')" "PATH "

# What a command sees from the inside.
check "commands run as a non-root user" 'grep "^Uid:" /proc/self/status' '/^Uid:\s+[1-9]\d*\s/.test(r.stdout)'
check "no effective capabilities and no new privileges" 'grep -E "^(CapEff|NoNewPrivs):" /proc/self/status' \
  '/CapEff:\s+0{16}/.test(r.stdout) && /NoNewPrivs:\s+1/.test(r.stdout)'
check "only the loopback interface exists" 'ls /sys/class/net' 'r.stdout === "lo\n"'
# SHLVL and _ are bash's own, set after the runner has handed over the five of ADR 0019.
check "commands see only PATH, PWD, HOME, LANG and TZ" 'cat /proc/self/environ' \
  'r.stdout.split("\0").filter(Boolean).map(v => v.split("=")[0]).filter(v => v !== "SHLVL" && v !== "_").sort().join(",") === "HOME,LANG,PATH,PWD,TZ"'
check "the working directory is /work" 'pwd' 'r.stdout === "/work\n"'
check "commands run under bash" 'echo $BASH_VERSION' '/^\d/.test(r.stdout)'

# The secrets, the state and the configuration of natsumi are not in this container at all.
check "secrets, SQLite, Pi state and config are not visible" \
  'ls /run/secrets /data /var/lib/natsumi-pi /etc/natsumi 2>&1; find / \( -path /proc -o -path /sys \) -prune -o \( -name "*.sqlite*" -o -name auth.json -o -name "*.jsonl" -o -name "natsumi_*" -o -name "*.pem" -o -name "*.key" \) -print 2>/dev/null' \
  '!/^\//m.test(r.stdout) && (r.stdout.match(/No such file/g) || []).length === 4'

# The four writable places of ADR 0019, and nothing else.
check "memory is readable and writable" 'rg -n 合言葉 /memory && echo "- 2026-01-02: 追記" >> /memory/合言葉.md' \
  'r.exitCode === 0 && r.stdout.includes("SYNTHETIC-HERON-208")'
check "the history of memory is not writable" 'git -C /memory log --oneline | head -1; echo x > /memory/.git/x' \
  '/Read-only file system/.test(r.stderr)'
check "work and home are writable and can run what is put there" \
  'printf "#!/bin/bash\necho from-work\n" > /work/t.sh && chmod +x /work/t.sh && /work/t.sh && echo ok > /home/natsumi/t && cat /home/natsumi/t' \
  'r.exitCode === 0 && r.stdout === "from-work\nok\n"'
# The manual of ADR 0036: in the image, and the list of agents natsumi wrote on its start, both only for reading.
check "the manual and the list of agents are readable and not writable" \
  'head -1 /manual/INDEX.md /manual/agents/INDEX.md; echo x > /manual/x; echo x > /manual/agents/x' \
  '/# マニュアル/.test(r.stdout) && /# 頼める相手/.test(r.stdout) && (r.stderr.match(/Read-only file system/g) || []).length === 2'
check "root is not writable" 'echo x > /usr/bin/x; echo x > /x' 'r.exitCode !== 0 && (r.stderr.match(/Read-only file system/g) || []).length === 2'
check "the socket directory cannot be changed" 'echo x > /run/natsumi-workspace/x; find /run/natsumi-workspace -delete' \
  'r.exitCode !== 0 && /Permission denied/.test(r.stderr)'
# Set as configured. It is not a boundary: an interpreter still runs what is in /tmp (ADR 0019).
check "/tmp is a small tmpfs, mounted noexec" 'grep " /tmp " /proc/mounts; echo ok > /tmp/t && cat /tmp/t' \
  'r.exitCode === 0 && /tmpfs \/tmp tmpfs[^\n]*noexec/.test(r.stdout) && /size=131072k/.test(r.stdout) && r.stdout.endsWith("ok\n")'

# The new guarantee of ADR 0019, and the reverse of ADR 0011's: the answer comes back and the command lives on.
marker=SYNTHETIC-SANDBOX-LIVE-8801
started=$(date +%s)
check "an endless command answers at the response limit without being stopped" \
  "echo before; sleep 900; : $marker" \
  'r.stillRunning === true && r.exitCode === null && r.stdout === "before\n" && r.running >= 1 && r.responseLimitMs === 60000'
elapsed=$(( $(date +%s) - started ))
if [ "$elapsed" -ge 55 ] && [ "$elapsed" -le 90 ]; then
  report "the answer came at the response limit" pass
else
  report "the answer came at the response limit" fail "took ${elapsed}s, want about 60"
fi
check "the process it started is still alive afterwards" "ps -eo args | grep -c '[${marker:0:1}]${marker:1}'" \
  'r.exitCode === 0 && Number(r.stdout.trim()) >= 1'
check "natsumi can end it herself with kill" "pkill -f '[${marker:0:1}]${marker:1}'; sleep 1; ps -eo args | grep -c '[${marker:0:1}]${marker:1}' || true" \
  'Number(r.stdout.trim()) === 0'
check "output is cut at the limit" 'i=0; while [ $i -lt 20000 ]; do echo 0123456789012345678901234567890123456789; i=$((i+1)); done' \
  'r.stdoutTruncated === true && Buffer.byteLength(r.stdout) <= 65536 * 3 && r.exitCode === 0'
check "the runner still answers after a cut" ':' 'r.exitCode === 0'

# The same path the tool takes, including the text the model reads and the line about what memory holds.
read -r verdict detail < <("${compose[@]}" exec -T natsumi node --input-type=module -e '
  import { WorkspaceShell } from "/app/dist/src/server/workspace-shell.js";
  const shell = new WorkspaceShell({ socketPath: "/run/natsumi-workspace/runner.sock", timeZone: "Asia/Tokyo",
    memoryChanges: async () => "合言葉.md（変更）" });
  const outcome = await shell.run("rg -n 合言葉 /memory; date +%Z");
  console.log(outcome.ok && /終了コード 0/.test(outcome.text) && outcome.text.includes("SYNTHETIC-HERON-208")
    && outcome.text.includes("JST") && /記憶の変更: 合言葉\.md（変更）/.test(outcome.text) ? "pass" : "fail", JSON.stringify(outcome));')
report "the tool reads memory through the runner, in the owner time zone" "$verdict" "$detail"

# Last, because it fills the container: the children are short-lived so the next command can fork again.
check "the pids limit stops a fork loop" 'i=0; while [ $i -lt 400 ]; do sleep 5 & i=$((i+1)); done; wait' \
  '/fork|Resource temporarily unavailable/.test(r.stderr)'
check "the runner still answers afterwards" 'echo alive' 'r.exitCode === 0 && r.stdout === "alive\n"'

echo "failures: $failures"
[ "$failures" -eq 0 ]
