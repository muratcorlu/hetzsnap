# hetzsnap

A minimal CLI to spin up and tear down ephemeral [Hetzner Cloud](https://www.hetzner.com/cloud) dev servers using snapshots. Start your server in the morning, stop it at night — pay only for what you use.

**Optional:** automatically updates a Cloudflare DNS record with the server's IP on start.

> [!TIP]
> You can get €20 free credits from Hetzner Cloud by using this [referral link](https://hetzner.cloud/?ref=ndJiOX4mLKG5).

## How it works

- **`hetzsnap start`** (alias: **`up`**) — finds the latest snapshot matching your prefix and creates a server from it. If no snapshot exists yet, creates a fresh server from the base OS image. Optionally points a Cloudflare DNS record at the new IP.
- **`hetzsnap stop`** (alias: **`down`**) — shuts down the server, takes a fresh snapshot (with delete-protection enabled), disables protection on older snapshots, then deletes the server.
- **`hetzsnap status`** — shows whether a server is currently running and for how long.
- **`hetzsnap snapshots`** — lists all snapshots matching your prefix with their age and size.
- **`hetzsnap snapshots cleanup`** — deletes all snapshots except the latest, after confirmation.
- **`hetzsnap completion`** — prints a zsh completion script.

This way you always have an up-to-date snapshot and you don't pay for a server when you're not working.

## Requirements

- [Node.js](https://nodejs.org) 22+
- A [Hetzner Cloud](https://console.hetzner.cloud) account and API token
- _(Optional)_ A [Cloudflare](https://cloudflare.com) account and API token for automatic DNS

## Installation

```bash
npm install -g hetzsnap
```

Or run directly with `npx`:

```bash
npx hetzsnap init
```

## Setup

Run the interactive setup wizard:

```bash
hetzsnap init
```

This creates `~/.hetzsnap.json5` with your credentials and server configuration. The file is written with `600` permissions (owner read/write only).

## Configuration

Config is stored at `~/.hetzsnap.json5`. Example:

```json5
{
  tokens: {
    hetzner: "your-hetzner-api-token",
    cloudflare: "your-cloudflare-api-token", // optional
  },
  server: {
    name: "my-dev",
    serverType: "cpx21",       // see https://www.hetzner.com/cloud for types
    location: "fsn1",          // nbg1, fsn1, hel1, ash, hil, sin
    snapshotPrefix: "my-dev",  // snapshots must be named "<prefix>" or "<prefix>-..."
    sshKeys: ["My Key"],       // SSH key names from Hetzner Cloud Console
    baseImage: "ubuntu-24.04", // optional: base OS image used when no snapshot exists yet
  },
  // cloudflare section is only needed if you provided a cloudflare token
  cloudflare: {
    zoneId: "your-zone-id",
    recordName: "dev.example.com",
  },
}
```

### Getting your tokens

**Hetzner API token:** [Hetzner Cloud Console](https://console.hetzner.cloud) → Your Project → Security → API Tokens → Generate API Token (Read & Write)

**Cloudflare API token:** [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens) → Create Token → use the "Edit zone DNS" template, scoped to the relevant zone

**Cloudflare Zone ID:** Cloudflare Dashboard → your domain → Overview → Zone ID (right sidebar)

## Usage

```bash
# Start your dev server (from latest snapshot, or base image on first run)
hetzsnap start  # or: hetzsnap up

# Stop your dev server (snapshot → protect → delete server)
hetzsnap stop   # or: hetzsnap down

# Show whether a server is running and for how long
hetzsnap status

# List all snapshots with age and size
hetzsnap snapshots

# Delete all snapshots except the latest (asks for confirmation)
hetzsnap snapshots cleanup

# Delete all snapshots except the latest, skip confirmation
hetzsnap snapshots cleanup -y

# (Re-)run the interactive setup wizard
hetzsnap init

# Print the zsh completion script
hetzsnap completion
```

## Shell completion

hetzsnap ships with a built-in zsh completion script.

**Important:** the completion must be sourced _after_ `compinit` is called in your `~/.zshrc`. In most setups (oh-my-zsh, prezto, etc.) this is already taken care of. For a plain `~/.zshrc`, the order should be:

```zsh
autoload -Uz compinit && compinit   # must come first
source <(hetzsnap completion)
```

**Option A — source on every shell startup** (simple):

```zsh
source <(hetzsnap completion)
```

**Option B — generate once to a file** (faster shell startup):

```zsh
mkdir -p ~/.zsh/completions
hetzsnap completion > ~/.zsh/completions/_hetzsnap
```

Then add this to your `~/.zshrc` _before_ `compinit`:

```zsh
fpath=(~/.zsh/completions $fpath)
autoload -Uz compinit && compinit
```

## First run

On first `hetzsnap start`, no snapshot exists yet — hetzsnap will create a fresh server from the base OS image (`ubuntu-24.04` by default, or whatever you set as `baseImage` in the config). Set up your environment, then run `hetzsnap stop` to take the first snapshot. From that point on, every start/stop cycle uses snapshots.

## License

MIT
