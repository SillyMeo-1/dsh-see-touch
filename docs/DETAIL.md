# I can see, and I can touch

I can see your screen, and I can reach your mouse and keyboard.

I look first, then move. Every move is in front of you, and pressing Esc stops me.

## Why seeing comes first

Desktop work rarely fails at the click. It fails because something moved before the click: the window was not in front yet, the dialog had not appeared, the coordinate came from the previous frame. So the first thing here is always a frame: the real desktop, per-monitor DPI aware, one image pixel equal to one physical screen pixel. Coordinate rulers are labelled with screen coordinates, so a reading does not need pixel counting.

Only then comes the hand: move, click, drag, wheel, type, keys, focus a window. When a window exposes no usable UIA tree, the frame is the answer. When it does, `controls` is much cheaper than a screenshot: `target: 3` is the centre of that control's rectangle, and the index is re-checked immediately before the click, so a changed tree fails instead of hitting the neighbour that took its place.

The step between seeing and clicking is where coordinates usually go wrong: window and region frames have an origin, and the image the model sees may be shrunk. The tools therefore accept `imageX/imageY`: the plugin applies the most recent frame's origin and scale, and you only add `imageWidth/imageHeight` when the image you see differs in size from the frame the plugin delivered.

## One call for a run, one look at the end

The cost of calling `desktop_control` step by step is not the click; it is one model round trip and one screenshot per action. `desktop_sequence` folds a run into one call:

- Steps run in order and stop at the first failure by default, so a refused focus is never followed by typing into whatever window happens to be in front.
- The whole batch shares one cancel token and one takeover ring. Esc stops the batch, not just the step that happened to be running.
- The end frame is the foreground window, not the whole desktop, and an identical frame is not attached again.
- `dryRun: true` validates and lists the plan without touching the desktop.

## You can see what I am doing

A soft ring lights the screen edge when an action starts. It is not decoration: it registers an Esc hotkey, and pressing it stops the run between two steps. The ring lingers for 3 seconds after the last action by default, long enough to see who is moving.

A small notice also appears at the top of the screen: a speech bubble sits beside the prompt plate, naming the current step, and the plate itself reads "我正在干活 [Esc] 停下". The bubble follows the action and each sequence step, so it reads as if the prompt is speaking and you never have to guess where I am in the run.

The ring never writes the cursor and installs no input hook, so it cannot make your own mouse feel laggy.

## Some keys need your nod first

`win+r`, `ctrl+shift+esc`, `alt+f4`, `shift+delete`, and focus aimed at a UAC prompt are treated as high risk in code. Even when a caller labels them low, the guard refuses; they run only with `confirm: true`, and the result carries a note that the dangerous action was confirmed.

One such step raises a whole batch to high risk, which also needs `confirm: true`.

This does not replace your judgement. It guarantees one thing: **a dangerous action cannot slip through because someone said "low risk".**

## Where frames go

The default is the OS temp folder, so your project stays clean. Switch to "current workspace" and the plugin saves under `.see-touch/` with a one-line `.gitignore` containing `*`, so git does not see it as untracked.

Either way, the oldest frames are pruned by three limits together: count, age, and total folder size. Images already sent in the conversation live in the attachment store and are unaffected.

## Engine

`auto` uses PowerShell 7 (`pwsh`) when it is installed — faster startup, UTF-8 by default — and otherwise falls back to Windows PowerShell 5.1, which every Windows machine has. If the setting asks for `pwsh` but it is missing, the plugin is still there; the first call says what to install or to switch back to `auto`.

## Known limits

- Windows only. On other systems a tool call says so instead of failing with `ENOENT`.
- The current model must accept image input.
- The UAC secure desktop cannot be captured or injected into.
- Input goes to the real foreground window. Looking before and after an action remains the most reliable habit.
- Text arrives as one paste, not per-character keystrokes.

## Disabling

Turn off "I can see, and I can touch" under Settings → Plugins, or set `include:see-touch` to `enabled: false` in the profile. All three tools disappear together; no background process stays behind.

The full configuration table and safety notes are in [README.md](README.md).
