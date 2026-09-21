# Examples

All examples use dummy/local data only.

## local-web-demo

Serve the directory with any local static server, for example:

    npx http-server examples/local-web-demo -p 4173

Then navigate the MCP browser to http://127.0.0.1:4173/ and perform:

1. browser_snapshot
2. browser_type into the Name field
3. browser_select a mode
4. browser_click Submit
5. browser_assert_text for the submitted result
6. browser_screenshot before/after or screenshot diff if desired

Because the demo is loopback-only, it exercises the safe-default browser mutation path without any external account.

## Windows Notepad

Notepad is a useful semantic UIA fixture but is not implicitly allowlisted. Explicitly opt in:

    node .\scripts\install.mjs --allow-process notepad.exe

Then prefer windows_list -> windows_tree -> windows_set_value -> windows_get_value. Use desktop click/type only to exercise the coordinate fallback intentionally.

## Secret Broker

Use a dummy value only. Register a dummy secret bound to the demo origin, then use browser_secret_fill against a password input in a local fixture. Confirm that tool results contain only the secret name/length/redaction metadata and never the value.
