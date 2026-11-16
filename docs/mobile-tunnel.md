# Optional private mobile access

First make local MCP work. Mobile access is optional and requires your own OpenAI Secure MCP Tunnel, runtime key and permitted ChatGPT workspace. Follow the current [official guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) and your installed tunnel client's help.

Platform Tunnel permissions and ChatGPT custom MCP permissions are separate. A published GitHub repository does not grant either permission or provide a shared account. The Mac must be online, awake and in the correct user session.

After obtaining the official tunnel client and your own tunnel:

```sh
apple2agent connector-configure
apple2agent connector-connect
apple2agent connector-status
```

The local setup window accepts the key. Do not paste it into chat, shell history, issue reports or client examples. Choose the smallest useful profile; `calendar` includes calendar writes where separately authorized. Verify a read-only query from the intended client before enabling write workflows.

The current connector uses the official client's managed runtime commands. Client versions must support those commands; check `tunnel-client runtimes --help`. A healthy process or successful discovery is not proof of a completed real operation.

A remote send request can be prepared, but final approval still requires the native window on the Mac. Mobile-only approval is not implemented. Messages is experimental. WeChat requires a separately configured bridge and is not included here.

The source installer does not install a login daemon or change launchd settings. Automatic recovery and reboot behavior are not part of the public alpha installation contract.
