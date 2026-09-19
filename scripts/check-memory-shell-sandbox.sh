#!/usr/bin/env bash
# Measures the confinement of the natsumi-tools container (ADR 0011, ADR 0018) on throwaway containers and volumes.
#
#   NATSUMI_CHECK_PROJECT=natsumi-check NATSUMI_CHECK_OVERRIDE=path/to/override.yaml scripts/check-memory-shell-sandbox.sh
#
# The override must give both services image names of their own (never the :local tags a deployment uses) and the
# images must already be built with it. The script starts natsumi and natsumi-tools under its own project name with a
# throwaway self-signed certificate and fictional memory, sends commands to the runner from inside natsumi (the path
# the model's tool uses), prints PASS or FAIL per check, and removes the project's containers and volumes at the end.
# Since ADR 0018 the memory working tree is writable, so the checks measure what may be written and what may not:
# memory yes, .git no.
# Nothing here reaches outside the host.
set -euo pipefail

project="${NATSUMI_CHECK_PROJECT:?set NATSUMI_CHECK_PROJECT to a project name used only for this check}"
override="${NATSUMI_CHECK_OVERRIDE:?set NATSUMI_CHECK_OVERRIDE to a compose file that renames the images}"
[ "$project" != natsumi ] || { echo "refusing the project name natsumi" >&2; exit 2; }
command -v openssl >/dev/null || { echo "openssl is required for the throwaway certificate" >&2; exit 2; }

cd "$(dirname "$0")/.."
work="$(mktemp -d "$PWD/.local/memory-shell-check.XXXXXX")"
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

"${compose[@]}" up -d --no-build --wait --wait-timeout 180 natsumi natsumi-tools >/dev/null

# Fictional memory, written into the repository natsumi made on its first start.
"${compose[@]}" exec -T natsumi node -e '
  const { writeFileSync } = require("node:fs");
  writeFileSync("/data/memory/合言葉.md", "# 合言葉\n\n- 2026-01-01: 合言葉は SYNTHETIC-HERON-208\n", { mode: 0o600 });'

failures=0
report() { if [ "$2" = pass ]; then echo "PASS $1"; else echo "FAIL $1: $3"; failures=$((failures + 1)); fi; }

# Sends a command to the runner from inside natsumi and judges the raw answer `r` with a JavaScript expression.
probe='
import { createConnection } from "node:net";
const [command, predicate] = process.argv.slice(1);
const socket = createConnection("/run/natsumi-tools/runner.sock");
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

inspect() { docker inspect -f "$1" "$("${compose[@]}" ps -q natsumi-tools)"; }
host_check() {
  local name="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then report "$name" pass; else report "$name" fail "got [$actual], want [$expected]"; fi
}

host_check "network mode is none" "$(inspect '{{.HostConfig.NetworkMode}}')" none
host_check "root filesystem is read-only" "$(inspect '{{.HostConfig.ReadonlyRootfs}}')" true
host_check "every capability is dropped" "$(inspect '{{json .HostConfig.CapDrop}}')" '["ALL"]'
host_check "no-new-privileges is set" "$(inspect '{{json .HostConfig.SecurityOpt}}')" '["no-new-privileges:true"]'
host_check "pids are limited" "$(inspect '{{.HostConfig.PidsLimit}}')" 64
host_check "memory is limited" "$(inspect '{{.HostConfig.Memory}}')" 268435456
host_check "cpu is limited" "$(inspect '{{.HostConfig.NanoCpus}}')" 1000000000
host_check "only memory (writable), its .git (read-only) and the socket are mounted" \
  "$(inspect '{{range .Mounts}}{{.Destination}}:{{.RW}} {{end}}' | tr ' ' '\n' | sed '/^$/d' | sort | tr '\n' ' ')" \
  "/memory/.git:false /memory:true /run/natsumi-tools:true "
host_check "no environment beyond PATH" "$(inspect '{{range .Config.Env}}{{.}} {{end}}' | tr ' ' '\n' | sed '/^$/d;s/=.*//' | sort | tr '\n' ' ')" "PATH "

check "commands run as a non-root user" 'grep "^Uid:" /proc/self/status' '/^Uid:\s+[1-9]\d*\s/.test(r.stdout)'
check "no effective capabilities and no new privileges" 'grep -E "^(CapEff|NoNewPrivs):" /proc/self/status' \
  '/CapEff:\s+0{16}/.test(r.stdout) && /NoNewPrivs:\s+1/.test(r.stdout)'
check "only the loopback interface exists" 'ls /sys/class/net' 'r.stdout === "lo\n"'
check "commands see no environment but PATH and PWD" 'cat /proc/self/environ' \
  'r.stdout.split("\0").filter(Boolean).map(v => v.split("=")[0]).sort().join(",") === "PATH,PWD"'
check "installed commands are exactly the list" 'ls /bin' \
  "r.stdout.trim().split('\\n').sort().join(',') === '$(grep -v '^#' docker/tools-commands.txt | sed '/^$/d' | sort | paste -sd, -)'"
# What the image carries. /sbin/docker-init (init: true) and /.dockerenv are put in by Docker, not by the image;
# /memory is the owner's data (git leaves executable hook samples in .git), and nothing there is on PATH.
check "no other executables outside the libraries" \
  'find / \( -path /proc -o -path /sys -o -path /dev -o -path /memory \) -prune -o -type f -perm -u+x -print' \
  'r.stdout.trim().split("\n").filter(p => !p.startsWith("/bin/") && !/^\/(lib|lib64|usr\/lib)\//.test(p)).sort().join(",") === "/.dockerenv,/sbin/docker-init,/usr/libexec/natsumi-tools-runner"'
