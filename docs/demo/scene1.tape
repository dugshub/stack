# Scene 1: "The Hook"
# Shows: stack existing branches → submit → graph
# No plumbing — branches pre-created by setup script

Output docs/demo/scene1.gif

Require st
Require git

Set Shell "zsh"
Set FontSize 15
Set FontFamily "Menlo"
Set Width 900
Set Height 500
Set Padding 16
Set TypingSpeed 35ms
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set BorderRadius 8

# Hidden setup: cd to project
Hide
Type "cd /Users/dug/Projects/sandbox/todo && clear"
Enter
Sleep 500ms
Show

# Beat 1: Stack existing branches in one command
Sleep 500ms
Type "st create backend backend/1-schema backend/2-api backend/3-auth"
Enter
Sleep 3s

# Beat 2: Submit — push + create PRs
Type "st submit"
Enter
Sleep 10s

# Beat 3: See the graph
Type "st graph"
Enter
Sleep 4s
