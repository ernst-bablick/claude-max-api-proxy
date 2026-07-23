# Claude Max API Proxy

OpenAI-compatible API proxy that wraps the Claude Code CLI.

## Build

```bash
npm run build    # Compile TypeScript
npm run dev      # Watch mode for development
```

## Service Management

The proxy runs as a systemd **user** service on port 3456 (bound to `127.0.0.1`).

**Unit location:** `~/.config/systemd/user/claude-max-proxy.service`

**Logs:** captured by the systemd journal (`StandardOutput/StandardError=journal`):

```bash
journalctl --user -u claude-max-proxy.service -f      # follow
journalctl --user -u claude-max-proxy.service -n 100  # last 100 lines
```

> Note: after editing `dist/` (e.g. `npm run build`), restart the service so it
> picks up the new build — it runs the compiled `dist/server/standalone.js`.

### Restart the service

```bash
systemctl --user restart claude-max-proxy.service
```

### Stop the service

```bash
systemctl --user stop claude-max-proxy.service
```

### Start the service

```bash
systemctl --user start claude-max-proxy.service
```

### Reload after editing the unit file

```bash
systemctl --user daemon-reload
systemctl --user restart claude-max-proxy.service
```

### Check status

```bash
systemctl --user status claude-max-proxy.service
```

## Architecture

- `src/types/claude-cli.ts` - Claude CLI JSON streaming types and type guards
- `src/types/openai.ts` - OpenAI-compatible API types
- `src/adapter/openai-to-cli.ts` - Converts OpenAI requests to CLI input
- `src/adapter/cli-to-openai.ts` - Converts CLI output to OpenAI responses
- `src/subprocess/manager.ts` - Spawns and manages Claude CLI subprocesses
- `src/server/routes.ts` - Express route handlers (streaming + non-streaming)
- `src/server/standalone.js` - Server entry point