check "secrets, SQLite, Pi state and config are not visible" \
  'ls /run/secrets /data /var/lib/natsumi-pi /etc/natsumi 2>&1; find / \( -path /proc -o -path /sys \) -prune -o \( -name "*.sqlite*" -o -name auth.json -o -name "*.jsonl" -o -name "*secret*" -o -name "*.pem" \) -print' \
  'r.exitCode === 0 && !/^\//m.test(r.stdout) && (r.stdout.match(/No such file/g) || []).length === 4'
check "memory is readable" 'rg -n 合言葉' 'r.exitCode === 0 && r.stdout.includes("SYNTHETIC-HERON-208")'
# What ADR 0018 opened up: a file can be made, rewritten in place, moved, copied and removed, and a folder made.
check "memory is writable" \
  'printf "# 予定\n\n- 2026-01-01: 歯医者は金曜\n" > 予定.md && sed -i "s/金曜/土曜/" 予定.md && mkdir -p 仕事 \
   && cp 予定.md 仕事/写し.md && mv 予定.md 仕事/予定.md && rm 仕事/写し.md && cat 仕事/予定.md && ls 仕事' \
  'r.exitCode === 0 && r.stdout.includes("歯医者は土曜") && !r.stdout.includes("写し")'
check "the history is not writable" \
  'echo x > /memory/.git/HEAD; rm -rf /memory/.git; echo y > /memory/.git/objects/x' \
  'r.exitCode !== 0 && /Read-only file system/.test(r.stderr) && /Read-only file system|Device or resource busy|Permission denied/.test(r.stderr)'
check "the history is still whole afterwards" 'cat /memory/.git/HEAD; ls /memory/.git' \
  'r.exitCode === 0 && /ref:/.test(r.stdout) && r.stdout.includes("objects")'
check "root is not writable" 'echo x > /bin/x; echo x > /x' 'r.exitCode !== 0 && (r.stderr.match(/Read-only file system/g) || []).length === 2'
# One command may be 8000 characters (ADR 0018); in Japanese that is three bytes each, past the old request limit.
long="$(awk 'BEGIN { while (i++ < 7000) printf "あ" }')"
check "a command of thousands of Japanese characters arrives whole" \
  "printf '%s' '$long' > 長い.md; wc -c < 長い.md" \
  'r.exitCode === 0 && Number(r.stdout.trim()) === 21000'
check "the socket directory cannot be changed" 'echo x > /run/natsumi-tools/x; find /run/natsumi-tools -delete' \
  'r.exitCode !== 0 && /Permission denied/.test(r.stderr)'
check "only the small /tmp is writable" 'echo ok > /tmp/t && cat /tmp/t' 'r.exitCode === 0 && r.stdout === "ok\n"'
check "the time limit stops a command" 'echo before; tail -f /dev/null' 'r.timedOut === true && r.exitCode === null && r.stdout === "before\n"'
check "the pids limit stops a fork loop" 'i=0; while [ $i -lt 200 ]; do tail -f /dev/null & i=$((i+1)); done; wait' \
  '/Cannot fork/.test(r.stderr)'
check "nothing a command started is left running" 'ls /proc' \
  'r.stdout.split("\n").filter(name => /^\d+$/.test(name)).length <= 4'
check "output is cut at the limit" 'cat /bin/rg' 'r.stdoutTruncated === true && Buffer.byteLength(r.stdout) <= 65536 * 3'
check "the runner still answers afterwards" ':' 'r.exitCode === 0'

# The same path the tool takes, including the text the model reads.
read -r verdict detail < <("${compose[@]}" exec -T natsumi node --input-type=module -e '
  import { MemoryShell } from "/app/dist/src/server/memory-shell.js";
  const outcome = await new MemoryShell({ socketPath: "/run/natsumi-tools/runner.sock" }).run("rg -n 合言葉");
  console.log(outcome.ok && /終了コード 0/.test(outcome.text) && outcome.text.includes("SYNTHETIC-HERON-208") ? "pass" : "fail", JSON.stringify(outcome));')
report "the tool reads the memory through the runner" "$verdict" "$detail"

# What the server does with what the shell wrote: check, commit, and put back what fails (ADR 0018).
read -r verdict detail < <("${compose[@]}" exec -T natsumi node --input-type=module -e '
  import { MemoryShell } from "/app/dist/src/server/memory-shell.js";
  import { MemoryRepository } from "/app/dist/src/server/memory-repository.js";
  const shell = new MemoryShell({ socketPath: "/run/natsumi-tools/runner.sock" });
  const repository = new MemoryRepository({ directory: "/data/memory", dataDirectory: "/data" });
  await shell.run("printf \"# 鍵\\n\\n- 2026-01-01: 玄関の鍵は郵便受け\\n\" > 鍵.md");
  await shell.run("printf \"# だめ\\n\\n这个\\n\" > だめ.md");
  const outcome = await repository.commit({ event: "mac_message" });
  const reverted = outcome.reverted.map(file => file.path).join(",");
  console.log(outcome.committed && outcome.files.includes("鍵.md") && reverted === "だめ.md" ? "pass" : "fail", JSON.stringify(outcome));')
report "the server commits what the shell wrote and puts back what fails" "$verdict" "$detail"

echo "failures: $failures"
[ "$failures" -eq 0 ]
