# Scene 3: "The DAG"
# graph → st -i nav to root → vim edit → modify → restack cascade → verify at tip

Output docs/demo/scene3.gif

Require st
Require git

Set Shell "zsh"
Set FontSize 13
Set FontFamily "Menlo"
Set Width 1100
Set Height 700
Set Padding 16
Set TypingSpeed 35ms
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set BorderRadius 8

Hide
Type "source /Users/dug/Projects/sandbox/stack/docs/demo/.scene3-init.sh"
Enter
Sleep 1s
Show

# ── Beat 1: Show file on current branch (before we navigate away) ──
Sleep 300ms
Type "cat src/db/schema.ts"
Enter
Sleep 1s

# ── Beat 2: Show full expanded graph ──
Type "st graph -e"
Enter
Sleep 3s

# ── Beat 3: Interactive nav — start at tip, navigate UP to root ──
Type "st -i"
Enter
Sleep 600ms

Up
Sleep 200ms
Up
Sleep 200ms
Up
Sleep 200ms
Up
Sleep 200ms
Up
Sleep 200ms
Up
Sleep 200ms
Up
Sleep 200ms
Up
Sleep 200ms
Up
Sleep 200ms
Up
Sleep 200ms

Sleep 500ms

# Select api/1-schema — Enter checks it out
Enter
Sleep 0.5s

# ── Beat 4: Edit the root schema in vim ──
Type "vim src/db/schema.ts"
Enter
Sleep 1.5s

Type "G"
Sleep 200ms
Type "O"
Sleep 200ms
Type@80ms "  updatedAt: Date"
Sleep 600ms
Escape
Sleep 200ms
Type ":wq"
Enter
Sleep 600ms

# ── Beat 5: Amend + restack — cascades through everything ──
Type "st modify -a -m 'add updatedAt field'"
Enter
Sleep 1s

# Prompt: restack dependent "cache"? Enter = Yes
Enter
Sleep 1s

# Prompt: restack dependent "realtime"? Enter = Yes
Enter
Sleep 1s

# ── Beat 6: Jump to realtime, show status, cat to prove it cascaded ──
Type "st realtime"
Enter
Sleep 600ms

Type "st"
Enter
Sleep 2s

Type "cat src/db/schema.ts"
Enter
Sleep 4s
