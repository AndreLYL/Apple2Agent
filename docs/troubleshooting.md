# Troubleshooting

- **NOT_CONFIGURED**: run setup on your own Mac and check the data directory used by the actual MCP process. Never borrow another user's config.
- **Permission denied**: inspect selected resources and macOS permissions for the actual host. Do not solve it by granting all resources or disabling checks.
- **Tools missing after setup**: reconnect the MCP session so it loads changed grants/profile.
- **Native helper unavailable**: install Xcode Command Line Tools and run the build. Confirm `bin` contains the generated app bundles. Downloading only JavaScript is insufficient.
- **Authorization changes after rebuild**: ad-hoc identity may require reauthorization; see the privacy guide.
- **Mail protocol login fails**: configure the provider's app-password route where supported. Mac Mail login does not supply Apple2Agent with a password. OAuth-only providers need a future adapter.
- **Reminder exists but no banner appears**: read back the saved alarm, then check device notification settings, Focus modes and notification routing. A saved alarm is not delivery proof.
- **Tunnel unavailable**: verify your workspace/organization association, required permissions, client version and Mac availability. Do not post the runtime key or raw configuration.
- **Unknown send outcome**: inspect the existing action receipt and provider state. Never resend with a new request ID to force a success response.
- **Installing from ZIP fails**: the current installer expects a clean Git checkout and a commit. Use Git clone.

Reports should include version, macOS version, architecture, error code and a minimal synthetic reproduction. See SECURITY.md for sensitive issues.
