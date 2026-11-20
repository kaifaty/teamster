# Teamster for Sov

This read-only MCP adapter serves `list_tasks` and `get_task` over stdio on the Mac
that runs Board. It reads External Duty API v1 on loopback. Task cards show the Board
repository name, state, phase and turn, a short
result or goal, a question or blocker, check outcomes and a GitHub PR link when present.
Check commands, detailed output, account names and worktree paths stay on the Mac.
Card text is limited to its first line. The adapter removes the Board token, redacts
paths and URLs, and suppresses text with recognizable credentials. Arbitrary unlabeled
secrets in task prose may be indistinguishable from ordinary text.
[External Duty API v1](../../src/teamster/docs/external-duty.md)

## Run on the Mac

Use uv and Board with External Duty v1 enabled. Pass the path
of Board's existing External Duty JSON file. The file must be private (for example, mode
`0600`) and list exactly one canonical checkout in `repositories`. Keep it outside
the repository. The bearer stays in that file and the local Board HTTP request.
[uv documentation](https://docs.astral.sh/uv/)

```sh
uv run --script plugins/teamster-sov/server.py /path/to/private/external-duty.json
```

The Board address is `127.0.0.1:8787`. Use `--board-port PORT` if the local Board uses a
different port. An empty `tasks` list is a successful read. If Board is unreachable,
the adapter returns a tool error and makes no claim about task state.

## Connect and disconnect

Use Secure MCP Tunnel with the target ChatGPT workspace association, a restricted runtime key with Tunnels
Read + Use, and `tunnel-client` on the Mac. Supply `CONTROL_PLANE_API_KEY` from your
local secret store. Use absolute paths in the stdio command.
[Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#connect-from-chatgpt)

```sh
tunnel-client init --sample sample_mcp_stdio_local --profile teamster-sov \
  --tunnel-id "$TEAMSTER_SOV_TUNNEL_ID" \
  --mcp-command '/path/to/uv run --script /path/to/teamster/plugins/teamster-sov/server.py /path/to/private/external-duty.json'
tunnel-client doctor --profile teamster-sov --explain
tunnel-client run --profile teamster-sov
```

In ChatGPT, use **Plugins → + → Add custom MCP server → Tunnel**. Select the restricted
tunnel for the intended workspace. The stdio adapter uses **No authentication** at the
MCP layer. Its Board credential is supplied locally. In the personal Sov chat, ask it
to call `list_tasks` and compare a returned card with Board. Verify the actual tool call
in that chat before treating the pilot as accepted.

To disconnect immediately, stop the `tunnel-client run` process with Ctrl+C. Remove
the custom plugin in ChatGPT to clear the connection.

## Tests

```sh
uv run --no-project --with mcp==1.30.0 python plugins/teamster-sov/test_server.py
```
