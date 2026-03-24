# Scene 2: "Build as you go"
# Shows: create stack → work → insert → work → submit → graph
# File writes hidden, only st commands + git commit visible

Output docs/demo/scene2.gif

Require st
Require git

Set Shell "zsh"
Set FontSize 15
Set FontFamily "Menlo"
Set Width 900
Set Height 550
Set Padding 16
Set TypingSpeed 35ms
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set BorderRadius 8

# Hidden: cd to project
Hide
Type "cd /Users/dug/Projects/sandbox/todo && clear"
Enter
Sleep 500ms
Show

# Beat 1: Create a stack with first branch
Sleep 500ms
Type "st create backend -d schema"
Enter
Sleep 2.5s

# Simulate working + committing
Hide
Type "mkdir -p src/db && echo 'export const schema = { users: {}, posts: {} }' > src/db/schema.ts && git add -A &>/dev/null"
Enter
Sleep 500ms
Show
Type "git commit -m 'add database schema'"
Enter
Sleep 1.5s

# Beat 2: Add second branch
Type "st insert --after 1 -d api"
Enter
Sleep 2s

# Simulate working + committing
Hide
Type "git checkout backend/2-api &>/dev/null && mkdir -p src/api && echo 'export const routes = { get: handler, post: handler }' > src/api/routes.ts && git add -A &>/dev/null"
Enter
Sleep 500ms
Show
Type "git commit -m 'add api routes'"
Enter
Sleep 1.5s

# Beat 3: Add third branch
Type "st insert --after 2 -d auth"
Enter
Sleep 2s

# Simulate working + committing
Hide
Type "git checkout backend/3-auth &>/dev/null && mkdir -p src/middleware && echo 'export const auth = (req, next) => verify(req.token)' > src/middleware/auth.ts && git add -A &>/dev/null"
Enter
Sleep 500ms
Show
Type "git commit -m 'add auth middleware'"
Enter
Sleep 1.5s

# Beat 4: Submit
Sleep 300ms
Type "st submit"
Enter
Sleep 10s

# Beat 5: Graph
Sleep 300ms
Type "st graph"
Enter
Sleep 4s
