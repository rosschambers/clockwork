#!/usr/bin/env bash
# clockwork visual harness — render a Godot project's scenario on studio's GPU and
# capture a PNG per state. Runs Godot under Xvfb + Vulkan (headless mode does NOT
# render — it forces the dummy driver — so we use a virtual X display with the real
# GPU). Proven on studio's RTX 3060, 2026-08-19.
#
# Usage (run ON studio, or via ssh from serve):
#   render-on-studio.sh <godot_project_dir> <scenario_script.gd> <out_dir>
#
# The scenario_script.gd is a game-provided SceneTree script that reaches each state
# and calls the capture helper (harness/capture_helper.gd, copied in alongside it).
# It writes <out_dir>/<step-name>.png per state and a <out_dir>/manifest.json listing
# {step, png, expect} entries for the QA agent to judge.
set -euo pipefail

PROJECT_DIR="${1:?godot project dir required}"
SCENARIO="${2:?scenario .gd required}"
OUT_DIR="${3:?out dir required}"

mkdir -p "$OUT_DIR"
export CLOCKWORK_CAPTURE_DIR="$OUT_DIR"

# xvfb-run -a picks a free display; the -screen sets a GPU-friendly size/depth.
# --rendering-driver vulkan uses the discrete GPU; forward_plus needs it.
exec nix-shell -p godot_4 xvfb-run --run "
  xvfb-run -a -s '-screen 0 1280x720x24' \
    godot --path '$PROJECT_DIR' \
      --display-driver x11 --rendering-driver vulkan \
      --script '$SCENARIO' 2>&1
"
