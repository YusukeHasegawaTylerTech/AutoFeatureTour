# AutoFeatureTour

Turns a user story into a narrated video tour of a web app.

You give it a story (or just a URL). It writes an editable script, checks every step against the live app, then
records the app in a browser, paced to a spoken narration, and saves an `.mp4` with captions. If a step fails, it
stops and tells you why instead of recording a broken video.

## Setup

Windows: double-click **`install.cmd`**, then open a new terminal and run:

```
aft doctor
```

Elsewhere: install Node 22+ and ffmpeg, then `npm ci && npx playwright install chromium --with-deps && npm link`.

## Use it with Claude

Open this folder in [Claude Code](https://claude.com/claude-code) and ask for what you want in plain words. Claude
reads [AGENTS.md](AGENTS.md), which tells it how to run the tool, fix failing steps and report real app problems.

For example:

> Set up a platform for my app at http://localhost:3000 and make a smoke tour.

> Make a video of the story in examples/stories/TODO-202.md.

> The last run failed. Fix the script and run it again.

> Turn findings.md into a narrated slide deck.

Claude can also write the script for you directly from the command line (needs Claude Code signed in):

```
aft all --story examples/stories/TODO-202.md --platform todomvc --llm claude
```

The video lands in `out/<story>/<run>/`.

## Learn more

- `aft --help` lists every command.
- [AGENTS.md](AGENTS.md) is the full guide: tour files, steps, platforms, failures, captions, slides.
- `aft ui` opens a local web UI.
