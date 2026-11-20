# Publishing workflow

This is an execution workflow for already configured destinations. Routine publishing does not require source changes or development tests.

1. Use the platform, content and destination specified by the account owner. Obtain any essential missing content or destination before sending.
2. Prepare an immutable local draft with the expected account or channel and one optional PNG/JPEG snapshot.
3. Generate a fresh request ID for the new publication, then call the appropriate publisher exactly once.
4. Return the verified post URL on success.

The existing MCP tools are `x_*`, `youtube_*` and `discord_*`. CLI equivalents are listed by `node src/cli.js help`. Publishing performs built-in destination checks.

Reuse the same request ID to retrieve an earlier result. If a submission is uncertain, do not create a replacement draft or send it again. When the existing post ID is known, the platform's `get_operation` tool with `verify: true`, or `node src/cli.js verify --request-id ID`, reads the existing post without publishing.

Use the isolated browser profile for routine X and YouTube actions. Discord uses its configured incoming webhook. Keep local credentials, cookies, account configuration and operation records outside version control.

Reddit publishing is not available in this snapshot. The next step is approved official access and local account authorization before implementing and testing a Reddit publisher. Do not bypass platform security checks.
