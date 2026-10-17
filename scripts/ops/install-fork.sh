#!/usr/bin/env bash
#
# Install (or update) the OmniRoute fork from source and get it running.
#
#   bash scripts/ops/install-fork.sh                     # install + production build
#   bash scripts/ops/install-fork.sh --dev               # install + dev server, no build
#   bash scripts/ops/install-fork.sh --dir ~/x --branch some/other-branch
#   bash scripts/ops/install-fork.sh --with-opencode     # + writes the OpenCode provider block
#
set -euo pipefail

REPO_URL="${OMNIROUTE_REPO_URL:-https://github.com/Kaedo17/OmniRoute.git}"
BRANCH="${OMNIROUTE_BRANCH:-fix/opencode-free-tier-keyed-lane}"
TARGET="${OMNIROUTE_DIR:-$HOME/OmniRoute}"
MODE="prod"
WITH_OPENCODE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dev)             MODE="dev" ;;
    --dir)             TARGET="${2:?--dir needs a path}"; shift ;;
    --branch)          BRANCH="${2:?--branch needs a name}"; shift ;;
    --with-opencode)   WITH_OPENCODE=1 ;;
    -h|--help)
      cat <<'EOF'
usage: install-fork.sh [--dev] [--dir PATH] [--branch NAME] [--with-opencode]

  --dev              run `npm run dev` instead of a production build
  --dir PATH         install location (default: ~/OmniRoute)
  --branch NAME      branch to install (default: fix/opencode-free-tier-keyed-lane)
  --with-opencode    also write the OmniRoute provider block into
                     ~/.config/opencode/opencode.json (backed up first)
EOF
      exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARNING: %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. Node runtime gate (mirrors engines: >=22.22.2 <23 || >=24 <27) ─────
say "Checking Node.js"
command -v node >/dev/null 2>&1 || die "Node not found — install 22.x or 24+ from https://nodejs.org"
node -e '
  const [M, m, p] = process.versions.node.split(".").map(Number);
  const ok = (M === 22 && (m > 22 || (m === 22 && p >= 2))) || (M >= 24 && M < 27);
  if (!ok) process.exit(1);
' || die "Node $(node -v) unsupported. Need >=22.22.2 <23 or >=24 <27."
echo "    node $(node -v)  ok"

command -v git >/dev/null 2>&1 || die "git not found — install it first"

# ── 2. Clone or update the branch ──────────────────────────────────────────
if [ -d "$TARGET/.git" ]; then
  say "Updating $TARGET ($BRANCH)"
  git -C "$TARGET" fetch origin "$BRANCH"
  git -C "$TARGET" checkout "$BRANCH"
  git -C "$TARGET" pull --ff-only origin "$BRANCH" 2>/dev/null \
    || warn "pull failed (local commits?); keeping current tree"
else
  say "Cloning $BRANCH -> $TARGET"
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$TARGET"
fi
cd "$TARGET"

# ── 3. .env with real secrets (idempotent — never clobbers set values) ─────
gen() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -"$2" "$1" | tr -d '\n' | tr '+/' '-_'
  else
    node -e "process.stdout.write(require('crypto').randomBytes($1).toString('$2').replace(/\+/g,'-').replace(/\//g,'_'))"
  fi
}
set_env() {
  local k="$1" v="$2"
  if grep -qE "^${k}=$" .env || grep -qE "^${k}=CHANGEME$" .env; then
    sed -i.bak -E "s|^${k}=.*$|${k}=${v}|" .env && rm -f .env.bak
  elif ! grep -qE "^${k}=" .env; then
    printf '%s=%s\n' "$k" "$v" >> .env
  fi
}
[ -f .env ] || { say "Creating .env from .env.example"; cp .env.example .env; }
say "Generating secrets (existing values are kept)"
set_env JWT_SECRET "$(gen 48 base64)"
set_env API_KEY_SECRET "$(gen 32 hex)"
set_env INITIAL_PASSWORD "$(gen 12 base64)"

# ── 4. Dependencies ────────────────────────────────────────────────────────
say "Installing dependencies (this is the slow step)"
npm install --no-audit --no-fund

# ── 5. OpenCode provider block (optional) ─────────────────────────────────
if [ "$WITH_OPENCODE" -eq 1 ]; then
  say "Adding OmniRoute provider to ~/.config/opencode/opencode.json"
  OC="${HOME}/.config/opencode/opencode.json"
  node -e '
    const fs = require("fs");
    const path = process.argv[1], cfgPath = process.argv[2];
    const env = Object.fromEntries(
      fs.readFileSync(cfgPath, "utf8").split("\n")
        .filter((l) => /^[A-Za-z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")])
    );
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch { /* fresh file */ }
    if (cfg.omniroute === undefined) cfg.omniroute = {};
    cfg.omniroute = {
      npm: "@ai-sdk/openai-compatible",
      name: "OmniRoute",
      options: {
        baseURL: "http://127.0.0.1:20128/v1",
        apiKey: env.OMNIROUTE_API_KEY || "",
      },
      models: { "provider/model-id": { name: "provider/model-id" } },
    };
    fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
    console.log("    wrote " + path + " (key: " + (env.OMNIROUTE_API_KEY ? "from .env" : "EMPTY — set it in Dashboard -> Endpoints") + ")");
  ' "$OC" "$TARGET/.env"
  warn "the model list above is a placeholder — paste your chosen models into $OC"
fi

# ── 6. Build & hand off ───────────────────────────────────────────────────
if [ "$MODE" = "dev" ]; then
  say "Starting the dev server (Ctrl+C to stop)"
  npm run dev
  exit 0
fi

say "Building for production (a few minutes)"
npm run build

PASS="$(grep -E '^INITIAL_PASSWORD=' .env | cut -d= -f2-)"
printf '\n\033[1;32mInstall complete.\033[0m\n'
cat <<EOF

  Start:      cd "$TARGET" && npm start
  Dashboard:  http://localhost:20128
  Login:      admin / ${PASS}      (change it after first login)
  API base:   http://localhost:20128/v1
  Data dir:   \${DATA_DIR:-\$HOME/.omniroute}

  Get an API key:  Dashboard -> Endpoints, then:
    curl http://localhost:20128/v1/models -H "Authorization: Bearer YOUR_KEY"

  Exposing to other devices? Set REQUIRE_API_KEY=true in .env first.
  With it false and the server on 0.0.0.0, anyone on the network can
  spend your provider quota.
EOF
