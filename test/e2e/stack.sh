#!/bin/bash
# Local end-to-end stack for the Book / Transcript viewer tests.
#
#   test/e2e/stack.sh up        # fixtures + ABS 2.36.1 container + web build + static server (all idempotent)
#   test/e2e/stack.sh abs       # only (re)create the ABS container, library and fixture items
#   test/e2e/stack.sh build     # only rebuild the web app (nuxt generate, incremental) into $STACK_DIR/web/dist
#   test/e2e/stack.sh serve     # (re)start the static server on :1337
#   test/e2e/stack.sh status | down
#
# Endpoints: app http://localhost:1337 , ABS http://localhost:13378 (ALLOW_CORS=1, login root / rootpass).
# Env: STACK_DIR (default /tmp/abs-e2e)  ABS_PORT (13378)  WEB_PORT (1337)  SKIP_BUILD=1 (reuse dist).
# Items created (ids written to $STACK_DIR/state.json): "Synthetic Book" (mp3 + synced epub),
#   "Synthetic Both" (mp3 + synced epub + book-contract VTT), "Vtt Only" (mp3 + VTT only, fallback path).
# The web build runs in the `abs-android-builder` image (node_modules live in the `absnm` volume) from an rsync
# copy of the repo, so the repo stays clean; .nuxt is kept in that copy, so rebuilds are incremental.
# Playwright is expected at $PW_DIR (see test/e2e/lib.mjs).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
STACK_DIR=${STACK_DIR:-/tmp/abs-e2e}
ABS_PORT=${ABS_PORT:-13378}
WEB_PORT=${WEB_PORT:-1337}
ABS_IMAGE=ghcr.io/advplyr/audiobookshelf:2.36.1
WEB=$STACK_DIR/web
mkdir -p "$STACK_DIR"

api() { curl -fsS -H "Authorization: Bearer $(cat "$STACK_DIR/token")" -H 'Content-Type: application/json' "$@"; }

fixtures() {
  local lib=$STACK_DIR/lib/"Fixture Author"
  rm -rf "$STACK_DIR/lib"
  mkdir -p "$lib/Synthetic Book" "$lib/Synthetic Both" "$lib/Vtt Only" "$STACK_DIR/fx"
  node "$REPO/test/epub/make-fixture.mjs" "$STACK_DIR/fx" --basename "Synthetic Book"
  cp "$STACK_DIR/fx/Synthetic Book.epub" "$STACK_DIR/fx/Synthetic Book.mp3" "$lib/Synthetic Book/"
  cp "$STACK_DIR/fx/fixture.json" "$STACK_DIR/fixture.json"
  cp "$STACK_DIR/fx/Synthetic Book.epub" "$lib/Synthetic Both/Synthetic Both.epub"
  cp "$STACK_DIR/fx/Synthetic Book.mp3" "$lib/Synthetic Both/Synthetic Both.mp3"
  cp "$REPO/test/fixtures/book-contract.vtt" "$lib/Synthetic Both/Synthetic Both.vtt"
  cp "$STACK_DIR/fx/Synthetic Book.mp3" "$lib/Vtt Only/Vtt Only.mp3"
  cp "$REPO/test/fixtures/book-contract.vtt" "$lib/Vtt Only/Vtt Only.vtt"
}

abs_up() {
  fixtures
  docker rm -f abs-e2e >/dev/null 2>&1 || true
  rm -rf "$STACK_DIR/config" "$STACK_DIR/meta"; mkdir -p "$STACK_DIR/config" "$STACK_DIR/meta"
  docker run -d --name abs-e2e -e ALLOW_CORS=1 -p "$ABS_PORT:80" -v "$STACK_DIR/lib:/books" -v "$STACK_DIR/config:/config" -v "$STACK_DIR/meta:/metadata" "$ABS_IMAGE" >/dev/null
  for _ in $(seq 40); do curl -fsS "localhost:$ABS_PORT/status" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS -X POST "localhost:$ABS_PORT/init" -H 'Content-Type: application/json' -d '{"newRoot":{"username":"root","password":"rootpass"}}' >/dev/null
  curl -fsS -H 'Content-Type: application/json' -H 'x-return-tokens: true' -d '{"username":"root","password":"rootpass"}' "localhost:$ABS_PORT/login" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["user"]["accessToken"])' > "$STACK_DIR/token"
  local lib
  lib=$(api -d '{"name":"E2E","folders":[{"fullPath":"/books"}],"mediaType":"book"}' "localhost:$ABS_PORT/api/libraries" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
  api -X POST "localhost:$ABS_PORT/api/libraries/$lib/scan" >/dev/null
  for _ in $(seq 60); do
    n=$(api "localhost:$ABS_PORT/api/libraries/$lib/items" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["results"]))')
    [ "$n" -ge 3 ] && break; sleep 1
  done
  api "localhost:$ABS_PORT/api/libraries/$lib/items" | python3 -c '
import json,sys
d=json.load(sys.stdin)
out={"library":sys.argv[1],"absUrl":"http://localhost:"+sys.argv[2],"items":{}}
for it in d["results"]:
    out["items"][it["relPath"].split("/")[-1]]=it["id"]
json.dump(out,open(sys.argv[3],"w"),indent=1)
print(json.dumps(out["items"]))' "$lib" "$ABS_PORT" "$STACK_DIR/state.json"
}

web_build() {
  mkdir -p "$WEB"
  rsync -a --delete --exclude .git --exclude node_modules --exclude dist --exclude .nuxt --exclude android --exclude ios --exclude test "$REPO/" "$WEB/"
  local hash; hash=$(shasum -a 256 "$REPO/package-lock.json" | cut -d' ' -f1)
  docker run --rm --platform linux/amd64 -v "$WEB:/work" -v absnm:/work/node_modules -e NODE_OPTIONS=--max-old-space-size=4096 -w /work --entrypoint bash abs-android-builder -c "
    set -euo pipefail
    if [ \"\$(cat node_modules/.lockhash 2>/dev/null)\" != $hash ] || [ ! -d node_modules/nuxt ]; then npm ci --no-audit --no-fund; echo $hash > node_modules/.lockhash; fi
    npx nuxt generate"
}

serve() {
  [ -f "$STACK_DIR/serve.pid" ] && kill "$(cat "$STACK_DIR/serve.pid")" 2>/dev/null || true
  nohup node "$HERE/serve.mjs" "$WEB/dist" "$WEB_PORT" > "$STACK_DIR/serve.log" 2>&1 &
  echo $! > "$STACK_DIR/serve.pid"
  sleep 1; curl -fsS -o /dev/null "localhost:$WEB_PORT/" && echo "web up on :$WEB_PORT"
}

case "${1:-up}" in
  up) abs_up; [ "${SKIP_BUILD:-}" = 1 ] || web_build; serve ;;
  abs) abs_up ;;
  build) web_build ;;
  serve) serve ;;
  status) docker ps --filter name=abs-e2e --format '{{.Names}} {{.Status}}'; curl -s -o /dev/null -w "web %{http_code}\n" "localhost:$WEB_PORT/" || true; cat "$STACK_DIR/state.json" 2>/dev/null ;;
  down) [ -f "$STACK_DIR/serve.pid" ] && kill "$(cat "$STACK_DIR/serve.pid")" 2>/dev/null || true; docker rm -f abs-e2e >/dev/null 2>&1 || true ;;
  *) sed -n 2,16p "$0"; exit 2 ;;
esac
