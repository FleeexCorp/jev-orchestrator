#!/usr/bin/env sh
# Fake Codex CLI for tests. Behaviour is selected with FAKE_CODEX_MODE.
#   version        -> prints a version string
#   login-ok / login-none -> login status
#   ok             -> emits a successful JSONL run, creates hello.txt in -C dir
#   fail           -> emits turn.failed and exits 1
#   malformed      -> emits garbage lines then a valid completion
#   slow           -> sleeps (for timeout tests)
mode="${FAKE_CODEX_MODE:-ok}"

case "$1" in
  --version)
    echo "codex-cli 9.9.9"
    exit 0
    ;;
  login)
    if [ "$mode" = "login-none" ]; then
      echo "Not logged in"
      exit 1
    fi
    echo "Logged in using ChatGPT"
    exit 0
    ;;
  exec)
    ;;
  *)
    echo "unexpected args: $*" >&2
    exit 64
    ;;
esac

# Parse the few flags we care about.
cwd="."
last=""
while [ $# -gt 0 ]; do
  case "$1" in
    -C) cwd="$2"; shift ;;
    --output-last-message) last="$2"; shift ;;
    -) ;;
  esac
  shift
done

# The prompt arrives on stdin; record it so tests can assert on it.
prompt="$(cat)"
printf "%s" "$prompt" > "${FAKE_CODEX_PROMPT_FILE:-/dev/null}"
env > "$cwd/env.txt" 2>/dev/null || true

case "$mode" in
  slow)
    exec sleep 30
    ;;
  fail)
    echo '{"type":"thread.started","thread_id":"t-fail"}'
    echo '{"type":"turn.started"}'
    echo '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"pnpm test","exit_code":1}}'
    echo '{"type":"turn.failed","error":{"message":"tests failed"}}'
    exit 1
    ;;
  malformed)
    echo 'this is not json'
    echo '{"type":"thread.started"'
    echo '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"recovered"}}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
    [ -n "$last" ] && printf 'recovered' > "$last"
    exit 0
    ;;
  *)
    printf 'hello\n' > "$cwd/hello.txt"
    echo '{"type":"thread.started","thread_id":"t-ok"}'
    echo '{"type":"turn.started"}'
    echo '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Working."}}'
    echo "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"file_change\",\"changes\":[{\"path\":\"$cwd/hello.txt\",\"kind\":\"add\"}],\"status\":\"completed\"}}"
    echo '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"cat hello.txt","exit_code":0}}'
    echo '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Created hello.txt. Tests: none. No concerns."}}'
    echo '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":20,"reasoning_output_tokens":0}}'
    [ -n "$last" ] && printf 'Created hello.txt. Tests: none. No concerns.' > "$last"
    exit 0
    ;;
esac
