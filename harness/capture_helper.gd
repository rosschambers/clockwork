# clockwork visual harness — reusable capture helper (game-agnostic).
#
# A game's scenario script (a SceneTree script) builds/reaches a state, then calls
# `await Capture.grab(self, "step-name", "expected description")`. The helper waits
# for the render to settle, saves <CLOCKWORK_CAPTURE_DIR>/<step-name>.png, and appends
# a manifest entry. At the end the scenario calls `Capture.finish()` to write
# manifest.json (the QA agent reads it: {step, png, expect} per state).
#
# Usage in a scenario script:
#   const Capture = preload("res://harness/capture_helper.gd")
#   func _init():
#       # ... build scene / reach state ...
#       await Capture.grab(self, "main-menu", "title screen with a Start button")
#       # ... advance to next state ...
#       await Capture.grab(self, "first-room", "one prism, one beam, one target")
#       Capture.finish()
#       quit()
class_name Capture
extends RefCounted

static var _entries: Array = []


static func _out_dir() -> String:
	var dir := OS.get_environment("CLOCKWORK_CAPTURE_DIR")
	if dir == "":
		dir = "/tmp/clockwork-capture"
	DirAccess.make_dir_recursive_absolute(dir)
	return dir


# Wait for the render to actually settle (a few frames) then save the viewport.
static func grab(tree: SceneTree, step_name: String, expect: String) -> void:
	# Let the GPU render the current state — one frame is often not enough for
	# lighting/shadows to settle, so wait a handful.
	for _i in range(4):
		await tree.process_frame
	var image: Image = tree.get_root().get_texture().get_image()
	var png_path := "%s/%s.png" % [_out_dir(), step_name]
	image.save_png(png_path)
	_entries.append({ "step": step_name, "png": png_path, "expect": expect })
	print("CAPTURED %s -> %s" % [step_name, png_path])


static func finish() -> void:
	var manifest_path := "%s/manifest.json" % _out_dir()
	var file := FileAccess.open(manifest_path, FileAccess.WRITE)
	file.store_string(JSON.stringify({ "captures": _entries }, "\t"))
	file.close()
	print("MANIFEST %s (%d captures)" % [manifest_path, _entries.size()])
